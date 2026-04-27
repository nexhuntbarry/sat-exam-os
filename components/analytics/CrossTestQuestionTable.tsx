"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import MathMarkdown from "@/components/MathMarkdown";

export interface CrossTestQuestionRow {
  questionId: string;
  questionNumber: number | null;
  textPreview: string;
  domain: string | null;
  difficulty: string | null;
  totalAttempts: number;
  correctCount: number;
  wrongCount: number;
  blankCount: number;
  errorRatePct: number;
  mostSelectedWrong: string | null;
  // links to first occurrence (or filtered test)
  testIdForLink: string;
  testsAppearingIn: { testId: string; testName: string }[];
}

interface Props {
  rows: CrossTestQuestionRow[];
  testOptions: { id: string; name: string }[];
}

export function CrossTestQuestionTable({ rows, testOptions }: Props) {
  const t = useTranslations("analyticsTable");
  const [testFilter, setTestFilter] = useState("all");

  const filtered = useMemo(() => {
    if (testFilter === "all") return rows;
    return rows.filter((r) => r.testsAppearingIn.some((tt) => tt.testId === testFilter));
  }, [rows, testFilter]);

  // Re-pick link target if a single test is selected
  const enriched = useMemo(() => {
    if (testFilter === "all") return filtered;
    return filtered.map((r) => ({ ...r, testIdForLink: testFilter }));
  }, [filtered, testFilter]);

  const top = useMemo(
    () => [...enriched].sort((a, b) => b.errorRatePct - a.errorRatePct).slice(0, 20),
    [enriched]
  );

  const selectCls =
    "bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <select value={testFilter} onChange={(e) => setTestFilter(e.target.value)} className={selectCls}>
          <option value="all">{t("allTests")}</option>
          {testOptions.map((tt) => (
            <option key={tt.id} value={tt.id}>
              {tt.name}
            </option>
          ))}
        </select>
        <div className="ml-auto text-soft-mute text-sm self-center">
          {t("showingTop", { top: top.length, total: enriched.length })}
        </div>
      </div>

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {top.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">
            {t("noQuestionAttempts")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium w-12">#</th>
                  <th className="text-left px-5 py-3 font-medium">{t("columns.question")}</th>
                  <th className="text-left px-5 py-3 font-medium hidden md:table-cell">{t("columns.domain")}</th>
                  <th className="text-right px-5 py-3 font-medium">{t("columns.attempts")}</th>
                  <th className="text-right px-5 py-3 font-medium">{t("columns.errorPct")}</th>
                  <th className="text-center px-5 py-3 font-medium hidden sm:table-cell">
                    {t("columns.topWrong")}
                  </th>
                  <th className="text-left px-5 py-3 font-medium">{t("columns.action")}</th>
                </tr>
              </thead>
              <tbody>
                {top.map((q, idx) => (
                  <tr
                    key={q.questionId}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors align-top"
                  >
                    <td className="px-5 py-3 text-soft-mute">{idx + 1}</td>
                    <td className="px-5 py-3 max-w-[420px]">
                      <div className="text-charcoal text-sm line-clamp-2">
                        <MathMarkdown>{q.textPreview}</MathMarkdown>
                      </div>
                      <div className="text-soft-mute text-xs mt-1">
                        {q.questionNumber != null && <span>Q{q.questionNumber}</span>}
                        {q.difficulty && <span> · {q.difficulty}</span>}
                        {q.testsAppearingIn.length > 1 && (
                          <span> · {t("inMultipleTests", { count: q.testsAppearingIn.length })}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-mid-gray hidden md:table-cell">
                      {q.domain ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-mid-gray text-right">{q.totalAttempts}</td>
                    <td className="px-5 py-3 text-right">
                      <span
                        className={clsx(
                          "font-semibold",
                          q.errorRatePct >= 70
                            ? "text-status-error"
                            : q.errorRatePct >= 40
                              ? "text-status-warning"
                              : "text-warm-amber"
                        )}
                      >
                        {q.errorRatePct.toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-5 py-3 text-center text-mid-gray hidden sm:table-cell">
                      {q.mostSelectedWrong ?? "—"}
                    </td>
                    <td className="px-5 py-3">
                      <Link
                        href={`/teacher/tests/${q.testIdForLink}/analytics/${q.questionId}`}
                        className="text-warm-coral text-xs hover:underline whitespace-nowrap"
                      >
                        {t("view")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
