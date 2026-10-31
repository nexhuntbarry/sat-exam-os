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
  const effective = {
    answers: vis.effectiveAnswers,
    explanations: vis.effectiveExplanations,
    source: vis.effectiveSource,
  };
  const label = answerVisibilityLabel(tv, effective);
  const changedByText =
    vis.updatedBy && vis.updatedAt
      ? tv("changedBy", {
          name: vis.updaterName ?? "—",
          date: formatDateTime(vis.updatedAt),
        })
      : null;

  return (
    <div className="flex items-start gap-1.5">
      <div
        className={clsx(
          "mt-1 w-2 h-2 rounded-full flex-shrink-0",
          vis.effectiveAnswers ? "bg-status-success" : "bg-soft-mute",
        )}
      />
      <div className="space-y-1 min-w-0">
        {vis.isControlRow && (
          <StudentAnswerVisibilityControl
            testId={testId}
            studentId={studentId}
            initialMode={vis.initialMode}
            initialShowExplanations={vis.initialShowExplanations}
          />
        )}
        <div className="text-[11px] text-soft-mute leading-tight">
          {label}
        </div>
        {changedByText && (
          <div className="text-[10px] text-soft-mute leading-snug">{changedByText}</div>
        )}
      </div>
    </div>
  );
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

  return (
    <>
    <DataTable>
      <thead>
        <HeadRow>
          <Th kind="main" sticky="left">{t("colTest")}</Th>
          <Th>{t("colStatus")}</Th>
          <Th kind="long" priority="lg" className="w-[14%]">{t("colAssignedVia")}</Th>
          <Th priority="md">{t("colDates")}</Th>
          <Th>{t("colResult")}</Th>
          <Th priority="md">{t("colSubmitted")}</Th>
          <Th kind="long" priority="lg" className="w-[18%]">{tv("column")}</Th>
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
          const dueText = `${t("due")} ${g.dueDate ? formatShortDate(g.dueDate) : "—"}`;
          const assignedText = `${t("assigned")} ${g.assignedAt ? formatShortDate(g.assignedAt) : "—"}`;
          const sectionLabel = sectionShort(g.section);
          const isDone = g.status === "Submitted" || g.status === "Late";

          return (
            <Fragment key={g.key}>
              <DataRow
                colSpan={COLS}
                expandBelow="lg"
                details={
                  <>
                    <DetailItem label={t("colAssignedVia")} priority="lg">{assignedVia}</DetailItem>
                    <DetailItem label={t("colDates")} priority="md">{`${dueText} · ${assignedText}`}</DetailItem>
                    <DetailItem label={t("colSubmitted")} priority="md">
                      {submittedTitle ? `${submittedTitle} · ${formatDuration(g.timeSeconds)}` : "—"}
                    </DetailItem>
                  </>
                }
              >
                {/* Test */}
                <Td kind="main" sticky="left">
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
                        <TruncatedText className="font-medium text-charcoal">
                          {g.testName}
                        </TruncatedText>
                      </Link>
                      {(sectionLabel || g.isMultiModule || g.moduleCount > 1) && (
                        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-mid-gray">
                          {sectionLabel && <span className="font-medium">{sectionLabel}</span>}
                          {(g.isMultiModule || g.moduleCount > 1) && (
                            <span className="inline-block px-1.5 py-0 rounded text-[10px] font-medium bg-light-bg text-mid-gray border border-divider leading-5">
                              {t("twoModules")}
                            </span>
                          )}
                        </div>
                      )}
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
                <Td kind="long" priority="lg" className="w-[14%]">
                  <TruncatedText className="text-mid-gray">{assignedVia}</TruncatedText>
                </Td>
                {/* Dates */}
                <Td priority="md">
                  <TwoLineCell
                    main={dueText}
                    detail={assignedText}
                    mainTitle={g.dueDate ? formatDateTime(g.dueDate) : undefined}
                    detailTitle={g.assignedAt ? formatDateTime(g.assignedAt) : undefined}
                    mainClassName="text-mid-gray"
                  />
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
                <Td kind="long" priority="lg" className="align-top">
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
