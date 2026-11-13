"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import ClassReviewButton from "@/components/tests/ClassReviewButton";
import { clsx } from "clsx";
import { ChevronDown, ChevronRight, BookOpen } from "lucide-react";
import MathMarkdown from "@/components/MathMarkdown";
import type { AnalyticsModule, AnalyticsQuestion, StudentQuestionRow } from "@/app/api/teacher/tests/[id]/analytics/route";

interface AnalyticsData {
  modules: AnalyticsModule[];
  submittedAttempts: number;
  /** Full-length SAT parent: its sections' analytics are the children's. */
  fullLength?: { sections: { key: string; label: string; testId: string }[] };
}

function fmtTime(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// One-line preview: drop Markdown table rows (a data table rendered in full
// made a single row taller than the screen) and join the remaining lines.
function preview(text: string) {
  const flat = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("|"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 110 ? flat.slice(0, 110) + "…" : flat;
}

function missedColor(pct: number) {
  return pct >= 50 ? "bg-status-error" : pct >= 30 ? "bg-status-warning" : "bg-status-success";
}

// One table per module, questions in test order: how many students missed
// each one (wrong or blank). Opening a question shows every student's
// answer, time on it, answer changes and whether they skipped it first.
export default function QuestionAnalyticsPage() {
  const params = useParams<{ id: string }>();
  const pageTestId = params.id;
  const tReview = useTranslations("teacher.classReview");

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Full-length SAT: the section tabs and the selected section's own test
  // id (analytics, flags and question detail all run on the section).
  const [sections, setSections] = useState<{ key: string; label: string; testId: string }[] | null>(null);
  const [sectionTestId, setSectionTestId] = useState<string | null>(null);
  const testId = sectionTestId ?? pageTestId;

  useEffect(() => {
    setLoading(true);
    let next = false;
    // A tab switch cancels the previous section's request (no stale data).
    const ctrl = new AbortController();
    fetch(`/api/teacher/tests/${testId}/analytics`, { signal: ctrl.signal })
      .then(async (r) => {
        if (r.status === 403) throw new Error("forbidden");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = (await r.json()) as AnalyticsData;
        if (json.fullLength && !sectionTestId) {
          setSections(json.fullLength.sections);
          if (json.fullLength.sections.length > 0) {
            // Load the first section next (keeps the loading state).
            next = true;
            setSectionTestId(json.fullLength.sections[0].testId);
            return;
          }
        }
        if (ctrl.signal.aborted) return;
        setData(json);
      })
      .catch((err: Error) => {
        if (!ctrl.signal.aborted) setLoadError(err.message);
      })
      .finally(() => {
        if (!next && !ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [testId, sectionTestId]);

  const toggleClassReview = useCallback(
    async (questionId: string, current: boolean) => {
      const ok = await fetch(`/api/teacher/tests/${testId}/questions/${questionId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_type: "class_review", note_body: String(!current) }),
      }).then((r) => r.ok, () => false);
      if (!ok) {
        alert("Couldn't save the class-review mark. Check your connection and try again.");
        return;
      }
      setData((prev) =>
        prev && {
          ...prev,
          modules: prev.modules.map((m) => ({
            ...m,
            questions: m.questions.map((q) => (q.questionId === questionId ? { ...q, classReview: !current } : q)),
          })),
        },
      );
    },
    [testId],
  );

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (loading) {
    return <div className="max-w-5xl mx-auto py-16 text-center text-soft-mute">Loading analytics...</div>;
  }

  if (loadError === "forbidden") {
    return (
      <div className="max-w-5xl mx-auto py-16 text-center space-y-3">
        <p className="text-charcoal font-semibold">You don&rsquo;t have access to this test&rsquo;s analytics.</p>
        <p className="text-soft-mute text-sm">It may belong to another class or a subject you don&rsquo;t teach.</p>
        <Link href="/teacher/tests" className="text-warm-coral-text text-sm hover:underline">Back to My Tests</Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-5xl mx-auto py-16 text-center space-y-3">
        <p className="text-status-error">Failed to load analytics.</p>
        <Link href="/teacher/tests" className="text-warm-coral-text text-sm hover:underline">Back to My Tests</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="flex items-center gap-2 text-soft-mute text-sm flex-wrap">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${pageTestId}/results`} className="hover:text-charcoal transition-colors">Results</Link>
        <span>/</span>
        <span className="text-charcoal">Question Analytics</span>
      </div>

      <div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-bold text-charcoal">Question Analytics</h1>
          <ClassReviewButton testId={pageTestId} label={tReview("button")} />
        </div>
        <p className="text-soft-mute text-sm mt-1">
          {`${data.submittedAttempts} student${data.submittedAttempts === 1 ? "" : "s"} submitted. `}
          Missed = answered wrong or left blank. Avg time and changed answer are recorded for tests taken from
          Nov 6, 2026 on. Click a question to see each student&rsquo;s answer, time, answer changes and skips.
        </p>
      </div>

      {sections && sections.length > 0 && (
        <div className="flex gap-2 border-b border-divider" role="tablist">
          {sections.map((sec) => (
            <button
              key={sec.key}
              type="button"
              role="tab"
              aria-selected={testId === sec.testId}
              onClick={() => {
                if (sec.testId === testId) return;
                setOpen(new Set());
                setData(null);
                setSectionTestId(sec.testId);
              }}
              className={clsx(
                "px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition-colors",
                testId === sec.testId ? "border-warm-coral text-charcoal" : "border-transparent text-soft-mute hover:text-charcoal",
              )}
            >
              {sec.label}
            </button>
          ))}
        </div>
      )}

      {data.modules.length === 0 && (
        <div className="py-12 text-center text-soft-mute text-sm">This test has no questions yet.</div>
      )}

      {data.modules.map((m, mi) => (
        <section key={mi} className="space-y-3">
          {m.label && <h2 className="text-charcoal font-semibold text-lg">{m.label}</h2>}
          <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-divider flex items-center gap-4 text-soft-mute text-xs font-medium">
              <div className="w-4" />
              <div className="w-10">Q#</div>
              <div className="flex-1">Question</div>
              <div className="w-44">Missed</div>
              <div className="w-20 text-right hidden sm:block">Avg time</div>
              <div className="w-24 text-right hidden sm:block">Changed answer</div>
            </div>
            {m.questions.map((q) => {
              const key = `${mi}:${q.questionId}`;
              return (
                <QuestionRow
                  key={key}
                  q={q}
                  expanded={open.has(key)}
                  onToggle={() => toggle(key)}
                  onToggleClassReview={toggleClassReview}
                  detailHref={`/teacher/tests/${testId}/analytics/${q.questionId}`}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function QuestionRow({
  q,
  expanded,
  onToggle,
  onToggleClassReview,
  detailHref,
}: {
  q: AnalyticsQuestion;
  expanded: boolean;
  onToggle: () => void;
  onToggleClassReview: (questionId: string, current: boolean) => void;
  detailHref: string;
}) {
  const pct = q.taken > 0 ? Math.round((q.missed / q.taken) * 100) : null;
  return (
    <div className={clsx("border-b border-divider last:border-0", q.classReview && "bg-warm-coral/5")}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full px-5 py-3.5 flex items-center gap-4 text-left hover:bg-light-bg/60 transition-colors"
      >
        <div className="w-4 shrink-0 text-soft-mute">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</div>
        <div className="w-10 shrink-0 text-charcoal text-sm font-semibold font-mono">Q{q.questionNumber}</div>
        <div className="flex-1 min-w-0">
          <MathMarkdown className="text-charcoal text-sm prose prose-sm max-w-none [&_p]:my-0 [&_p]:truncate">
            {preview(q.questionText)}
          </MathMarkdown>
          {q.domain && <div className="text-soft-mute text-xs mt-0.5">{q.domain}</div>}
        </div>
        <div className="w-44 shrink-0">
          {pct == null ? (
            <span className="text-soft-mute text-sm">No answers yet</span>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 rounded-full bg-light-bg overflow-hidden">
                <div className={clsx("h-full rounded-full", missedColor(pct))} style={{ width: `${pct}%` }} />
              </div>
              <div className="text-right leading-tight">
                <div className="text-charcoal text-sm font-bold">{pct}%</div>
                <div className="text-soft-mute text-[11px] whitespace-nowrap">{q.missed} of {q.taken}</div>
              </div>
            </div>
          )}
        </div>
        <div className="w-20 shrink-0 text-right text-sm text-mid-gray hidden sm:block">{fmtTime(q.avgTimeSeconds)}</div>
        <div className="w-24 shrink-0 text-right text-sm text-mid-gray hidden sm:block">
          {q.tracked === 0 ? "—" : `${q.changed} of ${q.tracked}`}
        </div>
      </button>

      {expanded && (
        <div className="px-5 sm:px-14 pb-5 space-y-4">
          <MathMarkdown className="text-mid-gray text-sm leading-relaxed bg-light-bg/50 rounded-lg p-4 prose prose-sm max-w-none [&_p]:my-2">
            {q.questionText}
          </MathMarkdown>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span>
              <span className="text-soft-mute">Correct answer: </span>
              <span className="font-bold text-charcoal">{q.correctAnswer || "—"}</span>
            </span>
            {q.blank > 0 && <span className="text-soft-mute">{q.blank} left blank</span>}
            <button
              onClick={() => onToggleClassReview(q.questionId, q.classReview)}
              className={clsx(
                "inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border transition-colors",
                q.classReview
                  ? "bg-warm-coral/20 text-warm-coral-text border-warm-coral/30"
                  : "bg-light-bg text-mid-gray border-divider hover:text-warm-coral-text hover:border-warm-coral/30",
              )}
            >
              <BookOpen size={12} />
              {q.classReview ? "Marked to teach in class" : "Teach in class"}
            </button>
            <Link href={detailHref} className="text-warm-coral-text text-xs font-medium hover:underline">
              Full question &amp; explanation →
            </Link>
          </div>
          {q.students.length > 0 ? <StudentTable students={q.students} /> : (
            <p className="text-soft-mute text-sm">No student has submitted this question yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function StudentTable({ students }: { students: StudentQuestionRow[] }) {
  const anyActivity = students.some((s) => s.activity);
  return (
    <div className="border border-divider rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-light-bg/60 text-soft-mute text-xs">
          <tr>
            <th className="text-left font-medium px-3 py-2">Student</th>
            <th className="text-left font-medium px-3 py-2">Answer</th>
            <th className="text-right font-medium px-3 py-2">Time</th>
            <th className="text-left font-medium px-3 py-2">Changed answer?</th>
            <th className="text-left font-medium px-3 py-2">Skipped, came back?</th>
          </tr>
        </thead>
        <tbody>
          {students.map((s, i) => (
            <tr key={i} className="border-t border-divider">
              <td className="px-3 py-2 text-charcoal">{s.name}</td>
              <td className="px-3 py-2">
                <span className={clsx("font-semibold", s.correct ? "text-status-success" : "text-status-error")}>
                  {s.answer || "Blank"} {s.correct ? "✓" : "✗"}
                </span>
              </td>
              <td className="px-3 py-2 text-right text-mid-gray">{s.activity ? fmtTime(s.activity.seconds) : "—"}</td>
              <td className="px-3 py-2 text-mid-gray">
                {!s.activity ? "—" : s.activity.changes === 0 ? "No" : (
                  <span>
                    Yes, {s.activity.changes}× <span className="text-soft-mute">({s.activity.history.join(" → ")})</span>
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-mid-gray">
                {!s.activity
                  ? "—"
                  : s.activity.skippedAndReturned
                    ? "Yes"
                    : s.activity.skippedNeverReturned
                      ? "Skipped, never came back"
                      : "No"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!anyActivity && (
        <p className="px-3 py-2 text-xs text-soft-mute border-t border-divider">
          Time, answer changes and skips are recorded for tests taken from Nov 6, 2026 on.
        </p>
      )}
    </div>
  );
}
