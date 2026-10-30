"use client";

import { Fragment, useState } from "react";
import { ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import StudentAnswerVisibilityControl from "@/components/tests/StudentAnswerVisibilityControl";
import { answerVisibilityLabel } from "@/components/tests/answer-visibility-label";
import { formatDate, formatDateTime } from "@/lib/datetime";
import type { StudentAnswerMode, VisibilitySource } from "@/lib/answer-visibility";

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

export interface TestRow {
  key: string;
  testId: string;
  testName: string;
  section: string | null;
  status: string;
  correct: number;
  total: number;
  percentage: number | null;
  scaledScore: number | null;
  timeSeconds: number;
  submittedAt: string | null;
  attemptNumber: number | null;
  detailSubmissionId: string;
  isMultiModule: boolean;
  modules: SessionGroupModuleData[];
  visibility: VisibilityRowData | null;
}

const STATUS_STYLES: Record<string, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In Progress": "bg-warm-coral/15 text-warm-coral-text",
  "Not Started": "bg-light-bg text-mid-gray",
};

function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function sectionShort(section: string | null): string {
  if (!section) return "—";
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

export default function TestsTable({
  rows,
  studentId,
}: {
  rows: TestRow[];
  studentId: string;
}) {
  const t = useTranslations("studentDetail");
  const tv = useTranslations("answerVisibility");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-sm">
        <thead>
          <tr className="border-b border-divider text-soft-mute text-xs">
            <th className="text-left px-5 py-3 font-medium w-[32%]">{t("colTest")}</th>
            <th className="text-left px-3 py-3 font-medium w-[7%]">{t("colSection")}</th>
            <th className="text-left px-3 py-3 font-medium w-[15%]">{t("colStatus")}</th>
            <th className="text-left px-3 py-3 font-medium w-[14%]">{t("colResult")}</th>
            <th className="text-left px-3 py-3 font-medium w-[14%]">{t("colSubmitted")}</th>
            <th className="text-left px-3 py-3 font-medium w-[18%]">{tv("column")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const isExpanded = expanded.has(g.key);
            const canExpand = g.isMultiModule && g.modules.length > 0;
            return (
              <Fragment key={g.key}>
                <tr className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                  {/* Test */}
                  <td className="px-5 py-3">
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
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="font-medium text-charcoal truncate block"
                            title={g.testName}
                          >
                            {g.testName}
                          </span>
                          <Link
                            href={`/teacher/tests/${g.testId}/results/${g.detailSubmissionId}`}
                            className="flex-shrink-0 text-soft-mute hover:text-warm-coral-text transition-colors"
                            title={t("viewDetail")}
                          >
                            <ExternalLink size={11} />
                          </Link>
                        </div>
                        {g.isMultiModule && (
                          <span className="inline-block mt-0.5 px-1.5 py-0 rounded text-[10px] font-medium bg-light-bg text-mid-gray border border-divider leading-5">
                            {t("twoModules")}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  {/* Section */}
                  <td className="px-3 py-3">
                    <span className="whitespace-nowrap text-mid-gray text-xs font-medium">
                      {sectionShort(g.section)}
                    </span>
                  </td>
                  {/* Status */}
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={clsx(
                          "whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium",
                          STATUS_STYLES[g.status] ?? "bg-light-bg text-soft-mute",
                        )}
                      >
                        {g.status}
                      </span>
                      {(g.attemptNumber ?? 1) > 1 && (
                        <span className="whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-medium bg-light-bg text-mid-gray border border-divider">
                          {t("attemptN", { n: String(g.attemptNumber) })}
                        </span>
                      )}
                    </div>
                  </td>
                  {/* Result */}
                  <td className="px-3 py-3">
                    {g.scaledScore != null ? (
                      <div>
                        <div className="text-base font-bold text-charcoal leading-tight">
                          {g.scaledScore}
                        </div>
                        <div className="text-[11px] text-soft-mute mt-0.5">
                          {g.total > 0 ? `${g.correct}/${g.total}` : "—"}
                          {g.percentage != null
                            ? ` · ${g.percentage.toFixed(1)}%`
                            : ""}
                        </div>
                      </div>
                    ) : (
                      <span className="text-soft-mute">—</span>
                    )}
                  </td>
                  {/* Submitted */}
                  <td className="px-3 py-3">
                    {g.submittedAt ? (
                      <div>
                        <div className="text-mid-gray text-xs">
                          {formatDate(g.submittedAt)}
                        </div>
                        <div className="text-soft-mute text-[11px] mt-0.5">
                          {formatDuration(g.timeSeconds)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-soft-mute">—</span>
                    )}
                  </td>
                  {/* Answers */}
                  <td className="px-3 py-3 align-top">
                    {g.visibility ? (
                      <VisibilityCell
                        testId={g.testId}
                        studentId={studentId}
                        vis={g.visibility}
                      />
                    ) : (
                      <span className="text-soft-mute text-xs">—</span>
                    )}
                  </td>
                </tr>
                {/* Expandable module breakdown */}
                {canExpand && isExpanded && (
                  <tr className="border-b border-divider bg-light-bg/40">
                    <td colSpan={6} className="px-5 py-2.5">
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
      </table>
    </div>
  );
}
