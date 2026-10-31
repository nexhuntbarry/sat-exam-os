// lib/live-questions.ts
//
// Guard for automatic tools (repair buttons, post-parse cleanup, AI solve,
// audits) touching a question that students are taking right now.
//
// Students only see and are graded on Approved questions
// (lib/student-exam.ts), so demoting a question that's in a live test
// silently pulls it out of the running exam. For those questions the
// tools may still fix content, but the status stays Approved, the answer
// key is never changed, and parsing_notes gets a "[live-fix]" tag so a
// person re-checks it. Human status buttons are not guarded.

import type { SupabaseClient } from "@supabase/supabase-js";
import { STUDENT_VISIBLE_QUESTION_STATUS } from "@/lib/student-exam";

export const LIVE_FIX_TAG = "[live-fix]";

const CHUNK = 200;

interface LiveTest {
  id: string;
  is_adaptive: boolean | null;
  module_id: string | null;
  module_1_id: string | null;
  module_2_id: string | null;
  module_2_easy_id: string | null;
  module_2_hard_id: string | null;
  question_ids: string[] | null;
}

/**
 * Which of `ids` are in a live test: a Published test that is assigned to
 * at least one student or class, and whose student question set (same
 * rules as scopeToStudentQuestionSet) includes the question.
 */
export async function liveQuestionIds(
  db: SupabaseClient,
  ids: string[],
): Promise<Set<string>> {
  const live = new Set<string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return live;

  const { data: tests, error: tErr } = await db
    .from("tests")
    .select("id, is_adaptive, module_id, module_1_id, module_2_id, module_2_easy_id, module_2_hard_id, question_ids")
    .eq("status", "Published");
  if (tErr) throw new Error(`liveQuestionIds tests: ${tErr.message}`);
  if (!tests || tests.length === 0) return live;

  const { data: assignments, error: aErr } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids")
    .in("test_id", tests.map((t) => t.id));
  if (aErr) throw new Error(`liveQuestionIds assignments: ${aErr.message}`);
  const assigned = new Set(
    (assignments ?? [])
      .filter(
        (a) =>
          ((a.student_ids as string[] | null) ?? []).length > 0 ||
          ((a.class_group_ids as string[] | null) ?? []).length > 0,
      )
      .map((a) => a.test_id as string),
  );
  const liveTests = (tests as LiveTest[]).filter((t) => assigned.has(t.id));
  if (liveTests.length === 0) return live;

  const moduleOf = new Map<string, string | null>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { data, error } = await db
      .from("questions")
      .select("id, module_id")
      .in("id", unique.slice(i, i + CHUNK));
    if (error) throw new Error(`liveQuestionIds questions: ${error.message}`);
    for (const q of data ?? []) moduleOf.set(q.id as string, q.module_id as string | null);
  }

  for (const id of unique) {
    const moduleId = moduleOf.get(id) ?? null;
    for (const t of liveTests) {
      const qids = Array.isArray(t.question_ids) ? t.question_ids : [];
      if (qids.includes(id)) {
        live.add(id);
        break;
      }
      const modules = [t.module_id, t.module_1_id, t.module_2_id, t.module_2_easy_id, t.module_2_hard_id];
      if (!moduleId || !modules.includes(moduleId)) continue;
      // Legacy single-module tests with a question_ids subset only show
      // that subset (mirrors scopeToStudentQuestionSet).
      if (!t.is_adaptive && qids.length > 0) continue;
      live.add(id);
      break;
    }
  }
  return live;
}

export interface LiveHoldRow {
  id: string;
  parsing_status: string | null;
  parsing_notes?: string | null;
  correct_answer?: string | null;
}

export interface LiveHoldResult {
  update: Record<string, unknown>;
  held: boolean;
}

/** Drop a leading "[live-fix] …" sentence (used when a person approves). */
export function stripLiveFixNote(notes: string | null | undefined): string | null {
  if (!notes || !notes.startsWith(LIVE_FIX_TAG)) return notes ?? null;
  const rest = notes.replace(/^\[live-fix\][^\n]*?re-check\.\s*/, "");
  const out = rest !== notes ? rest : notes.replace(/^\[live-fix\][^.]*\.?\s*/, "");
  return out.trim() || null;
}

/**
 * Pure version of holdLiveDemotion for batch callers that already have the
 * row's current state and a liveQuestionIds() set.
 */
export function applyLiveHold(
  row: LiveHoldRow,
  update: Record<string, unknown>,
  reason: string,
  live: Set<string>,
): LiveHoldResult {
  if (row.parsing_status !== STUDENT_VISIBLE_QUESTION_STATUS || !live.has(row.id)) {
    return { update, held: false };
  }
  const demotes =
    typeof update.parsing_status === "string" &&
    update.parsing_status !== STUDENT_VISIBLE_QUESTION_STATUS;
  const changesAnswer =
    "correct_answer" in update &&
    (row.correct_answer === undefined || update.correct_answer !== row.correct_answer);
  if (!demotes && !changesAnswer) return { update, held: false };

  const next = { ...update };
  delete next.parsing_status;
  // It stays Approved, so keep who approved it.
  delete next.reviewed_at;
  delete next.reviewed_by;
  let answerNote = "";
  if (changesAnswer) {
    // The new explanation argues the suggested answer, so it goes too.
    delete next.correct_answer;
    delete next.explanation;
    answerNote = ` Suggested answer "${String(update.correct_answer ?? "")}" was not applied.`;
  }
  const tag = `${LIVE_FIX_TAG} ${reason} while this question is in a live test; kept Approved — please re-check.${answerNote} `;
  const base =
    typeof update.parsing_notes === "string" ? update.parsing_notes : row.parsing_notes ?? "";
  next.parsing_notes = `${tag}${stripLiveFixNote(base) ?? ""}`.trim();
  return { update: next, held: true };
}

/**
 * Single-question guard: if `update` would move a live, Approved question
 * off Approved (or change its answer), strip that from the update and tag
 * parsing_notes instead. Reads only; the caller writes `update`.
 */
export async function holdLiveDemotion(
  db: SupabaseClient,
  questionId: string,
  update: Record<string, unknown>,
  reason: string,
): Promise<LiveHoldResult> {
  const demotes =
    typeof update.parsing_status === "string" &&
    update.parsing_status !== STUDENT_VISIBLE_QUESTION_STATUS;
  if (!demotes && !("correct_answer" in update)) return { update, held: false };
  const { data: row } = await db
    .from("questions")
    .select("id, parsing_status, parsing_notes, correct_answer")
    .eq("id", questionId)
    .maybeSingle();
  if (!row || row.parsing_status !== STUDENT_VISIBLE_QUESTION_STATUS) return { update, held: false };
  const live = await liveQuestionIds(db, [questionId]);
  return applyLiveHold(row as LiveHoldRow, update, reason, live);
}
