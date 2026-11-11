// lib/grade-submission.ts
//
// Shared grading helper so both the interactive submit route
// (`POST /api/student/submissions/[id]/submit`) and the background
// cron auto-finalizer (and admin force-submit) use identical scoring +
// answer-record logic.
// Any change in scoring should live here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleSectionScore } from "@/lib/scoring";
import { parseActivity } from "@/lib/question-activity";
import {
  fullLengthStartedAtMs,
  isModule2Track,
  moduleDeadlineMs,
  moduleStartedAtIso,
  scopeToStudentQuestionSet,
} from "@/lib/student-exam";
import { keyCandidates, parseSprEntry, sprEntryCreditedForCandidate } from "@/lib/answer-key";

// Hyphen look-alikes students paste or type on some keyboards (U+2212
// minus sign, figure/en/em dashes, small and fullwidth hyphen-minus).
const MINUS_LOOKALIKES = /[\u2012\u2013\u2014\u2212\uFE63\uFF0D]/g;

function canonical(answer: string | null | undefined): string {
  if (answer == null) return "";
  return String(answer)
    // Full-width forms from CJK input methods: ３５ → 35, ６５／２ → 65/2.
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(MINUS_LOOKALIKES, "-")
    // Answer keys occasionally carry LaTeX: \frac{26}{5} → 26/5.
    .replace(/\\d?frac\{\s*(-?\d+)\s*\}\{\s*(\d+)\s*\}/g, "$1/$2")
    // ...or inline-math delimiters: $5$ → 5 (only when wrapped, so a
    // student's "$2.24" is not silently accepted as a number).
    .replace(/^\$+([^$]*)\$+$/, "$1")
    .trim();
}

// Strict parsing of a student's fill-in entry lives in lib/answer-key
// (parseSprEntry: integer, decimal or fraction; no commas, %, $, mixed
// numbers). Kept here under its old name for existing callers.
const LATE_LABEL_EXTRA_GRACE_MS = 120_000;

/**
 * Strictly parse an SPR (grid-in) entry. Accepts an integer or decimal
 * ("12", "-3.5", ".75", "-.5") or a fraction with a non-zero denominator
 * ("26/2", "-1/3"). Anything else ("35abc", "4/0", "263 264", "1 1/2",
 * "1,000") is NOT a number, so it can never match a numeric key.
 */
export function parseStrictNumber(answer: string | null | undefined): number | null {
  return parseSprEntry(answer);
}

/** Back-compat: canonical text form (fractions reduced to a decimal). */
export function normalizeAnswer(answer: string | null | undefined): string {
  const n = parseStrictNumber(answer);
  if (n != null && /\//.test(canonical(answer))) {
    return String(Math.round(n * 10000) / 10000);
  }
  return canonical(answer);
}

/** The acceptable answers listed in one correct_answer (see answersMatch). */
export function answerCandidates(correct: string | null | undefined): string[] {
  return keyCandidates(correct);
}

const NUMBER_SHAPED = /^[-\d.,\s/]+$/;

// A correct_answer may list SEVERAL acceptable answers separated by a
// newline, "|", ";", ", " or the word "or" (e.g. "5 or -13",
// "214/3, 71.33"). The student is correct if their answer matches ANY
// candidate. Numeric candidates follow the official College Board fill-in
// rules (lib/answer-key sprEntryCreditedForCandidate): the exact value in
// any form, or — when it doesn't fit — the truncated/rounded decimal that
// fills all 5 spaces; a rounding instruction in `questionText` ("nearest
// tenth") replaces that with the rounded value. Non-numeric candidates (MC
// letters) compare as case-insensitive text.
export function answersMatch(
  student: string | null | undefined,
  correct: string | null | undefined,
  questionText?: string | null,
): boolean {
  if (!correct) return false;
  const candidates = answerCandidates(correct);
  if (candidates.length === 0) return false;
  const sText = canonical(student);
  if (!sText) return false;
  for (const cand of candidates) {
    const numeric = sprEntryCreditedForCandidate(student, cand, questionText);
    if (numeric === true) return true;
    if (numeric === false) continue;
    // Text comparison covers MC letters and non-numeric keys (e.g.
    // "67/\sqrt{133}"). A number-shaped key that didn't parse (e.g. "4/0")
    // must never match by text.
    const cText = canonical(cand);
    if (!NUMBER_SHAPED.test(cText) && sText === cText) return true;
  }
  return false;
}

