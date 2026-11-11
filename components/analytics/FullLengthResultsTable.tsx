"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Eye } from "lucide-react";
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
  EmptyRow,
  RowActions,
  RowActionsMenu,
  RowButton,
  TwoLineCell,
  type RowAction,
} from "@/components/ui/data-table";

// Full-length SAT results (plan Phase 3): one row per attempt with the
// total, both section scores and every module's correct count (+ the
// Module 2 difficulty served). A teacher scoped to one subject gets the
// total plus their own section's columns only.

export interface FullLengthResultRow {
  key: string;
  studentId: string;
  studentName: string;
  email: string;
  classGroup: string | null;
  attemptNumber: number;
  status: AttemptStatus;
  statusLabel?: string;
  /** ScoreCell values: total (sat = 400–1600) and each section (200–800). */
  totalScore: ScoreDisplay | null;
  total: number | null;
  rw: ScoreDisplay | null;
  math: ScoreDisplay | null;
  /** "22/27", "—" (not finished) or "" (not reached). */
  rwM1: string;
  rwM2: string;
  rwTrack: string | null;
  mathM1: string;
  mathM2: string;
  mathTrack: string | null;
  /** Section detail pages (child test result), null when not finished / not visible. */
  rwHref: string | null;
  mathHref: string | null;
  timeSpentSeconds: number | null;
  submittedAt: string | null;
  retakePending: boolean;
  /** Times the student left the exam tab, whole attempt. */
  tabSwitches: number | null;
}

function fmtTime(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const withTrack = (count: string, track: string | null) => (track ? `${count} · ${track}` : count);

export function FullLengthResultsTable({
  rows,
  testId,
  scope,
}: {
  rows: FullLengthResultRow[];
  testId: string;
  scope: { rw: boolean; math: boolean };
}) {
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

  const statuses = useMemo(
    () => ["all", ...Array.from(new Set(rows.map((r) => r.statusLabel ?? r.status)))],
    [rows],
  );
  const shown = rows.filter((r) => statusFilter === "all" || (r.statusLabel ?? r.status) === statusFilter);
  const colCount = 5 + (scope.rw ? 3 : 0) + (scope.math ? 3 : 0) + 1;
  const selectCls = "bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
          {statuses.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Statuses" : s}</option>
          ))}
        </select>
        <div className="ml-auto text-soft-mute text-sm self-center">
          {shown.length} attempt{shown.length !== 1 ? "s" : ""}
        </div>
      </div>

      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">Student</Th>
            <Th>Status</Th>
            <Th>Total</Th>
            {scope.rw && <Th>R&amp;W</Th>}
            {scope.math && <Th>Math</Th>}
            {scope.rw && <Th priority="md">R&amp;W M1</Th>}
            {scope.rw && <Th priority="md">R&amp;W M2</Th>}
            {scope.math && <Th priority="md">Math M1</Th>}
            {scope.math && <Th priority="md">Math M2</Th>}
            <Th priority="md"><TabSwitchHeader /></Th>
            <Th priority="lg">Submitted</Th>
            <Th kind="actions" sticky="right"><span className="sr-only">Action</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {shown.length === 0 && <EmptyRow colSpan={colCount}>No attempts yet.</EmptyRow>}
          {shown.map((row) => {
            const finished = row.status === "Submitted" || row.status === "Late";
            const actions: (RowAction | false)[] = [
              finished && !row.retakePending && {
                label: grantingFor === row.studentId ? "Granting…" : "Allow retake",
                icon: RotateCcw,
                disabled: grantingFor === row.studentId,
                onSelect: () => grantRetake(row.studentId, row.studentName),
              },
            ];
            return (
              <DataRow key={row.key} href={row.rwHref ?? row.mathHref ?? undefined}>
                <Td kind="main" sticky="left">
                  <TwoLineCell
                    main={row.studentName}
                    detail={[row.email, row.classGroup].filter(Boolean).join(" · ")}
                    mainClassName="font-medium text-charcoal"
                  />
                </Td>
                <Td>
                  <StatusBadge kind="attempt" status={row.status} label={row.statusLabel} />
                </Td>
                <Td>
                  <ScoreCell score={row.totalScore} />
                </Td>
                {scope.rw && <Td><ScoreCell score={row.rw} /></Td>}
                {scope.math && <Td><ScoreCell score={row.math} /></Td>}
                {scope.rw && <Td priority="md" className="text-mid-gray whitespace-nowrap">{row.rwM1 || "—"}</Td>}
                {scope.rw && <Td priority="md" className="text-mid-gray whitespace-nowrap">{withTrack(row.rwM2 || "—", row.rwTrack)}</Td>}
                {scope.math && <Td priority="md" className="text-mid-gray whitespace-nowrap">{row.mathM1 || "—"}</Td>}
                {scope.math && <Td priority="md" className="text-mid-gray whitespace-nowrap">{withTrack(row.mathM2 || "—", row.mathTrack)}</Td>}
                <Td priority="md" className="whitespace-nowrap"><TabSwitchCount count={row.tabSwitches} /></Td>
                <Td priority="lg" className="text-soft-mute whitespace-nowrap">
                  {row.submittedAt
                    ? <span title={`${formatDateTime(row.submittedAt)} · ${fmtTime(row.timeSpentSeconds)}`}>{formatShortDate(row.submittedAt)}</span>
                    : "—"}
                </Td>
                <Td kind="actions" sticky="right">
                  <RowActions>
                    {finished && row.retakePending && (
                      <span className="inline-flex items-center gap-1 text-status-success text-xs whitespace-nowrap" title="Retake unlocked — student can start a new attempt">
                        <RotateCcw size={11} />
                        Retake unlocked
                      </span>
                    )}
                    {row.attemptNumber > 1 && <span className="text-xs text-soft-mute mr-1">#{row.attemptNumber}</span>}
                    {row.rwHref && <RowButton label="R&W" icon={<Eye size={13} />} href={row.rwHref} />}
                    {row.mathHref && <RowButton label="Math" icon={<Eye size={13} />} href={row.mathHref} />}
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
