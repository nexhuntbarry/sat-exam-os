import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle, XCircle, Clock, BarChart2, Printer } from "lucide-react";
import { clsx } from "clsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import { getAnswerVisibility } from "@/lib/answer-visibility";
import { loadFlContext } from "@/lib/full-length-attempt";
import {
  flFinished,
  flStatusText,
  fullLengthAttemptScore,
  loadFlAttemptMeta,
  flAttemptKey,
  type FlScoreRow,
} from "@/lib/full-length-score";
import type { AttemptScore } from "@/lib/score-display";
import AnswerReviewItem, { type AnswerDetail } from "./AnswerReviewItem";

// Result of a full-length SAT (plan Phase 3): Total /1600, R&W and Math
// /800 with their M1/M2 counts, then one tab per section reusing the
// section result's breakdown and answer review. Answers follow the
// parent's visibility decision, which only counts the attempt as
// submitted once Math Module 2 is graded — so R&W answers never show
// while Math is still to come.

const TRACK_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};

type Row = FlScoreRow & {
  id: string;
  time_spent_seconds: number | null;
  started_at: string | null;
};

const DONE = new Set(["Submitted", "Late"]);

function formatTime(seconds: number | null) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function SectionCard({ title, a, active, href }: { title: string; a: AttemptScore; active: boolean; href: string }) {
  return (
    <Link
      href={href}
      className={clsx(
        "block p-4 rounded-xl border text-left transition-colors",
        active ? "border-warm-coral/40 bg-warm-coral/5" : "border-divider hover:border-warm-coral/30",
      )}
    >
      <div className="text-soft-mute text-xs font-medium uppercase tracking-wider">{title}</div>
      <div className="text-3xl font-bold text-charcoal mt-1">
        {a.score?.sat ?? "—"}
        <span className="text-base text-soft-mute font-normal">/800</span>
      </div>
      <div className="text-mid-gray text-sm mt-1">{a.score ? `${a.score.modules} correct` : "Not taken"}</div>
      {a.score && a.score.notes.length > 0 && (
        <div className="text-status-warning text-xs mt-1">* {a.score.notes.join(" · ")}</div>
      )}
    </Link>
  );
}

