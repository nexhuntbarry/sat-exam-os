"use client";

// "Assigned Tests" on the teacher's class page: one row per test assigned to
// the class (in the teacher's subject and reach), with completion counts,
// Avg SAT and Questions & answers / Results buttons. "▸ N students" opens a
// sub-table of every student (Student | Status | Score | M1 / M2 | link); an
// unfinished attempt gets the class grid's live line ("M2 · Q14 · 12:34
// left"). Rows come from lib/assigned-tests-view (server); render inside
// the class Scores grid's LiveProgressProvider (ClassGradebook `above`),
// which shares its poll.
//
// Widths: below lg the Status / Subject columns fold under the test name,
// below xl the Dates column does too, and the two row buttons stack, so the
// table fits the class page (max-w-5xl beside the sidebar) from iPad
// portrait up without scrolling sideways.

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronRight, ClipboardList, Eye, Presentation } from "lucide-react";
import { formatShortDate } from "@/lib/datetime";
import {
  classReviewHref,
  completionText,
  teacherResultsHref,
  type AssignedTestRow,
  type AssignedTestStudent,
} from "@/lib/assigned-tests-view";
import { KIND_LABEL } from "@/lib/class-gradebook-view";
import { gradebookLiveKey } from "@/lib/live-progress-shared";
import { LiveProgressCell } from "@/components/analytics/LiveProgressCell";
import { StatusBadge, SubjectTag, type AttemptStatus, type TestStatus } from "@/components/ui/StatusBadge";
import { DataRow, DataTable, EmptyRow, HeadRow, RowButton, Td, Th, cn } from "@/components/ui/data-table";

const SECTION_OF = { math: "Math", rw: "Reading & Writing" } as const;
const COLS = 6;

const ATTEMPT_OF: Record<AssignedTestStudent["state"], AttemptStatus> = {
  submitted: "Submitted",
  "in-progress": "In progress",
  "not-started": "Not started",
};

/** Keyboard focus ring only; a mouse click leaves no box behind. */
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-warm-coral/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface";

