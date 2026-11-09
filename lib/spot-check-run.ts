// lib/spot-check-run.ts
//
// Runs the random spot-check (lib/spot-check.ts) on a sample of
// system-approved questions: shared by scripts/spot-check-auto-approved.ts
// and the daily cron /api/cron/spot-check (Barry approved 2026-11-09,
// about $2 a week).
//
// Each question is re-solved independently (lib/verify-ai-key.ts runChecks:
// code solve + plug-back + second solve, or two R&W solves — never shown the
// key; ~3 AI calls). Then:
//   passed       → "Spot-check passed (…)" note + durable result
//   wrong        → both solves agree with each other on another answer:
//                  verify-ai-key disagreement note tagged [spot-check DATE fp:…]
//                  + durable result. Live-test safety: the live status is
//                  re-checked right before the write (a failed lookup counts
//                  as live); a live question is never demoted — it stays
//                  Approved with a [live-fix] note. Otherwise → Needs Review.
//   inconclusive → nothing written, not counted.

import type { SupabaseClient } from "@supabase/supabase-js";
import { SPR_TYPE } from "@/lib/answer-key";
import { liveQuestionIds, LIVE_FIX_TAG } from "@/lib/live-questions";
import { aiKeyDisagreeNote, checksSummary, contentHash, runChecks, sameKey, solvesAgree, VERIFY_SELECT, type VerifyRow } from "@/lib/verify-ai-key";
import { loadSpotCheckResults, recordSpotCheck, spotCheckPassNote, spotCheckStats, SPOT_CHECK_TAG, SPOT_CHECK_RESULT_PREFIX } from "@/lib/spot-check";

export type SpotCheckOutcome = "passed" | "wrong" | "inconclusive" | "error";

export interface SpotCheckLine {
  id: string;
  number: number | null;
  outcome: SpotCheckOutcome;
  live: boolean;
  detail: string;
}

/** Hard cap on questions per cron run (≈ 3 AI calls each). */
export const SPOT_CHECK_CRON_MAX = 13;

/** Monday of the current week (UTC), for the weekly quota. */
export function weekStart(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

/** The system-approved questions never spot-checked, in random order. */
export async function spotCheckPool(db: SupabaseClient): Promise<VerifyRow[]> {
  const pool: VerifyRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("questions")
      .select(VERIFY_SELECT)
      .eq("parsing_status", "Approved")
      .is("reviewed_by", null)
      .not("correct_answer", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    pool.push(...((data ?? []) as VerifyRow[]));
    if (!data || data.length < 1000) break;
  }
  const done = await loadSpotCheckResults(db);
  const unchecked = pool.filter((r) => !done.has(r.id));
  for (let i = unchecked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unchecked[i], unchecked[j]] = [unchecked[j], unchecked[i]];
  }
  return unchecked;
}

