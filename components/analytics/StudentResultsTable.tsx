"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUpDown, ChevronUp, ChevronDown, RotateCcw, Eye } from "lucide-react";
import type { ScoreDisplay } from "@/lib/score-display";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge, type AttemptStatus } from "@/components/ui/StatusBadge";
import { formatDateTime, formatShortDate } from "@/lib/datetime";
import { TabSwitchCount, TabSwitchHeader } from "@/components/analytics/TabSwitchCount";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  RowActions,
  RowActionsMenu,
  RowButton,
  TwoLineCell,
  type RowAction,
} from "@/components/ui/data-table";

export interface StudentResultRow {
  submissionId: string;
  studentId: string;
  attemptNumber: number;
  studentName: string;
  email: string;
  grade: string | null;
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
  retakePending: boolean;
  /** Times the student left the exam tab, all modules (lib/tab-switches). */
  tabSwitches: number | null;
}

interface StudentResultsTableProps {
  rows: StudentResultRow[];
  testId: string;
}

type SortKey = "studentName" | "status" | "sat" | "timeSpentSeconds" | "tabSwitches" | "submittedAt";

function fmtTime(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function StudentResultsTable({ rows, testId }: StudentResultsTableProps) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState("all");
  const [grantingFor, setGrantingFor] = useState<string | null>(null);

  async function grantRetake(studentId: string, studentName: string) {
    if (!confirm(`Allow ${studentName} to take this test again?`)) return;
    setGrantingFor(studentId);
    try {
      const res = await fetch(`/api/teacher/tests/${testId}/grant-retake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId }),
      });
      if (res.ok) router.refresh();
    } finally {
      setGrantingFor(null);
    }
  }
  const [gradeFilter, setGradeFilter] = useState("all");
  const [classFilter, setClassFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("submittedAt");
  const [sortAsc, setSortAsc] = useState(false);

  const statuses = useMemo(() => ["all", ...Array.from(new Set(rows.map((r) => r.status)))], [rows]);
  const grades = useMemo(() => ["all", ...Array.from(new Set(rows.map((r) => r.grade ?? "—").filter(Boolean)))], [rows]);
  const classes = useMemo(() => ["all", ...Array.from(new Set(rows.map((r) => r.classGroup ?? "—").filter(Boolean)))], [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (gradeFilter !== "all" && (r.grade ?? "—") !== gradeFilter) return false;
      if (classFilter !== "all" && (r.classGroup ?? "—") !== classFilter) return false;
      return true;
    });
  }, [rows, statusFilter, gradeFilter, classFilter]);

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
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ArrowUpDown size={12} className="text-soft-mute" />;
    return sortAsc
      ? <ChevronUp size={12} className="text-warm-coral-text" />
      : <ChevronDown size={12} className="text-warm-coral-text" />;
  }

  const selectCls = "bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50";

  // Student + grade + class + status + score + time + left tab + submitted + action = 9
  const COL_COUNT = 9;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
          {statuses.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Statuses" : s}</option>
          ))}
        </select>
        <select value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)} className={selectCls}>
          {grades.map((g) => (
            <option key={g} value={g}>{g === "all" ? "All Grades" : g}</option>
          ))}
        </select>
        <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className={selectCls}>
          {classes.map((c) => (
            <option key={c} value={c}>{c === "all" ? "All Classes" : c}</option>
          ))}
        </select>
        <div className="ml-auto text-soft-mute text-sm self-center">
          {sorted.length} student{sorted.length !== 1 ? "s" : ""}
        </div>
      </div>

      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">
              <button className="flex items-center gap-1" onClick={() => toggleSort("studentName")}>
                Student <SortIcon k="studentName" />
              </button>
            </Th>
            <Th priority="md">Grade</Th>
            <Th priority="md">Class</Th>
            <Th>
              <button className="flex items-center gap-1" onClick={() => toggleSort("status")}>
                Status <SortIcon k="status" />
              </button>
            </Th>
            <Th>
              <button className="flex items-center gap-1" onClick={() => toggleSort("sat")}>
                Score <SortIcon k="sat" />
              </button>
            </Th>
            <Th priority="md">
              <button className="flex items-center gap-1" onClick={() => toggleSort("timeSpentSeconds")}>
                Time <SortIcon k="timeSpentSeconds" />
              </button>
            </Th>
            <Th priority="md">
              <button className="flex items-center gap-1" onClick={() => toggleSort("tabSwitches")}>
                <TabSwitchHeader /> <SortIcon k="tabSwitches" />
              </button>
            </Th>
            <Th priority="lg">
              <button className="flex items-center gap-1" onClick={() => toggleSort("submittedAt")}>
                Submitted <SortIcon k="submittedAt" />
              </button>
            </Th>
            <Th kind="actions" sticky="right"><span className="sr-only">Action</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <EmptyRow colSpan={COL_COUNT}>No students match the current filters.</EmptyRow>
          )}
          {sorted.map((row) => {
            const canView = row.status === "Submitted" || row.status === "Late";

            // Rule 4: View results is the visible action (and the row
            // link); Allow retake is in ⋯.
            const resultHref = canView ? `/teacher/tests/${testId}/results/${row.submissionId}` : undefined;
            const actions: (RowAction | false)[] = [
              canView && !row.retakePending && {
                label: grantingFor === row.studentId ? "Granting…" : "Allow retake",
                icon: RotateCcw,
                disabled: grantingFor === row.studentId,
                onSelect: () => grantRetake(row.studentId, row.studentName),
              },
            ];

            return (
              <DataRow
                key={row.submissionId}
                href={resultHref}
                expandBelow="lg"
                colSpan={COL_COUNT}
                details={
                  <>
                    <DetailItem label="Grade" priority="md">{row.grade ?? "—"}</DetailItem>
                    <DetailItem label="Class" priority="md">{row.classGroup ?? "—"}</DetailItem>
                    <DetailItem label="Time" priority="md">{fmtTime(row.timeSpentSeconds)}</DetailItem>
                    <DetailItem label="Left tab" priority="md"><TabSwitchCount count={row.tabSwitches} /></DetailItem>
                    <DetailItem label="Submitted" priority="lg">
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
                <Td priority="md" className="text-mid-gray whitespace-nowrap">{row.grade ?? "—"}</Td>
                <Td priority="md" className="text-mid-gray whitespace-nowrap">{row.classGroup ?? "—"}</Td>
                <Td>
                  <StatusBadge kind="attempt" status={row.status} module={row.module} />
                </Td>
                <Td>
                  <ScoreCell score={row.score} />
                </Td>
                <Td priority="md" className="text-mid-gray whitespace-nowrap">{fmtTime(row.timeSpentSeconds)}</Td>
                <Td priority="md" className="whitespace-nowrap"><TabSwitchCount count={row.tabSwitches} /></Td>
                <Td priority="lg" className="text-soft-mute whitespace-nowrap">
                  {row.submittedAt
                    ? <span title={formatDateTime(row.submittedAt)}>{formatShortDate(row.submittedAt)}</span>
                    : "—"}
                </Td>
                <Td kind="actions" sticky="right">
                  <RowActions>
                  <ExpandToggle label={`More about ${row.studentName}`} />
                  {canView && row.retakePending && (
                    <span
                      className="inline-flex items-center gap-1 text-status-success text-xs whitespace-nowrap"
                      title="Retake unlocked — student can start a new attempt"
                    >
                      <RotateCcw size={11} />
                      Retake unlocked
                    </span>
                  )}
                  {row.attemptNumber > 1 && (
                    <span className="text-xs text-soft-mute mr-1">#{row.attemptNumber}</span>
                  )}
                  {resultHref && <RowButton label="View results" icon={<Eye size={13} />} href={resultHref} />}
                  <RowActionsMenu label={`Actions for ${row.studentName}`} items={actions} />
                  </RowActions>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
