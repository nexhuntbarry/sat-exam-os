// lib/rescore.ts
//
// Re-grade already-submitted work after an answer key changes.
//
// When an admin edits a question's correct_answer, submissions taken
// before the edit keep the is_correct / score they were given at submit
// time (answer_records snapshot the key). rescoreQuestion fixes that:
// it re-evaluates every answer_record for the question against the new
// key, then recomputes the affected submissions' scores. This keeps score
// reports truthful after a key correction.

import type { SupabaseClient } from "@supabase/supabase-js";
import { answersMatch } from "@/lib/grade-submission";
import { scaleSectionScore } from "@/lib/scoring";
import { fetchAllRows } from "@/lib/fetch-all-rows";

/**
 * Score columns for a submission from its graded records — the same math
 * rescoreQuestion writes. Pure, so read-only reports (e.g.
 * scripts/audit-spr-rescore-impact.ts) can preview a rescore.
 */
export function scoreFromRecords(records: { is_correct: boolean | null }[]): {
  correctCount: number;
  total: number;
  percentage: number;
  scaledScore: number;
} | null {
  const total = records.length;
  if (total === 0) return null;
  const correctCount = records.filter((x) => x.is_correct).length;
  const percentage = Math.round((correctCount / total) * 100 * 10) / 10;
  return { correctCount, total, percentage, scaledScore: scaleSectionScore(percentage) };
}

export interface RescoreResult {
  questionId: string;
  recordsUpdated: number;
  submissionsRescored: number;
}

/**
 * Re-grade all answer_records for one question against its CURRENT
 * correct_answer, then recompute every affected submission's score.
 * Safe to call repeatedly (idempotent given a fixed key).
 */
export async function rescoreQuestion(
  db: SupabaseClient,
  questionId: string,
): Promise<RescoreResult> {
  // Current (post-edit) key.
  const { data: q } = await db
    .from("questions")
    .select("id, correct_answer, question_text")
    .eq("id", questionId)
    .maybeSingle();
  if (!q) return { questionId, recordsUpdated: 0, submissionsRescored: 0 };
  const newKey = (q.correct_answer as string | null) ?? null;

  // Every graded record for this question.
  const { data: records } = await fetchAllRows<{
    id: string;
    submission_id: string;
    student_answer: string | null;
    correct_answer: string | null;
    is_correct: boolean | null;
  }>((from, to) =>
    db
      .from("answer_records")
      .select("id, submission_id, student_answer, correct_answer, is_correct")
      .eq("question_id", questionId)
      .order("id")
      .range(from, to),
  );
  const rows = records ?? [];
  if (rows.length === 0) {
    return { questionId, recordsUpdated: 0, submissionsRescored: 0 };
  }

  // Re-evaluate; collect records whose correctness or stored key changed.
  const affectedSubmissions = new Set<string>();
  let recordsUpdated = 0;
  for (const r of rows) {
    const nowCorrect = answersMatch(r.student_answer as string | null, newKey, (q.question_text as string | null) ?? null);
    const keyChanged = (r.correct_answer as string | null) !== newKey;
    if (nowCorrect !== r.is_correct || keyChanged) {
      const { error } = await db
        .from("answer_records")
        .update({ correct_answer: newKey, is_correct: nowCorrect })
        .eq("id", r.id);
      if (!error) {
        recordsUpdated++;
        affectedSubmissions.add(r.submission_id as string);
      }
    }
  }

  // Recompute each affected submission from its full record set.
  let submissionsRescored = 0;
  for (const submissionId of affectedSubmissions) {
    const { data: subRecords } = await db
      .from("answer_records")
      .select("is_correct")
      .eq("submission_id", submissionId);
    const score = scoreFromRecords(subRecords ?? []);
    if (!score) continue;
    const { correctCount, total, percentage, scaledScore } = score;
    const { error } = await db
      .from("submissions")
      .update({
        score: correctCount,
        correct_count: correctCount,
        total_questions: total,
        percentage,
        scaled_score: scaledScore,
      })
      .eq("id", submissionId);
    if (!error) submissionsRescored++;
  }

  return { questionId, recordsUpdated, submissionsRescored };
}
