"use client";

import { useState, useMemo } from "react";
import { clsx } from "clsx";
import Link from "next/link";
import { ArrowUpDown, ChevronUp, ChevronDown } from "lucide-react";

export interface StudentResultRow {
  submissionId: string;
  studentName: string;
  email: string;
  grade: string | null;
  classGroup: string | null;
  status: string;
  score: number | null;
  percentage: number | null;
  correctCount: number;
  totalQuestions: number;
  timeSpentSeconds: number | null;
  submittedAt: string | null;
}

interface StudentResultsTableProps {
  rows: StudentResultRow[];
  testId: string;
}

const statusStyles: Record<string, string> = {
  Submitted: "bg-lime-green/15 text-lime-green",
  Late: "bg-amber/15 text-amber",
  "In Progress": "bg-electric-blue/15 text-electric-blue",
  "Not Started": "bg-white/5 text-soft-gray/50",
  Expired: "bg-rose/15 text-rose",
};

type SortKey = "studentName" | "status" | "percentage" | "correctCount" | "timeSpentSeconds" | "submittedAt";

function fmtTime(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function StudentResultsTable({ rows, testId }: StudentResultsTableProps) {
  const [statusFilter, setStatusFilter] = useState("all");
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
    if (sortKey !== k) return <ArrowUpDown size={12} className="text-soft-gray/30" />;
    return sortAsc
      ? <ChevronUp size={12} className="text-electric-blue" />
      : <ChevronDown size={12} className="text-electric-blue" />;
  }

  const selectCls = "bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-soft-gray/80 focus:outline-none focus:border-electric-blue/50";

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
        <div className="ml-auto text-soft-gray/40 text-sm self-center">
          {sorted.length} student{sorted.length !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
        {sorted.length === 0 ? (
          <div className="py-12 text-center text-soft-gray/40 text-sm">No students match the current filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-soft-gray/50">
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
                  <tr key={row.submissionId} className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                    <td className="px-5 py-3">
                      <div className="text-white font-medium">{row.studentName}</div>
                      <div className="text-soft-gray/40 text-xs">{row.email}</div>
                    </td>
                    <td className="px-5 py-3 text-soft-gray/60 hidden sm:table-cell">{row.grade ?? "—"}</td>
                    <td className="px-5 py-3 text-soft-gray/60 hidden md:table-cell">{row.classGroup ?? "—"}</td>
                    <td className="px-5 py-3">
                      <span className={clsx(
                        "px-2 py-0.5 rounded-full text-xs font-medium",
                        statusStyles[row.status] ?? "bg-white/10 text-soft-gray/60"
                      )}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={clsx(
                        "font-semibold",
                        row.percentage != null && row.percentage >= 70 ? "text-lime-green" :
                        row.percentage != null && row.percentage >= 50 ? "text-amber" :
                        row.percentage != null ? "text-rose" : "text-soft-gray/40"
                      )}>
                        {row.percentage != null ? `${Number(row.percentage).toFixed(1)}%` : "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-soft-gray/60 hidden sm:table-cell">
                      {row.totalQuestions > 0 ? `${row.correctCount}/${row.totalQuestions}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-soft-gray/60 hidden md:table-cell">{fmtTime(row.timeSpentSeconds)}</td>
                    <td className="px-5 py-3 text-soft-gray/50 text-xs hidden lg:table-cell">
                      {row.submittedAt ? new Date(row.submittedAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-5 py-3">
                      {(row.status === "Submitted" || row.status === "Late") && (
                        <Link
                          href={`/teacher/tests/${testId}/results/${row.submissionId}`}
                          className="text-electric-blue text-xs hover:underline"
                        >
                          View
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