export default function AssignedTestsTable({
  tests,
  reviewLabel,
  failed = false,
  reviewOff,
}: {
  tests: AssignedTestRow[];
  /** "Questions & answers" in the viewer's language (teacher.classReview.short). */
  reviewLabel: string;
  /** Tests whose Questions & answers the admin turned off: greyed out, message as tooltip. */
  reviewOff?: { ids: string[]; message: string };
  /** The class gradebook couldn't load (no rows to show). */
  failed?: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-labelledby="assigned-tests-heading">
      <div className="flex items-center gap-2 mb-3">
        <ClipboardList size={14} className="text-warm-coral-text" aria-hidden />
        <h2 id="assigned-tests-heading" className="font-semibold text-charcoal">Assigned Tests</h2>
        {!failed && <span className="text-soft-mute font-normal text-sm">({tests.length})</span>}
      </div>
      {failed ? (
        <p role="alert" className="rounded-2xl border border-dashed border-divider px-5 py-6 text-center text-mid-gray text-sm">
          Assigned tests couldn&rsquo;t load. Refresh to try again.
        </p>
      ) : (
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left" className="w-[34%] min-w-[10rem]">Test</Th>
              <Th priority="lg">Status</Th>
              <Th priority="lg">Subject</Th>
              <Th priority="xl">Dates</Th>
              <Th className="w-[24%] min-w-[9rem]">Completion</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {tests.length === 0 && (
              <EmptyRow colSpan={COLS}>No tests assigned to this class in your subject yet. Ask your admin to assign one.</EmptyRow>
            )}
            {tests.map((t) => {
              const openStr = t.openDate ? `Opens ${formatShortDate(t.openDate)}` : "Open now";
              const dueStr = t.dueDate ? `Due ${formatShortDate(t.dueDate)}` : null;
              const expanded = open.has(t.id);
              const listId = `assigned-students-${t.id}`;
              const n = t.students.length;
              const status = t.status ? <StatusBadge kind="test" status={t.status as TestStatus} /> : null;
              const subject =
                t.kind === "math" || t.kind === "rw" ? <SubjectTag section={SECTION_OF[t.kind]} /> : <span className="text-xs text-mid-gray">{KIND_LABEL[t.kind]}</span>;
              return (
                <Fragment key={t.id}>
                  <DataRow className={cn(expanded && "border-b-0")}>
                    <Td kind="main" sticky="left" className="w-[34%] min-w-[10rem]">
                      <span className="block whitespace-normal break-words font-medium leading-snug text-charcoal">{t.name}</span>
                      {/* Columns hidden at this width, folded under the name. */}
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 lg:hidden">
                        {status}
                        {subject}
                      </span>
                      <span className="mt-0.5 block text-xs text-soft-mute">
                        {t.today && <span className="font-medium text-warm-coral-text">Today</span>}
                        <span className="xl:hidden">
                          {t.today && " · "}
                          {dueStr ? `${openStr} · ${dueStr}` : openStr}
                        </span>
                      </span>
                    </Td>
                    <Td priority="lg">{status ?? <span className="text-soft-mute">—</span>}</Td>
                    <Td priority="lg">{subject}</Td>
                    <Td priority="xl" className="text-mid-gray">
                      <span className="block">{openStr}</span>
                      {dueStr && <span className="block text-xs text-soft-mute">{dueStr}</span>}
                    </Td>
                    <Td className="w-[24%] min-w-[9rem] whitespace-normal">
                      <DotParts text={completionText(t.counts)} className="block leading-snug text-charcoal" />
                      <span className="block text-xs leading-snug text-mid-gray">
                        {t.avgSat != null ? (
                          <>
                            Avg SAT <span className="tabular-nums">{t.avgSat}</span>
                            {t.avgSection && ` (${t.avgSection})`}
                            {t.avgPct != null && <span className="text-soft-mute"> · {t.avgPct.toFixed(1)}% correct</span>}
                          </>
                        ) : (
                          <span className="text-soft-mute">No scores yet</span>
                        )}
                      </span>
                      {n > 0 && (
                        <button
                          type="button"
                          onClick={() => toggle(t.id)}
                          aria-expanded={expanded}
                          aria-controls={listId}
                          className={cn(
                            "-ml-1 mt-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-medium text-warm-coral-text hover:bg-warm-coral/10",
                            FOCUS,
                          )}
                        >
                          <ChevronRight size={14} className={cn("shrink-0 transition-transform duration-150", expanded && "rotate-90")} aria-hidden />
                          {n} {n === 1 ? "student" : "students"}
                          <span className="sr-only">{expanded ? ", hide list" : ", show list"}</span>
                        </button>
                      )}
                    </Td>
                    <Td kind="actions" sticky="right">
                      <span className="inline-flex flex-col items-stretch gap-1.5 whitespace-nowrap align-middle xl:flex-row xl:items-center">
                        {reviewOff?.ids.includes(t.id) ? (
                          <span title={reviewOff.message} data-teacher-qa-disabled className="inline-flex">
                            <RowButton label={reviewLabel} icon={<Presentation size={13} />} disabled title={reviewOff.message} />
                          </span>
                        ) : (
                          <RowButton label={reviewLabel} icon={<Presentation size={13} />} href={classReviewHref(t.id)} />
                        )}
                        <RowButton label="Results" icon={<Eye size={13} />} href={teacherResultsHref(t.id)} />
                      </span>
                    </Td>
                  </DataRow>
                  <tr id={listId} hidden={!expanded} className="border-b border-divider bg-surface">
                    <td colSpan={COLS} className="px-3 pb-3 pt-0">
                      {expanded && <StudentTable testId={t.id} testName={t.name} students={t.students} />}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}

/** "7/20 done · 13 not started", "M1 12/22 · M2 13/22": wraps only between
 *  the " · " parts, never inside one. */
function DotParts({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {text.split(" · ").map((part, i, all) => {
        const last = i === all.length - 1;
        return (
          <Fragment key={i}>
            <span className="whitespace-nowrap">{last ? part : `${part} ·`}</span>
            {!last && " "}
          </Fragment>
        );
      })}
    </span>
  );
}

/** Every student on one test, one aligned row each (order from assignedTestRows:
 *  in progress, not started, submitted; by name within each). */
function StudentTable({ testId, testName, students }: { testId: string; testName: string; students: AssignedTestStudent[] }) {
  const th = "px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-soft-mute whitespace-nowrap";
  return (
    // w-0 min-w-full: the sub-table never widens the outer table (it scrolls on its own if it must).
    <div className="w-0 min-w-full overflow-x-auto rounded-lg border border-divider bg-light-bg/60">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Students on {testName}</caption>
        <thead>
          <tr className="border-b border-divider">
            <th scope="col" className={cn(th, "w-[32%] min-w-[7rem]")}>Student</th>
            <th scope="col" className={cn(th, "w-px")}>Status</th>
            <th scope="col" className={cn(th, "w-px text-right")}>Score</th>
            <th scope="col" className={th}>M1 / M2</th>
            <th scope="col" className={cn(th, "w-px")}><span className="sr-only">Result</span></th>
          </tr>
        </thead>
        <tbody>
          {students.map((s) => (
            <tr key={s.studentId} className="border-b border-divider/70 last:border-0 align-middle">
              <td className="px-3 py-2">
                <span className="block break-words leading-snug text-charcoal" title={s.email}>{s.name}</span>
                {s.note && <span className="block text-[11px] leading-snug text-soft-mute">{s.note}</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                <StatusBadge kind="attempt" status={ATTEMPT_OF[s.state]} />
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-right">
                <StudentScore s={s} />
              </td>
              <td className="group/mod px-3 py-2 text-xs text-mid-gray">
                {s.score?.modules && <DotParts text={s.score.modules} className="block tabular-nums text-charcoal" />}
                {s.live && <LiveProgressCell compact attemptKey={gradebookLiveKey(testId, s.studentId)} className="mt-0" />}
                {/* No module counts and no live line (yet): a dash, hidden once the live line renders. */}
                {!s.score?.modules && <span className="text-soft-mute group-has-[div]/mod:hidden">—</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-right">
                {s.href && (
                  <Link
                    href={s.href}
                    className={cn("inline-flex items-center gap-1 rounded text-xs font-medium text-warm-coral-text hover:underline", FOCUS)}
                    aria-label={`View result: ${s.name}`}
                  >
                    View<span className="hidden lg:inline"> result</span>
                    <ChevronRight size={12} aria-hidden />
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The SAT the viewer may see, in full; % correct and review notes small. */
function StudentScore({ s }: { s: AssignedTestStudent }) {
  const sc = s.score;
  if (!sc) return <span className="text-soft-mute">—</span>;
  const title = [sc.pct != null ? `${sc.pct.toFixed(1)}% correct` : null, ...sc.notes].filter(Boolean).join("\n") || undefined;
  return (
    <span className="inline-block text-right" title={title}>
      {sc.sat != null ? (
        <span className="block text-base font-bold leading-tight tabular-nums text-charcoal">
          {sc.sat}
          {sc.notes.length > 0 && <span className="text-status-warning"> *</span>}
        </span>
      ) : (
        <span className="block text-xs text-soft-mute">{sc.notes.length > 0 ? "In review" : "—"}</span>
      )}
      {sc.pct != null && <span className="block text-[11px] text-soft-mute tabular-nums">{sc.pct.toFixed(1)}%</span>}
    </span>
  );
}
