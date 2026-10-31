"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Eye, FileText, UserMinus, X } from "lucide-react";
import Link from "next/link";
import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import StudentAnswerVisibilityControl from "@/components/tests/StudentAnswerVisibilityControl";
import { answerVisibilityLabel } from "@/components/tests/answer-visibility-label";
import { formatShortDate, formatShortDateTime, formatDateTime } from "@/lib/datetime";
import type { StudentAnswerMode, VisibilitySource } from "@/lib/answer-visibility";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  ExpandToggle,
  RowActionsMenu,
  TwoLineCell,
  TruncatedText,
  ClampText,
} from "@/components/ui/data-table";

export interface SessionGroupModuleData {
  label: string;
  submissionId: string;
  correct: number;
  total: number;
  percentage: number | null;
}

export interface VisibilityRowData {
  isControlRow: boolean;
  initialMode: StudentAnswerMode;
  initialShowExplanations: boolean;
  effectiveAnswers: boolean;
  effectiveExplanations: boolean;
  effectiveSource: VisibilitySource;
  updatedBy: string | null;
  updatedAt: string | null;
  updaterName: string | null;
}

export type TestRowStatus = "Not started" | "In progress" | "Submitted" | "Late";

export interface TestRow {
  key: string;
  testId: string;
  testName: string;
  section: string | null;
  status: TestRowStatus;
  /** In progress only: module the student is on, e.g. 1 of 2. */
  currentModule: number | null;
  moduleCount: number;
  correct: number;
  total: number;
  percentage: number | null;
  scaledScore: number | null;
  timeSeconds: number;
  submittedAt: string | null;
  attemptNumber: number | null;
  /** Null when the student has no submission for this row. */
  detailSubmissionId: string | null;
  isMultiModule: boolean;
  modules: SessionGroupModuleData[];
  /** Two-module tests: each module's full name, e.g. {label:"M1", name:"…Module 1"}. */
  moduleNames: { label: string; name: string }[];
  visibility: VisibilityRowData | null;
  /** Currently assigned individually. */
  assignedDirect: boolean;
  /** Class names it's currently assigned through. */
  assignedClasses: string[];
  assignedAt: string | null;
  dueDate: string | null;
  /** Not started, individually assigned only (no class): safe to unassign. */
  removable: boolean;
}

const STATUS_STYLES: Record<TestRowStatus, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In progress": "bg-warm-coral/15 text-warm-coral-text",
  "Not started": "bg-light-bg text-mid-gray",
};

const STATUS_KEY: Record<TestRowStatus, string> = {
  Submitted: "statusSubmitted",
  Late: "statusLate",
  "In progress": "statusInProgress",
  "Not started": "statusNotStarted",
};

function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function sectionShort(section: string | null): string | null {
  if (!section) return null;
  if (section === "Reading & Writing") return "R&W";
  return section;
}

/** "Visible (student override)" plus "Changed by … · date" when overridden. */
function useVisibilityText(vis: VisibilityRowData) {
  const tv = useTranslations("answerVisibility");
  const label = answerVisibilityLabel(tv, {
    answers: vis.effectiveAnswers,
    explanations: vis.effectiveExplanations,
    source: vis.effectiveSource,
  });
  const changedBy =
    vis.updatedBy && vis.updatedAt
      ? tv("changedBy", { name: vis.updaterName ?? "—", date: formatDateTime(vis.updatedAt) })
      : null;
  return { label, changedBy };
}

// One line: coloured dot (green = visible, grey = hidden) + the short picker.
// The effective state and who changed it are in the hover tooltip and the
// expanded row, so the cell never grows taller than the picker.
function VisibilityCell({
  testId,
  studentId,
  vis,
}: {
  testId: string;
  studentId: string;
  vis: VisibilityRowData;
}) {
  const tv = useTranslations("answerVisibility");
  const { label, changedBy } = useVisibilityText(vis);
  return (
    <div
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
      title={changedBy ? `${label}\n${changedBy}` : label}
    >
      <span
        aria-label={label}
        className={clsx(
          "w-2 h-2 rounded-full flex-shrink-0",
          vis.effectiveAnswers ? "bg-status-success" : "bg-soft-mute",
        )}
      />
      {vis.isControlRow ? (
        <StudentAnswerVisibilityControl
          compact
          testId={testId}
          studentId={studentId}
          initialMode={vis.initialMode}
          initialShowExplanations={vis.initialShowExplanations}
        />
      ) : (
        <span className="text-[11px] text-soft-mute">
          {vis.effectiveAnswers ? tv("visible") : tv("hidden")}
        </span>
      )}
    </div>
  );
}

function VisibilityDetail({ vis }: { vis: VisibilityRowData }) {
  const { label, changedBy } = useVisibilityText(vis);
  return <>{changedBy ? `${label} · ${changedBy}` : label}</>;
}

