"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { ArrowUpDown, ChevronUp, ChevronDown, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { scaleSectionScore } from "@/lib/scoring";
import { formatDate, formatDateTime } from "@/lib/datetime";

export interface CrossTestResultRow {
  submissionId: string;
  testId: string;
  testName: string;
  section: string | null;
  studentId: string;
  studentName: string;
  email: string;
  classGroup: string | null;
  status: string;
  score: number | null;
  percentage: number | null;
  scaledScore: number | null;
  correctCount: number;
  totalQuestions: number;
  timeSpentSeconds: number | null;
  submittedAt: string | null;
  // Present only for two-module attempts; renders a per-module split
  // under the combined Score / Correct cells.
  modules?: {
    submissionId: string;
    label: string;
    correctCount: number;
    totalQuestions: number;
    percentage: number | null;
    scaledScore: number | null;
  }[];
}

function effectiveScaled(row: { scaledScore: number | null; percentage: number | null }): number | null {
  if (row.scaledScore != null) return row.scaledScore;
  if (row.percentage != null) return scaleSectionScore(Number(row.percentage));
  return null;
}

interface Props {
  rows: CrossTestResultRow[];
  testOptions: { id: string; name: string }[];
  classOptions: string[];
}

const statusStyles: Record<string, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In Progress": "bg-warm-coral/15 text-warm-coral",
  Expired: "bg-status-error/15 text-status-error",
};

type SortKey =
  | "studentName"
  | "testName"
  | "status"
  | "percentage"
  | "correctCount"
  | "timeSpentSeconds"
  | "submittedAt";

function fmtTime(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function CrossTestResultsTable({ rows, testOptions, classOptions }: Props) {
  const t = useTranslations("analyticsTable");
  const [testFilter, setTestFilter] = useState("all");
  const [classFilter, setClassFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("submittedAt");
  const [sortAsc, setSortAsc] = useState(false);

  const statuses = useMemo(
    () => ["all", ...Array.from(new Set(rows.map((r) => r.status)))],
    [rows]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (testFilter !== "all" && r.testId !== testFilter) return false;
      if (classFilter !== "all" && (r.classGroup ?? "—") !== classFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q) {
        if (
          !r.studentName.toLowerCase().includes(q) &&
          !r.email.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [rows, testFilter, classFilter, statusFilter, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ArrowUpDown size={12} className="text-soft-mute" />;
    return sortAsc ? (
      <ChevronUp size={12} className="text-warm-coral" />
    ) : (
      <ChevronDown size={12} className="text-warm-coral" />
    );
  }

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
        <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className={selectCls}>
          <option value="all">{t("allClasses")}</option>
          {classOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? t("allStatuses") : s}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft-mute" />
          <input
            type="text"
            placeholder={t("searchStudent")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-light-bg border border-divider rounded-lg pl-8 pr-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50 w-56"
          />
        </div>
        <div className="ml-auto text-soft-mute text-sm self-center">
          {sorted.length === 1
            ? t("rowCount", { count: sorted.length })
            : t("rowCountPlural", { count: sorted.length })}
        </div>
      </div>

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {sorted.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">
            {t("noResults")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("studentName")}>
                      {t("columns.student")} <SortIcon k="studentName" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium hidden md:table-cell">{t("columns.class")}</th>
                  <th className="text-left px-5 py-3 font-medium">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("testName")}>
                      {t("columns.test")} <SortIcon k="testName" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("status")}>
                      {t("columns.status")} <SortIcon k="status" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("percentage")}>
                      {t("columns.score")} <SortIcon k="percentage" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium hidden sm:table-cell">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("correctCount")}>
                      {t("columns.correct")} <SortIcon k="correctCount" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium hidden md:table-cell">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("timeSpentSeconds")}>
                      {t("columns.time")} <SortIcon k="timeSpentSeconds" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium hidden lg:table-cell">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("submittedAt")}>
                      {t("columns.submitted")} <SortIcon k="submittedAt" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium">{t("columns.action")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr
                    key={row.submissionId}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <div className="text-charcoal font-medium">{row.studentName}</div>
                      <div className="text-soft-mute text-xs">{row.email}</div>
                    </td>
                    <td className="px-5 py-3 text-mid-gray hidden md:table-cell">{row.classGroup ?? "—"}</td>
                    <td className="px-5 py-3">
                      <div className="text-charcoal">{row.testName}</div>
                      {row.section && <div className="text-soft-mute text-xs">{row.section}</div>}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={clsx(
                          "px-2 py-0.5 rounded-full text-xs font-medium",
                          statusStyles[row.status] ?? "bg-light-bg text-mid-gray"
                        )}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col">
                        <span
                          className={clsx(
                            "font-semibold",
                            row.percentage != null && row.percentage >= 70
                              ? "text-warm-amber"
                              : row.percentage != null && row.percentage >= 50
                                ? "text-status-warning"
                                : row.percentage != null
                                  ? "text-status-error"
                                  : "text-soft-mute"
                          )}
                        >
                          {row.percentage != null ? `${Number(row.percentage).toFixed(1)}%` : "—"}
                        </span>
                        {(() => {
                          const s = effectiveScaled(row);
                          return s != null ? (
                            <span
                              className="text-warm-coral text-xs"
                              title="Estimated SAT scaled score (200-800)"
                            >
                              {s}/800
                            </span>
                          ) : null;
                        })()}
                        {/* Two-module attempts show the per-module
                            split under the combined headline. */}
                        {row.modules && row.modules.length > 1 && (
                          <div className="text-soft-mute text-[11px] mt-0.5 leading-snug font-normal">
                            {row.modules.map((m) => (
                              <div key={m.submissionId}>
                                {m.label}:{" "}
                                {m.percentage != null
                                  ? `${m.percentage.toFixed(1)}%`
                                  : "—"}
                                {m.scaledScore != null && ` · ${m.scaledScore}/800`}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-mid-gray hidden sm:table-cell">
                      <div>
                        {row.totalQuestions > 0 ? `${row.correctCount}/${row.totalQuestions}` : "—"}
                      </div>
                      {row.modules && row.modules.length > 1 && (
                        <div className="text-soft-mute text-[11px] mt-0.5 leading-snug">
                          {row.modules.map((m) => (
                            <div key={m.submissionId}>
                              {m.label}: {m.correctCount}/{m.totalQuestions}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-mid-gray hidden md:table-cell">{fmtTime(row.timeSpentSeconds)}</td>
                    <td className="px-5 py-3 text-soft-mute text-xs hidden lg:table-cell">
                      {row.submittedAt ? formatDateTime(row.submittedAt) : "—"}
                    </td>
                    <td className="px-5 py-3">
                      {(row.status === "Submitted" || row.status === "Late") && (
                        <Link
                          href={`/teacher/tests/${row.testId}/results/${row.submissionId}`}
                          className="text-warm-coral text-xs hover:underline"
                        >
                          {t("view")}
                        </Link>
                      )}
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