export interface FinalizeSubmissionInput {
  submissionId: string;
  /** Pre-loaded submission row. */
  submission: {
    id: string;
    test_id: string;
    answers: Record<string, string> | null;
    started_at: string;
    module_id: string | null;
    adaptive_track: string | null;
    /** Needed for Module 2's real start (metadata.module_2_started_at). */
    metadata?: unknown;
  };
  /** Pre-loaded test row. */
  test: {
    id: string;
    module_id: string | null;
    question_ids: string[] | null;
    /** A test with a Module 2 keeps question_ids per module. */
    module_2_id: string | null;
    is_adaptive: boolean | null;
    due_date: string | null;
    time_limit_minutes?: number | null;
    time_limit_minutes_module_2?: number | null;
    is_untimed?: boolean | null;
  };
  /** Override status when the caller knows the deadline rule
   *  (cron sets "Late" when past due_date; submit infers it). */
  forcedStatus?: "Submitted" | "Late";
  /** Mark "Late" when finalized after the module deadline (limit +
   *  grace). The student submit path sets this. */
  enforceTimeLimit?: boolean;
  /** Grade these answers (and persist them) instead of submission.answers. */
  answersOverride?: Record<string, string>;
  /** Extra columns written in the same claiming UPDATE (e.g. metadata). */
  extraUpdates?: Record<string, unknown>;
  /** Cron closing a Module 2 that was never opened: no time was spent, and
   *  metadata.auto_closed_unopened marks it so analytics can skip it. */
  autoClosedUnopened?: boolean;
  db: SupabaseClient;
}

export interface FinalizeSubmissionResult {
  status: "Submitted" | "Late";
  correctCount: number;
  totalQuestions: number;
  percentage: number;
  scaledScore: number | null;
  scaledSection: string | null;
  timeSpentSeconds: number;
}

/**
 * Grade + flip the submission to a final state. The single grading path
 * for student submit, the cron finalizer and admin force-submit.
 *
 * Claim-then-write: the status flip is a conditional UPDATE (still
 * "In Progress"), so when two finalizers overlap (student submit vs cron,
 * client retry, admin force-submit) exactly one wins. Returns null for
 * the loser. answer_records are written only by the winner; if that
 * insert fails the claim is rolled back so a retry can grade again.
 */