function RemoveAssignmentDialog({
  row,
  studentId,
  studentName,
  onClose,
}: {
  row: TestRow;
  studentId: string;
  studentName: string;
  onClose: () => void;
}) {
  const t = useTranslations("studentDetail");
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tests/${row.testId}/remove-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Server refuses (409) if the student has any submission.
        body: JSON.stringify({ studentIds: [studentId], onlyIfNotStarted: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? t("removeFailed"));
        return;
      }
      onClose();
      startTransition(() => router.refresh());
    } catch {
      setError(t("removeFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div role="dialog" aria-modal="true" className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-divider">
          <h2 className="font-bold text-charcoal text-lg">{t("removeTitle")}</h2>
          <button onClick={onClose} className="text-soft-mute hover:text-charcoal" aria-label={t("cancel")}>
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-3 text-sm text-charcoal">
          <p>{t("removeBody", { name: studentName, test: row.testName })}</p>
          {error && <p className="text-status-error text-xs">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 p-5 border-t border-divider">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-soft-mute hover:text-charcoal">
            {t("cancel")}
          </button>
          <button
            onClick={confirm}
            disabled={submitting}
            className="px-4 py-2 rounded-xl bg-status-error hover:opacity-90 text-white font-semibold text-sm disabled:opacity-50"
          >
            {submitting ? t("removing") : t("removeAssignment")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TestsTable({
  rows,
  studentId,
  studentName,
}: {
  rows: TestRow[];
  studentId: string;
  studentName: string;
}) {
  const t = useTranslations("studentDetail");
  const tv = useTranslations("answerVisibility");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<TestRow | null>(null);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (rows.length === 0) {
    return (
      <p className="py-12 text-center text-soft-mute text-sm">
        {t("noTests")}
      </p>
    );
  }

  const COLS = 8;
  // Wider than the default main column so full test names fit on 1–2 lines.
  const TEST_COL = "w-[42%] min-w-[15rem]";

  return (
    <>
    <DataTable>
      <thead>
        <HeadRow>
          <Th kind="main" sticky="left" className={TEST_COL}>{t("colTest")}</Th>
          <Th>{t("colStatus")}</Th>
          <Th kind="long" priority="xl" className="w-[14%]">{t("colAssignedVia")}</Th>
          <Th priority="md">{t("colDates")}</Th>
          <Th>{t("colResult")}</Th>
          <Th priority="md">{t("colSubmitted")}</Th>
          <Th priority="xl">{tv("column")}</Th>
          <Th kind="actions" sticky="right"><span className="sr-only">{t("actions")}</span></Th>
        </HeadRow>
      </thead>
      <tbody>
        {rows.map((g) => {
          const isExpanded = expanded.has(g.key);
          const canExpand = g.isMultiModule && g.modules.length > 0;
          const submittedLabel = g.submittedAt ? formatShortDate(g.submittedAt) : null;
          const submittedTitle = g.submittedAt ? formatShortDateTime(g.submittedAt) : undefined;
          const assignedVia = [
            ...(g.assignedDirect ? [t("individually")] : []),
            ...g.assignedClasses,
          ].join(", ") || t("notAssigned");
          // No due date: show just the assigned date, not "Due —".
          const dueText = g.dueDate ? `${t("due")} ${formatShortDate(g.dueDate)}` : null;
          const assignedText = `${t("assigned")} ${g.assignedAt ? formatShortDate(g.assignedAt) : "—"}`;
          const sectionLabel = sectionShort(g.section);
          const isDone = g.status === "Submitted" || g.status === "Late";

          return (
            <Fragment key={g.key}>
              <DataRow
                colSpan={COLS}
                expandBelow="xl"
                details={
                  <>
                    <DetailItem label={t("colAssignedVia")} priority="xl">{assignedVia}</DetailItem>
                    <DetailItem label={t("colDates")} priority="md">
                      {dueText ? `${dueText} · ${assignedText}` : assignedText}
                    </DetailItem>
                    <DetailItem label={t("colSubmitted")} priority="md">
                      {submittedTitle ? `${submittedTitle} · ${formatDuration(g.timeSeconds)}` : "—"}
                    </DetailItem>
                    {g.visibility && (
                      <DetailItem label={tv("column")} priority="xl">
                        <div className="space-y-1">
                          <VisibilityCell testId={g.testId} studentId={studentId} vis={g.visibility} />
                          <div className="text-xs text-soft-mute">
                            <VisibilityDetail vis={g.visibility} />
                          </div>
                        </div>
                      </DetailItem>
                    )}
                  </>
                }
              >
                {/* Test */}
                <Td kind="main" sticky="left" className={TEST_COL}>
                  <div className="flex items-start gap-1">
                    {canExpand ? (
                      <button
                        type="button"
                        onClick={() => toggle(g.key)}
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? t("collapseModules")
                            : t("expandModules")
                        }
                        className="mt-0.5 flex-shrink-0 text-soft-mute hover:text-charcoal transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </button>
                    ) : (
                      <span className="inline-block w-[14px] flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/admin/tests/${g.testId}`}
                        className="block min-w-0 hover:text-warm-coral-text transition-colors"
                      >
                        <ClampText className="font-medium text-charcoal leading-snug">
                          {g.testName}
                        </ClampText>
                      </Link>
                      {sectionLabel && (
                        <div className="mt-0.5 text-[11px] font-medium text-mid-gray">{sectionLabel}</div>
                      )}
                      {g.moduleNames.length > 1 &&
                        g.moduleNames.map((m) => (
                          <div key={m.label} className="text-[11px] text-soft-mute leading-snug break-words">
                            {m.label}: {m.name}
                          </div>
                        ))}
                    </div>
                  </div>
                </Td>
                {/* Status */}
                <Td>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={clsx(
                        "whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium",
                        STATUS_STYLES[g.status],
                      )}
                    >
                      {t(STATUS_KEY[g.status])}
                    </span>
                    {(g.attemptNumber ?? 1) > 1 && (
                      <span className="whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-medium bg-light-bg text-mid-gray border border-divider">
                        {t("attemptN", { n: String(g.attemptNumber) })}
                      </span>
                    )}
                  </div>
                  {g.status === "In progress" && g.currentModule != null && (
                    <div className="text-[11px] text-soft-mute mt-0.5 whitespace-nowrap">
                      {t("moduleOf", { n: String(g.currentModule), m: String(g.moduleCount) })}
                    </div>
                  )}
                </Td>
                {/* Assigned via */}
                <Td kind="long" priority="xl" className="w-[14%]">
                  <TruncatedText className="text-mid-gray">{assignedVia}</TruncatedText>
                </Td>
                {/* Dates */}
                <Td priority="md">
                  {dueText ? (
                    <TwoLineCell
                      main={dueText}
                      detail={assignedText}
                      mainTitle={g.dueDate ? formatDateTime(g.dueDate) : undefined}
                      detailTitle={g.assignedAt ? formatDateTime(g.assignedAt) : undefined}
                      mainClassName="text-mid-gray"
                    />
                  ) : (
                    <span
                      className="text-mid-gray whitespace-nowrap"
                      title={g.assignedAt ? formatDateTime(g.assignedAt) : undefined}
                    >
                      {assignedText}
                    </span>
                  )}
                </Td>
                {/* Result */}
                <Td>
                  {g.scaledScore != null ? (
                    <TwoLineCell
                      main={String(g.scaledScore)}
                      detail={g.total > 0 ? `${g.correct}/${g.total}${g.percentage != null ? ` · ${g.percentage.toFixed(1)}%` : ""}` : undefined}
                      mainClassName="text-base font-bold text-charcoal leading-tight"
                    />
                  ) : (
                    <span className="text-soft-mute">—</span>
                  )}
                </Td>
                {/* Submitted */}
                <Td priority="md">
                  {submittedLabel ? (
                    <TwoLineCell
                      main={submittedLabel}
                      detail={formatDuration(g.timeSeconds)}
                      mainTitle={submittedTitle}
                      mainClassName="text-mid-gray"
                    />
                  ) : (
                    <span className="text-soft-mute">—</span>
                  )}
                </Td>
                {/* Answers */}
                <Td priority="xl">
                  {g.visibility ? (
                    <VisibilityCell
                      testId={g.testId}
                      studentId={studentId}
                      vis={g.visibility}
                    />
                  ) : (
                    <span className="text-soft-mute text-xs">—</span>
                  )}
                </Td>
                {/* Actions */}
                <Td kind="actions" sticky="right">
                  <ExpandToggle label={t("moreAbout", { test: g.testName })} />
                  <RowActionsMenu
                    label={t("actionsFor", { test: g.testName })}
                    items={[
                      { label: t("openTest"), icon: FileText, href: `/admin/tests/${g.testId}` },
                      isDone && g.detailSubmissionId != null && {
                        label: t("viewDetail"),
                        icon: Eye,
                        href: `/teacher/tests/${g.testId}/results/${g.detailSubmissionId}`,
                      },
                      g.removable && {
                        label: t("removeAssignment"),
                        icon: UserMinus,
                        tone: "danger",
                        onSelect: () => setRemoving(g),
                      },
                    ]}
                  />
                </Td>
              </DataRow>
              {/* Expandable module breakdown */}
              {canExpand && isExpanded && (
                <tr className="border-b border-divider bg-light-bg/40">
                  <td colSpan={COLS} className="px-3 py-2.5">
                    <div className="ml-[22px] space-y-0.5">
                      {g.modules.map((m) => (
                        <div key={m.submissionId} className="text-xs text-mid-gray">
                          <span className="font-medium">{m.label}:</span>{" "}
                          {m.correct}/{m.total}
                          {m.percentage != null
                            ? ` (${m.percentage.toFixed(1)}%)`
                            : ""}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </DataTable>
    {removing && (
      <RemoveAssignmentDialog
        row={removing}
        studentId={studentId}
        studentName={studentName}
        onClose={() => setRemoving(null)}
      />
    )}
    </>
  );
}
