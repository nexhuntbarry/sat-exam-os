"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, ChevronUp, ChevronDown, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ScoreDisplay } from "@/lib/score-display";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge, type AttemptStatus } from "@/components/ui/StatusBadge";
import { formatDateTime, formatShortDate } from "@/lib/datetime";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  TwoLineCell,
} from "@/components/ui/data-table";

export interface CrossTestResultRow {
  submissionId: string;
  testId: string;
  testName: string;
  section: string | null;
  studentId: string;
  studentName: string;
  email: string;
  classGroup: string | null;
  status: AttemptStatus;
  /** Module being taken while In progress. */
  module: { n: number; of: number } | null;
  /** Shared score display (lib/score-display). */
  score: ScoreDisplay | null;
  /** SAT section score once every module is in (sort key). */
  sat: number | null;
  /** % correct of a finished attempt (secondary only). */
  percentage: number | null;
  timeSpentSeconds: number | null;
  submittedAt: string | null;
  /** Full-length SAT attempt: `sat` is the 400–1600 total; opens the test's results page. */
  fullLength?: boolean;
  detailHref?: string;
}

interface Props {
  rows: CrossTestResultRow[];
  testOptions: { id: string; name: string }[];
  classOptions: string[];
}

type SortKey =
  | "studentName"
  | "testName"
  | "status"
  | "sat"
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
      <ChevronUp size={12} className="text-warm-coral-text" />
    ) : (
      <ChevronDown size={12} className="text-warm-coral-text" />
    );
  }

  const selectCls =
    "bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50";

  // Student + class + test + status + score + time + submitted + action = 8
  const COL_COUNT = 8;

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

      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">
              <button className="flex items-center gap-1" onClick={() => toggleSort("studentName")}>
                {t("columns.student")} <SortIcon k="studentName" />
              </button>
            </Th>
            <Th priority="md">{t("columns.class")}</Th>
            <Th kind="long">
              <button className="flex items-center gap-1" onClick={() => toggleSort("testName")}>
                {t("columns.test")} <SortIcon k="testName" />
              </button>
            </Th>
            <Th>
              <button className="flex items-center gap-1" onClick={() => toggleSort("status")}>
                {t("columns.status")} <SortIcon k="status" />
              </button>
            </Th>
            <Th>
              <button className="flex items-center gap-1" onClick={() => toggleSort("sat")}>
                {t("columns.score")} <SortIcon k="sat" />
              </button>
            </Th>
            <Th priority="md">
              <button className="flex items-center gap-1" onClick={() => toggleSort("timeSpentSeconds")}>
                {t("columns.time")} <SortIcon k="timeSpentSeconds" />
              </button>
            </Th>
            <Th priority="lg">
              <button className="flex items-center gap-1" onClick={() => toggleSort("submittedAt")}>
                {t("columns.submitted")} <SortIcon k="submittedAt" />
              </button>
            </Th>
            <Th kind="actions" sticky="right"><span className="sr-only">{t("columns.action")}</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <EmptyRow colSpan={COL_COUNT}>{t("noResults")}</EmptyRow>
          )}
          {sorted.map((row) => {
            return (
              <DataRow
                key={row.submissionId}
                expandBelow="lg"
                colSpan={COL_COUNT}
                details={
                  <>
                    <DetailItem label={t("columns.class")} priority="md">{row.classGroup ?? "—"}</DetailItem>
                    <DetailItem label={t("columns.time")} priority="md">{fmtTime(row.timeSpentSeconds)}</DetailItem>
                    <DetailItem label={t("columns.submitted")} priority="lg">
                      {row.submittedAt
                        ? <span title={formatDateTime(row.submittedAt)}>{formatShortDate(row.submittedAt)}</span>
                        : "—"}
                    </DetailItem>
                  </>
                }
              >
                <Td kind="main" sticky="left">
                  <TwoLineCell
                    main={row.studentName}
                    detail={row.email}
                    mainClassName="font-medium text-charcoal"
                  />
                </Td>
                <Td priority="md" className="text-mid-gray whitespace-nowrap">{row.classGroup ?? "—"}</Td>
                <Td kind="long">
                  <TwoLineCell
                    main={row.testName}
                    detail={row.section ?? ""}
                  />
                </Td>
                <Td>
                  <StatusBadge kind="attempt" status={row.status} module={row.module} />
                </Td>
                <Td>
                  <ScoreCell score={row.score} />
                </Td>
                <Td priority="md" className="text-mid-gray whitespace-nowrap">{fmtTime(row.timeSpentSeconds)}</Td>
                <Td priority="lg" className="text-soft-mute whitespace-nowrap">
                  {row.submittedAt
                    ? <span title={formatDateTime(row.submittedAt)}>{formatShortDate(row.submittedAt)}</span>
                    : "—"}
                </Td>
                <Td kind="actions" sticky="right">
                  {(row.status === "Submitted" || row.status === "Late") && (
                    <Link
                      href={row.detailHref ?? `/teacher/tests/${row.testId}/results/${row.submissionId}`}
                      className="text-warm-coral-text text-xs hover:underline whitespace-nowrap"
                    >
                      {t("view")}
                    </Link>
                  )}
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