export default async function FullLengthResult({
  db,
  testId,
  studentId,
  attemptParam,
  sectionParam,
  reportsEnabled,
}: {
  db: SupabaseClient;
  testId: string;
  studentId: string;
  attemptParam?: string;
  sectionParam?: string;
  reportsEnabled: boolean;
}) {
  const ctx = await loadFlContext(db, testId);
  if (!ctx) notFound();

  const { data: rowData } = await db
    .from("submissions")
    .select(
      "id, test_id, student_id, status, correct_count, total_questions, percentage, adaptive_track, session_id, " +
        "attempt_number, started_at, submitted_at, time_spent_seconds",
    )
    .in("test_id", [ctx.rw.id, ctx.math.id])
    .eq("student_id", studentId);
  const all = (rowData ?? []) as unknown as Row[];
  if (all.length === 0) notFound();

  const meta = await loadFlAttemptMeta(db, [testId], studentId);
  const numbers = Array.from(new Set(all.map((r) => r.attempt_number ?? 1))).sort((a, b) => b - a);
  const scoreOf = (n: number) => {
    const rows = all.filter((r) => (r.attempt_number ?? 1) === n);
    return fullLengthAttemptScore(
      rows.filter((r) => r.test_id === ctx.rw.id),
      rows.filter((r) => r.test_id === ctx.math.id),
      meta.get(flAttemptKey(testId, studentId, n)),
    );
  };
  // Requested attempt, else the latest finished one (or closed with R&W
  // in), else the latest — shown as a partial result.
  const requested = Number(attemptParam);
  const attemptNumber = numbers.includes(requested)
    ? requested
    : numbers.find((n) => {
        const s = scoreOf(n);
        return flFinished(s) || s.status.startsWith("Closed");
      }) ?? numbers[0];
  const rows = all.filter((r) => (r.attempt_number ?? 1) === attemptNumber);
  const rwRows = rows.filter((r) => r.test_id === ctx.rw.id);
  const mathRows = rows.filter((r) => r.test_id === ctx.math.id);
  const score = scoreOf(attemptNumber);
  const finished = flFinished(score);

  const section: "rw" | "math" = sectionParam === "math" ? "math" : "rw";
  const sectionRows = (section === "rw" ? rwRows : mathRows)
    .filter((r) => DONE.has(r.status))
    .sort((a, b) => (a.adaptive_track === "module_1" ? 0 : 1) - (b.adaptive_track === "module_1" ? 0 : 1));
  const sectionTestId = section === "rw" ? ctx.rw.id : ctx.math.id;
  const href = (s: "rw" | "math") => `/student/tests/${testId}/result?attempt=${attemptNumber}&section=${s}`;

  // Same reveal rule as the section result page: the results decision,
  // or an open class review when that one hides answers.
  let visibility = await getAnswerVisibility(db, testId, studentId, "results");
  if (!visibility.answers) {
    const review = await getAnswerVisibility(db, testId, studentId, "class_review");
    if (review.answers) visibility = review;
  }

  const gradedIds = sectionRows.map((r) => r.id);
  let answerDetails: AnswerDetail[] = [];
  if (visibility.answers && gradedIds.length > 0) {
    const { data: records } = await db
      .from("answer_records")
      .select(`
        id, submission_id, question_id, student_answer, correct_answer, is_correct,
        questions!inner(
          original_question_number, question_text, choices, question_type,
          explanation, difficulty, module_id, has_image, has_table,
          image_urls, image_alts, page_number
        )
      `)
      .in("submission_id", gradedIds);
    answerDetails = ((records ?? []) as unknown as AnswerDetail[]).map((r) =>
      visibility.explanations ? r : { ...r, questions: { ...r.questions, explanation: null } },
    );
    const order = new Map(gradedIds.map((id, i) => [id, i] as const));
    answerDetails.sort(
      (a, b) =>
        (order.get(a.submission_id) ?? 0) - (order.get(b.submission_id) ?? 0) ||
        (a.questions.original_question_number ?? 0) - (b.questions.original_question_number ?? 0),
    );
  }

  // Strengths & focus areas of this section (aggregate only, always shown,
  // like the section result).
  let breakdownRows: { is_correct: boolean; section: string | null; domain: string | null; skill: string | null }[] = [];
  if (gradedIds.length > 0) {
    const { data: br } = await db
      .from("answer_records")
      .select("is_correct, questions!inner(section, domain, skill)")
      .in("submission_id", gradedIds);
    breakdownRows = ((br ?? []) as unknown as {
      is_correct: boolean;
      questions: { section: string | null; domain: string | null; skill: string | null };
    }[]).map((r) => ({
      is_correct: r.is_correct,
      section: r.questions?.section ?? null,
      domain: r.questions?.domain ?? null,
      skill: r.questions?.skill ?? null,
    }));
  }

  const graded = rows.filter((r) => DONE.has(r.status));
  const correct = graded.reduce((n, r) => n + (r.correct_count ?? 0), 0);
  const questions = graded.reduce((n, r) => n + (r.total_questions ?? 0), 0);
  const time = graded.reduce((n, r) => n + (r.time_spent_seconds ?? 0), 0);
  const printRow = sectionRows[sectionRows.length - 1] ?? graded[graded.length - 1];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/student/tests" className="hover:text-charcoal transition-colors">My Tests</Link>
        <span>/</span>
        <Link href={`/student/tests/${testId}`} className="hover:text-charcoal transition-colors">{ctx.parent.test_name}</Link>
        <span>/</span>
        <span className="text-charcoal">Result</span>
      </div>

      {!finished && (
        <div className="bg-warm-amber/10 border border-warm-amber/30 rounded-2xl p-5 flex items-start gap-3">
          <Clock size={20} className="text-warm-amber shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="text-charcoal font-semibold text-sm">
              {score.status === "Closed — Math not taken"
                ? "Math wasn't taken — no total score for this attempt"
                : score.status.startsWith("Closed")
                ? "This attempt is closed — no total score"
                : `Partial result — ${flStatusText(score)}`}
            </div>
            <div className="text-mid-gray text-xs leading-relaxed">
              The total score appears once both sections are finished. Answers are shown after the whole test is done.
            </div>
            {!score.status.startsWith("Closed") && (
              <Link
                href={`/student/tests/${testId}`}
                className="inline-block mt-2 px-3 py-1.5 rounded-lg bg-warm-amber/20 hover:bg-warm-amber/30 text-warm-amber text-xs font-medium transition-colors"
              >
                Back to the test
              </Link>
            )}
          </div>
        </div>
      )}

      <div className="bg-surface border border-divider rounded-2xl p-8 text-center space-y-4">
        <div className="text-soft-mute text-sm font-medium uppercase tracking-wider">
          Estimated SAT score · Full-length
        </div>
        <div className="text-6xl font-bold text-charcoal">
          {score.total ?? "—"}
          <span className="text-2xl text-soft-mute font-normal">/1600</span>
        </div>
        {score.score?.pct != null && (
          <div className="text-soft-mute text-xs">{score.score.pct.toFixed(1)}% correct</div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
          <SectionCard title="Reading and Writing" a={score.rw} active={section === "rw"} href={href("rw")} />
          <SectionCard title="Math" a={score.math} active={section === "math"} href={href("math")} />
        </div>
        {score.status === "Late" && (
          <div className="inline-block px-3 py-1 bg-status-warning/15 text-status-warning rounded-full text-xs font-medium">
            Submitted Late
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <CheckCircle size={20} className="text-warm-amber" />
          <div className="text-charcoal font-semibold">{correct}</div>
          <div className="text-soft-mute text-xs">Correct</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <XCircle size={20} className="text-status-error" />
          <div className="text-charcoal font-semibold">{questions - correct}</div>
          <div className="text-soft-mute text-xs">Incorrect</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <Clock size={20} className="text-warm-coral-text" />
          <div className="text-charcoal font-semibold text-sm">{formatTime(time)}</div>
          <div className="text-soft-mute text-xs">Time Spent</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <BarChart2 size={20} className="text-warm-coral-text" />
          <div className="text-charcoal font-semibold">#{attemptNumber}</div>
          <div className="text-soft-mute text-xs">Attempt</div>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex gap-2 border-b border-divider" role="tablist">
        {(["rw", "math"] as const).map((s) => (
          <Link
            key={s}
            href={href(s)}
            role="tab"
            aria-selected={section === s}
            className={clsx(
              "px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition-colors",
              section === s ? "border-warm-coral text-charcoal" : "border-transparent text-soft-mute hover:text-charcoal",
            )}
          >
            {s === "rw" ? "Reading and Writing" : "Math"}
          </Link>
        ))}
      </div>

      {sectionRows.length === 0 ? (
        <div className="p-4 bg-surface border border-divider rounded-xl text-center text-soft-mute text-sm">
          {section === "rw" ? "Reading and Writing" : "Math"} hasn&apos;t been submitted in this attempt.
        </div>
      ) : (
        <>
          {breakdownRows.length > 0 && (
            <ScoreBreakdown rows={breakdownRows} title="Your Strengths & Focus Areas" />
          )}

          {answerDetails.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-charcoal font-semibold text-lg">Answer Review</h2>
                {printRow && (
                  <a
                    href={`/print/results/${testId}?subs=${printRow.id}`}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-light-bg hover:bg-divider text-charcoal text-xs font-semibold transition-colors print:hidden"
                  >
                    <Printer size={13} />
                    Print
                  </a>
                )}
              </div>
              {sectionRows.map((row) => {
                const recs = answerDetails.filter((r) => r.submission_id === row.id);
                if (recs.length === 0) return null;
                return (
                  <div key={row.id} className="space-y-3">
                    <div className="text-soft-mute text-xs font-semibold uppercase tracking-wider pt-2">
                      {TRACK_LABEL[row.adaptive_track ?? ""] ?? "Module"}
                    </div>
                    {recs.map((record) => (
                      <AnswerReviewItem
                        key={record.id}
                        record={record}
                        visibility={visibility}
                        reportsEnabled={reportsEnabled}
                        testId={sectionTestId}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4 bg-surface border border-divider rounded-xl text-center text-soft-mute text-sm">
              {!finished
                ? "Answers are shown after you finish the whole test."
                : "Detailed answer review is not available for this test."}
            </div>
          )}
        </>
      )}

      <div className="flex justify-center">
        <Link
          href="/student/tests"
          className="px-6 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider transition-colors text-sm"
        >
          Back to Tests
        </Link>
      </div>
    </div>
  );
}
