"use client";

// "Assigned Tests" on the teacher's class page: one row per test assigned to
// the class (in the teacher's subject and reach), with completion counts,
// Avg SAT and Questions & answers / Results buttons. The completion cell
// expands to every student's status; an unfinished attempt gets the class
// grid's live line ("M2 · Q14 · 12:34 left"). Rows come from
// lib/assigned-tests-view (server); render inside the class Scores grid's
// LiveProgressProvider (ClassGradebook `above`), which shares its poll.

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ClipboardList, Eye, Presentation } from "lucide-react";
import { formatShortDate } from "@/lib/datetime";
import { classReviewHref, completionText, teacherResultsHref, type AssignedTestRow } from "@/lib/assigned-tests-view";
import { KIND_LABEL } from "@/lib/class-gradebook-view";
import { gradebookLiveKey } from "@/lib/live-progress-shared";
import { LiveProgressCell } from "@/components/analytics/LiveProgressCell";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge, SubjectTag, type TestStatus } from "@/components/ui/StatusBadge";
import {
  DataRow,
  DataTable,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  HeadRow,
  RowActions,
  RowButton,
  Td,
  Th,
  TwoLineCell,
  cn,
} from "@/components/ui/data-table";

const SECTION_OF = { math: "Math", rw: "Reading & Writing" } as const;
const COLS = 6;

export default function AssignedTestsTable({
  tests,
  reviewLabel,
  failed = false,
}: {
  tests: AssignedTestRow[];
  /** "Questions & answers (Class Review)" in the viewer's language. */
  reviewLabel: string;
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
              <Th kind="main" sticky="left">Test</Th>
              <Th>Status</Th>
              <Th>Subject</Th>
              <Th priority="lg">Dates</Th>
              <Th>Completion</Th>
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
              return (
                <Fragment key={t.id}>
                  <DataRow
                    expandBelow="lg"
                    colSpan={COLS}
                    details={<DetailItem label="Dates" priority="lg">{dueStr ? `${openStr} · ${dueStr}` : openStr}</DetailItem>}
                  >
                    <Td kind="main" sticky="left">
                      <TwoLineCell
                        main={t.name}
                        detail={t.today ? <span className="font-medium text-warm-coral-text">Today</span> : undefined}
                        wrapMain
                        mainClassName="font-medium text-charcoal"
                      />
                    </Td>
                    <Td>
                      {t.status ? <StatusBadge kind="test" status={t.status as TestStatus} /> : <span className="text-soft-mute">—</span>}
                    </Td>
                    <Td className="text-mid-gray">
                      {t.kind === "math" || t.kind === "rw" ? <SubjectTag section={SECTION_OF[t.kind]} /> : KIND_LABEL[t.kind]}
                    </Td>
                    <Td priority="lg">
                      <TwoLineCell main={openStr} detail={dueStr ?? undefined} mainClassName="text-mid-gray" />
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => toggle(t.id)}
                        aria-expanded={expanded}
                        aria-controls={expanded ? listId : undefined}
                        className="group text-left"
                        title={expanded ? "Hide students" : "Show each student"}
                      >
                        <span className="inline-flex items-center gap-1 text-charcoal group-hover:text-warm-coral-text">
                          {completionText(t.counts)}
                          <ChevronDown size={14} className={cn("shrink-0 text-soft-mute transition-transform", expanded && "rotate-180")} aria-hidden />
                        </span>
                        <span className="block text-xs text-mid-gray">
                          {t.avgSat != null ? (
                            <>
                              Avg SAT {t.avgSat}
                              {t.avgSection && ` (${t.avgSection})`}
                              {t.avgPct != null && <span className="text-soft-mute"> · {t.avgPct.toFixed(1)}% correct</span>}
                            </>
                          ) : (
                            <span className="text-soft-mute">No scores yet</span>
                          )}
                        </span>
                      </button>
                    </Td>
                    <Td kind="actions" sticky="right">
                      <RowActions>
                        <ExpandToggle label={`More about ${t.name}`} />
                        <RowButton label={reviewLabel} tone="primary" icon={<Presentation size={13} />} href={classReviewHref(t.id)} />
                        <RowButton label="Results" icon={<Eye size={13} />} href={teacherResultsHref(t.id)} />
                      </RowActions>
                    </Td>
                  </DataRow>
                  {expanded && (
                    <tr id={listId} className="border-b border-divider bg-surface">
                      <td colSpan={COLS} className="px-3 pb-3 pt-1">
                        {t.students.length === 0 ? (
                          <p className="text-sm text-soft-mute">No students in this class yet.</p>
                        ) : (
                          <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-lg bg-light-bg/70 px-3 py-2.5 sm:grid-cols-2 xl:grid-cols-3">
                            {t.students.map((s) => (
                              <li key={s.studentId} className="flex items-start justify-between gap-3 min-w-0">
                                <span className="min-w-0 truncate text-sm text-charcoal" title={s.email}>
                                  {s.name}
                                </span>
                                <span className="flex shrink-0 flex-col items-end text-right">
                                  <span className="inline-flex items-center gap-2">
                                    <StatusBadge
                                      kind="attempt"
                                      status={s.state === "submitted" ? "Submitted" : s.state === "in-progress" ? "In progress" : "Not started"}
                                    />
                                    {s.state === "submitted" &&
                                      (s.href ? (
                                        <Link href={s.href} className="rounded hover:ring-2 hover:ring-warm-coral/40">
                                          <ScoreCell score={s.score} />
                                        </Link>
                                      ) : (
                                        <ScoreCell score={s.score} />
                                      ))}
                                  </span>
                                  {s.note && <span className="text-[11px] text-soft-mute">{s.note}</span>}
                                  {s.live && <LiveProgressCell compact attemptKey={gradebookLiveKey(t.id, s.studentId)} />}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}