/** Check one question and write the result (AI calls). */
export async function spotCheckOne(db: SupabaseClient, r: VerifyRow): Promise<SpotCheckLine> {
  const key = (r.correct_answer ?? "").trim();
  const isMc = r.question_type !== SPR_TYPE;
  const date = new Date().toISOString().slice(0, 10);
  const line = (outcome: SpotCheckOutcome, live: boolean, detail: string): SpotCheckLine => ({ id: r.id, number: r.original_question_number, outcome, live, detail });
  const ch = await runChecks(r);
  const summary = checksSummary(ch, key);
  const a = ch.first;
  const b = ch.second;
  let outcome: "passed" | "wrong";
  if (a?.answer && b?.answer && sameKey(a.answer, key, isMc, r.question_text) && sameKey(b.answer, key, isMc, r.question_text) && ch.plugBack?.status !== "fail") {
    outcome = "passed";
  } else if (a?.answer && b?.answer && solvesAgree(a, b, isMc, r.question_text) && !sameKey(a.answer, key, isMc, r.question_text)) {
    outcome = "wrong";
  } else {
    return line("inconclusive", false, summary);
  }
  // Live status right before the write; a failed lookup counts as live.
  const live = (await liveQuestionIds(db, [r.id]).catch(() => new Set([r.id]))).has(r.id);
  let notes: string;
  let status: string | undefined;
  if (outcome === "passed") {
    notes = [r.parsing_notes, spotCheckPassNote(summary, date)].filter(Boolean).join("; ");
  } else {
    const note = aiKeyDisagreeNote({ key, ai: a!.answer!, value: null, detail: `${summary} ${SPOT_CHECK_TAG} ${date} fp:${contentHash(r)}]` });
    const body = [r.parsing_notes, note].filter(Boolean).join("; ");
    if (live) {
      // Never demoted: stays Approved, a person re-checks it.
      notes = body.startsWith(LIVE_FIX_TAG) ? body : `${LIVE_FIX_TAG} Spot-check disagrees with the key while this question is in a live test; kept Approved — please re-check. ${body}`;
    } else {
      notes = body;
      status = "Needs Review";
    }
  }
  // The result is recorded durably first (the error rate must not depend on notes).
  try {
    await recordSpotCheck(db, r.id, { outcome, at: new Date().toISOString(), key });
  } catch (e) {
    return line("error", live, `result not saved: ${e instanceof Error ? e.message : e}`);
  }
  const { data: written, error } = await db
    .from("questions")
    .update({ parsing_notes: notes, ...(status ? { parsing_status: status } : {}), updated_at: new Date().toISOString() })
    .eq("id", r.id)
    .eq("updated_at", r.updated_at as string)
    .eq("parsing_status", "Approved")
    .select("id");
  if (error || !written?.length) {
    // A "wrong" result whose flag never reached the question would leave it
    // Approved, unflagged, and excluded from future samples. Drop the record
    // so the question goes back into the pool and is re-checked next run.
    if (outcome === "wrong") {
      await db.from("app_settings").delete().eq("key", `${SPOT_CHECK_RESULT_PREFIX}${r.id}`);
    }
    return line(outcome, live, `${summary} — note not written: ${error?.message ?? "row changed since it was read"}${outcome === "wrong" ? " (result dropped; will be re-sampled)" : ""}`);
  }
  return line(outcome, live, summary);
}

export interface SpotCheckBatchResult {
  /** Questions checked this run. */
  lines: SpotCheckLine[];
  /** This week's quota (5% of system-approved, at least 20) and what's done. */
  weeklyTarget: number;
  doneThisWeek: number;
  stoppedBy: "quota" | "cap" | "deadline" | "pool" | null;
}

/**
 * One batch: at most `max` questions (hard cap), never more than what is
 * left of this week's quota, `concurrency` at a time, no new question after
 * `deadline`.
 */
export async function runSpotCheckBatch(
  db: SupabaseClient,
  opts: { max: number; deadline?: number; concurrency?: number },
): Promise<SpotCheckBatchResult> {
  const stats = await spotCheckStats(db);
  if (stats.error) throw new Error(`spot-check results unreadable: ${stats.error}`);
  const since = weekStart().getTime();
  const results = await loadSpotCheckResults(db);
  const doneThisWeek = [...results.values()].filter((r) => Date.parse(r.at) >= since).length;
  const left = Math.max(0, stats.sampleTarget - doneThisWeek);
  const max = Math.max(0, Math.min(opts.max, left));
  const out: SpotCheckBatchResult = { lines: [], weeklyTarget: stats.sampleTarget, doneThisWeek, stoppedBy: null };
  if (max === 0) return { ...out, stoppedBy: "quota" };
  const pool = await spotCheckPool(db);
  const sample = pool.slice(0, max);
  let next = 0;
  let stoppedByDeadline = false;
  const worker = async () => {
    for (;;) {
      if (opts.deadline && Date.now() > opts.deadline) {
        stoppedByDeadline = true;
        return;
      }
      const r = sample[next++];
      if (!r) return;
      try {
        out.lines.push(await spotCheckOne(db, r));
      } catch (e) {
        out.lines.push({ id: r.id, number: r.original_question_number, outcome: "error", live: false, detail: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker));
  out.doneThisWeek = doneThisWeek + out.lines.filter((l) => l.outcome === "passed" || l.outcome === "wrong").length;
  out.stoppedBy = stoppedByDeadline ? "deadline" : sample.length < max ? "pool" : max < opts.max ? "quota" : "cap";
  return out;
}

/** Cron ?max= → per-run cap. Missing/empty/invalid → the full cap; never above it. */
export function cronMaxParam(raw: string | null): number {
  const asked = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(asked) && asked >= 0 ? Math.min(asked, SPOT_CHECK_CRON_MAX) : SPOT_CHECK_CRON_MAX;
}
