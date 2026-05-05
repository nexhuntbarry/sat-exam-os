"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import Link from "next/link";
import { ArrowUpDown, ChevronUp, ChevronDown, RotateCcw } from "lucide-react";
import { scaleSectionScore } from "@/lib/scoring";

export interface StudentResultRow {
  submissionId: string;
  studentId: string;
  attemptNumber: number;
  studentName: string;
  email: string;
  grade: string | null;
  classGroup: string | null;
  status: string;
  score: number | null;
  percentage: number | null;
  scaledScore: number | null;
  correctCount: number;
  totalQuestions: number;
  timeSpentSeconds: number | null;
  submittedAt: string | null;
  retakePending: boolean;
}

interface StudentResultsTableProps {
  rows: StudentResultRow[];
  testId: string;
}

const statusStyles: Record<string, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In Progress": "bg-warm-coral/15 text-warm-coral",
  "Not Started": "bg-light-bg text-soft-mute",
  Expired: "bg-status-error/15 text-status-error",
};

type SortKey = "studentName" | "status" | "percentage" | "correctCount" | "timeSpentSeconds" | "submittedAt";

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
      ? <ChevronUp size={12} className="text-warm-coral" />
      : <ChevronDown size={12} className="text-warm-coral" />;
  }

  const selectCls = "bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50";

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

      {/* Table */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {sorted.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">No students match the current filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("studentName")}>
                      Student <SortIcon k="studentName" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium hidden sm:table-cell">Grade</th>
                  <th className="text-left px-5 py-3 font-medium hidden md:table-cell">Class</th>
                  <th className="text-left px-5 py-3 font-medium">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("status")}>
                      Status <SortIcon k="status" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("percentage")}>
                      Score <SortIcon k="percentage" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium hidden sm:table-cell">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("correctCount")}>
                      Correct <SortIcon k="correctCount" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium hidden md:table-cell">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("timeSpentSeconds")}>
                      Time <SortIcon k="timeSpentSeconds" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium hidden lg:table-cell">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("submittedAt")}>
                      Submitted <SortIcon k="submittedAt" />
                    </button>
                  </th>
                  <th className="text-left px-5 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr key={row.submissionId} className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                    <td className="px-5 py-3">
                      <div className="text-charcoal font-medium">{row.studentName}</div>
                      <div className="text-soft-mute text-xs">{row.email}</div>
                    </td>
                    <td className="px-5 py-3 text-mid-gray hidden sm:table-cell">{row.grade ?? "—"}</td>
                    <td className="px-5 py-3 text-mid-gray hidden md:table-cell">{row.classGroup ?? "—"}</td>
                    <td className="px-5 py-3">
                      <span className={clsx(
                        "px-2 py-0.5 rounded-full text-xs font-medium",
                        statusStyles[row.status] ?? "bg-light-bg text-mid-gray"
                      )}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={clsx(
                        "font-semibold",
                        row.percentage != null && row.percentage >= 70 ? "text-warm-amber" :
                        row.percentage != null && row.percentage >= 50 ? "text-status-warning" :
                        row.percentage != null ? "text-status-error" : "text-soft-mute"
                      )}>
                        {row.percentage != null ? `${Number(row.percentage).toFixed(1)}%` : "—"}
                      </span>
                      {(() => {
                        const eff =
                          row.scaledScore ??
                          (row.percentage != null
                            ? scaleSectionScore(Number(row.percentage))
                            : null);
                        return eff != null ? (
                          <span
                            className="ml-2 text-xs text-warm-coral"
                            title="Estimated SAT scaled score (200-800)"
                          >
                            {eff}/800
                          </span>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-5 py-3 text-mid-gray hidden sm:table-cell">
                      {row.totalQuestions > 0 ? `${row.correctCount}/${row.totalQuestions}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-mid-gray hidden md:table-cell">{fmtTime(row.timeSpentSeconds)}</td>
                    <td className="px-5 py-3 text-soft-mute text-xs hidden lg:table-cell">
                      {row.submittedAt ? new Date(row.submittedAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        {(row.status === "Submitted" || row.status === "Late") && (
                          <Link
                            href={`/teacher/tests/${testId}/results/${row.submissionId}`}
                            className="text-warm-coral text-xs hover:underline"
                          >
                            View
                          </Link>
                        )}
                        {(row.status === "Submitted" || row.status === "Late") &&
                          (row.retakePending ? (
                            <span
                              className="inline-flex items-center gap-1 text-status-success text-xs"
                              title="Retake unlocked — student can start a new attempt"
                            >
                              <RotateCcw size={11} />
                              Retake unlocked
                            </span>
                          ) : (
                            <button
                              onClick={() => grantRetake(row.studentId, row.studentName)}
                              disabled={grantingFor === row.studentId}
                              className="inline-flex items-center gap-1 text-warm-coral text-xs hover:underline disabled:opacity-50"
                              title="Allow this student to take the test again"
                            >
                              <RotateCcw size={11} />
                              {grantingFor === row.studentId ? "…" : "Allow retake"}
                            </button>
                          ))}
                        {row.attemptNumber > 1 && (
                          <span className="text-xs text-soft-mute">#{row.attemptNumber}</span>
                        )}
                      </div>
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
