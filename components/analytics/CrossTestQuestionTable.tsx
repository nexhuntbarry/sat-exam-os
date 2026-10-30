"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { useTranslations } from "next-intl";
import MathMarkdown from "@/components/MathMarkdown";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
} from "@/components/ui/data-table";

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

  // 7 columns: rank + question + domain + attempts + error% + top wrong + action
  const COL_COUNT = 7;

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

      <DataTable>
        <thead>
          <HeadRow>
            <Th sticky="left" className="w-8">#</Th>
            <Th kind="main">{t("columns.question")}</Th>
            <Th kind="long" priority="md">{t("columns.domain")}</Th>
            <Th>{t("columns.attempts")}</Th>
            <Th>{t("columns.errorPct")}</Th>
            <Th priority="md">{t("columns.topWrong")}</Th>
            <Th kind="actions" sticky="right"><span className="sr-only">{t("columns.action")}</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {top.length === 0 && (
            <EmptyRow colSpan={COL_COUNT}>{t("noQuestionAttempts")}</EmptyRow>
          )}
          {top.map((q, idx) => {
            const subDetail = [
              q.questionNumber != null ? `Q${q.questionNumber}` : null,
              q.difficulty,
              q.testsAppearingIn.length > 1 ? t("inMultipleTests", { count: q.testsAppearingIn.length }) : null,
            ].filter(Boolean).join(" · ");

            return (
              <DataRow
                key={q.questionId}
                expandBelow="md"
                colSpan={COL_COUNT}
                details={
                  <>
                    <DetailItem label={t("columns.domain")} priority="md">{q.domain ?? "—"}</DetailItem>
                    <DetailItem label={t("columns.topWrong")} priority="md">{q.mostSelectedWrong ?? "—"}</DetailItem>
                  </>
                }
              >
                <Td sticky="left" className="text-soft-mute tabular-nums">{idx + 1}</Td>
                <Td kind="main">
                  <div className="text-charcoal text-sm line-clamp-2">
                    <MathMarkdown>{q.textPreview}</MathMarkdown>
                  </div>
                  {subDetail && (
                    <div className="text-soft-mute text-xs mt-1 whitespace-nowrap">{subDetail}</div>
                  )}
                </Td>
                <Td kind="long" priority="md" className="text-mid-gray whitespace-nowrap">
                  {q.domain ?? "—"}
                </Td>
                <Td className="text-mid-gray tabular-nums">{q.totalAttempts}</Td>
                <Td>
                  <span
                    className={clsx(
                      "font-semibold tabular-nums",
                      q.errorRatePct >= 70
                        ? "text-status-error"
                        : q.errorRatePct >= 40
                          ? "text-status-warning"
                          : "text-warm-amber"
                    )}
                  >
                    {q.errorRatePct.toFixed(0)}%
                  </span>
                </Td>
                <Td priority="md" className="text-mid-gray text-center">{q.mostSelectedWrong ?? "—"}</Td>
                <Td kind="actions" sticky="right">
                  <Link
                    href={`/teacher/tests/${q.testIdForLink}/analytics/${q.questionId}`}
                    className="text-warm-coral-text text-xs hover:underline whitespace-nowrap"
                  >
                    {t("view")}
                  </Link>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