export async function finalizeSubmission(
  input: FinalizeSubmissionInput,
): Promise<FinalizeSubmissionResult | null> {
  const { submissionId, submission, test, db } = input;
  const gradingModuleId = submission.module_id ?? test.module_id;
  if (!gradingModuleId) {
    throw new Error("Submission has no grading module");
  }

  const { data: gradingModule } = await db
    .from("modules")
    .select("section")
    .eq("id", gradingModuleId)
    .maybeSingle();
  const moduleSection = (gradingModule?.section as string | null) ?? null;

  const now = new Date();
  const startedAt = new Date(moduleStartedAtIso(submission) ?? submission.started_at);
  const timeSpentSeconds = input.autoClosedUnopened
    ? 0
    : Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));

  // Past due only counts when the exam was STARTED after the due date. A
  // student who began on time and finishes within the module time limit is
  // not Late, even if an admin moves the due date earlier mid-exam (Barry,
  // 2026-10-28). The exam start is the earliest module of the session, so
  // Module 2 inherits Module 1's start. Untimed modules have no limit to
  // bound "on time", so they keep the plain due-date rule.
  let isPastDue = Boolean(test.due_date && new Date(test.due_date) < now);
  if (isPastDue && moduleDeadlineMs(submission, test, now.getTime()) != null) {
    const due = new Date(test.due_date as string).getTime();
    const { data: row } = await db
      .from("submissions")
      .select("session_id")
      .eq("id", submissionId)
      .maybeSingle();
    let examStart = new Date(submission.started_at).getTime();
    if (row?.session_id) {
      const { data: first } = await db
        .from("submissions")
        .select("started_at")
        .eq("session_id", row.session_id)
        .order("started_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (first?.started_at) examStart = Math.min(examStart, new Date(first.started_at).getTime());
    }
    // Full-length SAT: the exam is the whole attempt (R&W started it), so
    // Math isn't Late just because it began after the due date.
    const flStart = fullLengthStartedAtMs(submission.metadata);
    if (flStart != null) examStart = Math.min(examStart, flStart);
    isPastDue = examStart >= due;
  }
  // A Module 2 that only exists because recovery created it after the due
  // date (lib/module2-handoff, 24 h window) is Late. Nothing else about
  // Module 2 timing makes it Late: a normal handoff of an on-time exam
  // stays on time even if the due date passed meanwhile.
  // A full-length attempt that started before the due date is exempt: the
  // window it was allowed in belongs to the whole attempt.
  const flStartMs = fullLengthStartedAtMs(submission.metadata);
  const flStartedOnTime =
    flStartMs != null && !!test.due_date && flStartMs < new Date(test.due_date).getTime();
  if (
    isModule2Track(submission.adaptive_track) &&
    ((submission.metadata ?? {}) as Record<string, unknown>).created_after_due === true &&
    !flStartedOnTime
  ) {
    isPastDue = true;
  }
  let isOverTime = false;
  if (input.enforceTimeLimit) {
    const deadline = moduleDeadlineMs(submission, test, now.getTime());
    // Extra slack before labelling Late: an on-time auto-submit can spend
    // ~60s in client retries on a bad network.
    isOverTime = deadline != null && now.getTime() > deadline + LATE_LABEL_EXTRA_GRACE_MS;
  }
  const finalStatus: "Submitted" | "Late" =
    input.forcedStatus ?? (isPastDue || isOverTime ? "Late" : "Submitted");

  // Grade exactly the set the student was shown (Approved only).
  const questionQuery = scopeToStudentQuestionSet(
    db
      .from("questions")
      .select("id, correct_answer, question_type, question_text, original_question_number"),
    test,
    gradingModuleId,
  ).order("original_question_number", { ascending: true });
  const { data: questions, error: qErr } = await questionQuery;
  if (qErr || !questions) {
    throw new Error(`fetch questions: ${qErr?.message ?? "unknown"}`);
  }

  const answers = (input.answersOverride ?? submission.answers ?? {}) as Record<string, string>;
  const totalQuestions = questions.length;
  // Real per-question time when the take page recorded it (submit folds the
  // final copy into extraUpdates.metadata); older attempts had none, so they
  // keep the even split of the module time.
  const finalMeta = ((input.extraUpdates?.metadata ?? submission.metadata) ?? {}) as Record<string, unknown>;
  const activity = parseActivity(finalMeta.question_activity);
  const hasActivity = Object.keys(activity).length > 0;

  const answerRecords = questions.map((q) => {
    const studentAnswer = answers[q.id] ?? null;
    const isCorrect = answersMatch(studentAnswer, q.correct_answer, q.question_text as string | null);
    return {
      submission_id: submissionId,
      question_id: q.id,
      student_answer: studentAnswer,
      correct_answer: q.correct_answer ?? null,
      is_correct: isCorrect,
      time_spent_seconds: hasActivity
        ? Math.round((activity[q.id]?.t ?? 0) / 1000)
        : totalQuestions > 0
          ? Math.floor(timeSpentSeconds / totalQuestions)
          : 0,
    };
  });

  const correctCount = answerRecords.filter((r) => r.is_correct).length;
  const percentage =
    totalQuestions > 0
      ? Math.round((correctCount / totalQuestions) * 100 * 10) / 10
      : 0;
  const scaledScore = totalQuestions > 0 ? scaleSectionScore(percentage) : null;

  const updates: Record<string, unknown> = {
    ...(input.extraUpdates ?? {}),
    status: finalStatus,
    submitted_at: now.toISOString(),
    score: correctCount,
    correct_count: correctCount,
    total_questions: totalQuestions,
    percentage,
    scaled_score: scaledScore,
    scaled_section: moduleSection,
    time_spent_seconds: timeSpentSeconds,
  };
  if (input.answersOverride) updates.answers = input.answersOverride;
  if (input.autoClosedUnopened) {
    updates.metadata = {
      ...((updates.metadata ?? submission.metadata ?? {}) as Record<string, unknown>),
      auto_closed_unopened: true,
    };
  }

  const { data: claimed, error: upErr } = await db
    .from("submissions")
    .update(updates)
    .eq("id", submissionId)
    .eq("status", "In Progress")
    .select("id");
  if (upErr) throw new Error(`update submission: ${upErr.message}`);
  if (!claimed || claimed.length === 0) return null;

  // We own the row now. Clear any records left by an earlier attempt
  // that rolled back, then write the fresh batch.
  await db.from("answer_records").delete().eq("submission_id", submissionId);
  if (answerRecords.length > 0) {
    const { error: arErr } = await db.from("answer_records").insert(answerRecords);
    if (arErr) {
      await db
        .from("submissions")
        .update({ status: "In Progress", submitted_at: null })
        .eq("id", submissionId);
      throw new Error(`insert answer_records: ${arErr.message}`);
    }
  }

  return {
    status: finalStatus,
    correctCount,
    totalQuestions,
    percentage,
    scaledScore,
    scaledSection: moduleSection,
    timeSpentSeconds,
  };
}
