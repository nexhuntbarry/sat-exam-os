// lib/grade-submission.ts
//
// Shared grading helper so both the interactive submit route
// (`POST /api/student/submissions/[id]/submit`) and the background
// cron auto-finalizer (and admin force-submit) use identical scoring +
// answer-record logic.
// Any change in scoring should live here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleSectionScore } from "@/lib/scoring";
import {
  moduleDeadlineMs,
  moduleStartedAtIso,
  scopeToStudentQuestionSet,
} from "@/lib/student-exam";

// Hyphen look-alikes students paste or type on some keyboards (U+2212
// minus sign, figure/en/em dashes, small and fullwidth hyphen-minus).
const MINUS_LOOKALIKES = /[\u2012\u2013\u2014\u2212\uFE63\uFF0D]/g;

function canonical(answer: string | null | undefined): string {
  if (answer == null) return "";
  return String(answer)
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

const DECIMAL = /^-?\d+(\.\d+)?$/;
const LEADING_DOT = /^-?\.\d+$/;
// Thousands separators only in the proper 1,000 / 24,000.5 shape.
const THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const FRACTION = /^(-?\d+)\s*\/\s*(\d+)$/;

/**
 * Strictly parse an SPR (grid-in) value. Accepts an integer or decimal
 * ("12", "-3.5", ".75", "-.5"), a fraction with a non-zero denominator
 * ("26/2", "-1/3"), or a correctly grouped thousands value ("1,000").
 * Anything else ("35abc", "4/0", "263 264", "1 1/2") is NOT a number,
 * so it can never match a numeric key.
 */
const LATE_LABEL_EXTRA_GRACE_MS = 120_000;

export function parseStrictNumber(answer: string | null | undefined): number | null {
  const s = canonical(answer);
  if (!s) return null;
  if (DECIMAL.test(s) || LEADING_DOT.test(s)) return Number(s);
  if (THOUSANDS.test(s)) return Number(s.replace(/,/g, ""));
  const f = s.match(FRACTION);
  if (f) {
    const den = Number(f[2]);
    if (den === 0) return null;
    return Number(f[1]) / den;
  }
  return null;
}

const NUMBER_SHAPED = /^[-\d.,\s/]+$/;

/** Can v be entered exactly in the SAT grid (5 chars, 6 with a minus)? */
function fitsGridExactly(v: number): boolean {
  for (let d = 0; d <= 4; d++) {
    const str = Math.abs(v).toFixed(d).replace(/^0\./, ".");
    if (str.length <= 5 && Math.abs(Number(str) - Math.abs(v)) < 1e-9) return true;
  }
  return false;
}

/**
 * SAT grid-in rule for answers with more digits than the 5-character
 * space holds (e.g. 2/3, 1/7): a decimal that FILLS the space and is the
 * value rounded or truncated is correct (2/3 → .6666, .6667, 0.666,
 * 0.667; but not 0.67). Only applies when the exact value doesn't fit.
 */
function satDecimalMatch(studentText: string, v: number): boolean {
  const m = studentText.match(/^-?(\d*)\.(\d+)$/);
  if (!m) return false;
  if ((v < 0) !== studentText.startsWith("-")) return false;
  if (studentText.replace(/^-/, "").length !== 5) return false;
  if (fitsGridExactly(v)) return false;
  const d = m[2].length;
  const scale = 10 ** d;
  const s = Math.abs(Number(studentText));
  const a = Math.abs(v);
  const trunc = Math.trunc(a * scale) / scale;
  const round = Math.round(a * scale) / scale;
  return Math.abs(s - trunc) < 1e-9 || Math.abs(s - round) < 1e-9;
}

/** Back-compat: canonical text form (fractions reduced to a decimal). */
export function normalizeAnswer(answer: string | null | undefined): string {
  const n = parseStrictNumber(answer);
  if (n != null && FRACTION.test(canonical(answer))) {
    return String(Math.round(n * 10000) / 10000);
  }
  return canonical(answer);
}

// A correct_answer may list SEVERAL acceptable answers separated by a
// newline, "|", ";", ", " or the word "or" (e.g. "5 or -13",
// "214/3, 71.33"). The student is correct if their answer matches ANY
// candidate. Numeric candidates compare numerically (tolerance 1e-4)
// against a STRICTLY parsed student value; non-numeric candidates (MC
// letters) compare as case-insensitive text.
export function answersMatch(
  student: string | null | undefined,
  correct: string | null | undefined,
): boolean {
  if (!correct) return false;
  // Split on newline, "|", ";", the word "or", a comma followed by
  // whitespace, or a comma BETWEEN non-digits — so a thousands separator
  // like "1,000" stays intact.
  const candidates = String(correct)
    .split(/\s*(?:\bor\b|[\n;|])\s*|,\s+|(?<=\D),(?=\D)/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (candidates.length === 0) return false;
  const sText = canonical(student);
  if (!sText) return false;
  const sNum = parseStrictNumber(student);
  for (const cand of candidates) {
    const cNum = parseStrictNumber(cand);
    if (cNum != null) {
      if (sNum != null && Math.abs(sNum - cNum) < 0.0001) return true;
      if (sNum != null && satDecimalMatch(sText, cNum)) return true;
      continue;
    }
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
  const timeSpentSeconds = Math.max(
    0,
    Math.floor((now.getTime() - startedAt.getTime()) / 1000),
  );

  const isPastDue = Boolean(test.due_date && new Date(test.due_date) < now);
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
      .select("id, correct_answer, question_type, original_question_number")
      .eq("module_id", gradingModuleId),
    test,
  ).order("original_question_number", { ascending: true });
  const { data: questions, error: qErr } = await questionQuery;
  if (qErr || !questions) {
    throw new Error(`fetch questions: ${qErr?.message ?? "unknown"}`);
  }

  const answers = (input.answersOverride ?? submission.answers ?? {}) as Record<string, string>;
  const totalQuestions = questions.length;

  const answerRecords = questions.map((q) => {
    const studentAnswer = answers[q.id] ?? null;
    const isCorrect = answersMatch(studentAnswer, q.correct_answer);
    return {
      submission_id: submissionId,
      question_id: q.id,
      student_answer: studentAnswer,
      correct_answer: q.correct_answer ?? null,
      is_correct: isCorrect,
      time_spent_seconds:
        totalQuestions > 0 ? Math.floor(timeSpentSeconds / totalQuestions) : 0,
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
