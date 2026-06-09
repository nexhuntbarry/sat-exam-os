// lib/auto-promote.ts
//
// Bulk-promote Draft questions whose AI confidence score is at or
// above a threshold to Approved. Same logic as
// scripts/auto-promote-high-confidence.ts but factored out so the
// parse route can call it automatically at the tail of every new
// module parse — no more "I uploaded the module but the test only
// has 2 questions" because nothing got approved.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface AutoPromoteSummary {
  candidates: number;
  promoted: number;
  skipped: number;
}

/**
 * Promote every Draft row in this module whose ai_confidence_score
 * >= threshold AND has a non-empty correct_answer AND (if has_image
 * is true) has at least one image_urls entry AND (if MCQ) carries a
 * non-empty choices array. Returns counts.
 *
 * Designed to be called from the parse route right after
 * runPostParseCleanup. Failures are swallowed by the caller — this
 * is a best-effort convenience, not a hard requirement.
 */
export async function autoPromoteModule(
  moduleId: string,
  db: SupabaseClient,
  threshold = 0.9,
): Promise<AutoPromoteSummary> {
  const { data: candidates, error } = await db
    .from("questions")
    .select(
      "id, ai_confidence_score, correct_answer, has_image, image_urls, question_type, choices",
    )
    .eq("module_id", moduleId)
    .eq("parsing_status", "Draft")
    .gte("ai_confidence_score", threshold);
  if (error) {
    throw new Error(`autoPromote select: ${error.message}`);
  }
  const promotable = (candidates ?? []).filter((row) => {
    const hasAnswer =
      row.correct_answer != null && String(row.correct_answer).trim() !== "";
    if (!hasAnswer) return false;
    const blindImage =
      row.has_image === true &&
      (!Array.isArray(row.image_urls) || row.image_urls.length === 0);
    if (blindImage) return false;
    if (row.question_type === "Multiple Choice") {
      const choices = Array.isArray(row.choices) ? row.choices : [];
      if (choices.length === 0) return false;
    }
    return true;
  });

  if (promotable.length === 0) {
    return {
      candidates: candidates?.length ?? 0,
      promoted: 0,
      skipped: (candidates ?? []).length,
    };
  }

  const now = new Date().toISOString();
  const CHUNK = 100;
  let promoted = 0;
  for (let i = 0; i < promotable.length; i += CHUNK) {
    const ids = promotable.slice(i, i + CHUNK).map((r) => r.id as string);
    const { error: upErr } = await db
      .from("questions")
      .update({
        parsing_status: "Approved",
        reviewed_at: now,
        updated_at: now,
      })
      .in("id", ids);
    if (!upErr) promoted += ids.length;
  }
  return {
    candidates: candidates?.length ?? 0,
    promoted,
    skipped: (candidates ?? []).length - promoted,
  };
}
