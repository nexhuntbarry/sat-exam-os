// lib/spot-check.ts
//
// Random spot-check of the automatic decisions (Premier 2026-11-07, item 7 and
// Question Bank item 2): nobody can audit ~1,700 system-approved questions, so
// a random 5–10% sample is re-checked independently (lib/verify-ai-key.ts
// runChecks: code solve, plug-back, second solve — never shown the key) and
// the result is shown as "Spot-checked 120 · 2 wrong (1.7%)". When the error
// rate goes up, the system stops approving on its own (lib/review-auto.ts).
//
// Results are kept durably in app_settings, one row per checked question
// ("spot_check:<question id>" → { outcome, at, key }), so the error rate (and
// a pause) can't vanish when someone later edits the question's notes. The
// question also gets a note:
//   passed → "Spot-check passed (<checks summary>, <date>)"
//   wrong  → the usual verify-ai-key disagreement note with a
//            "[spot-check <date> fp:…]" tag, so the question shows up in the
//            Review Queue's key group with its evidence (live questions stay
//            Approved with a [live-fix] note).
// scripts/spot-check-auto-approved.ts runs it (AI calls: dry run prints the
// sample and a cost estimate from ai_usage_log).

import type { SupabaseClient } from "@supabase/supabase-js";

export const SPOT_CHECK_PASS_PREFIX = "Spot-check passed";
export const SPOT_CHECK_TAG = "[spot-check";

/** Sample share of the system-approved questions. */
export const SPOT_CHECK_RATE = 0.05;
export const SPOT_CHECK_MIN = 20;
/** Auto-approval pauses above this error rate (once enough are checked). */
export const PAUSE_ERROR_RATE = 0.05;
export const PAUSE_MIN_CHECKED = 20;

export function spotCheckPassNote(summary: string, date: string): string {
  return `${SPOT_CHECK_PASS_PREFIX} (${summary.replace(/[;()[\]]/g, " ").replace(/\s+/g, " ").trim()}, ${date})`;
}

export interface SpotCheckStats {
  /** Approved without a person (reviewed_by is null). */
  system: number;
  /** Approved by a person. */
  person: number;
  checked: number;
  wrong: number;
  /** wrong / checked (null before any check). */
  rate: number | null;
  /** How many a 5% sample is (at least SPOT_CHECK_MIN). */
  sampleTarget: number;
  /** Auto-approval is paused (error rate above the limit). */
  paused: boolean;
}

export function pausedFor(checked: number, wrong: number): boolean {
  return checked >= PAUSE_MIN_CHECKED && wrong / checked > PAUSE_ERROR_RATE;
}

export function spotCheckLine(s: Pick<SpotCheckStats, "checked" | "wrong" | "rate" | "sampleTarget"> & { error?: string | null }): string {
  if (s.error) return "Spot-check results couldn't be read — automatic decisions are paused";
  if (s.checked === 0) return `Spot-check: not run yet (sample of ${s.sampleTarget})`;
  return `Spot-checked ${s.checked} · ${s.wrong} wrong (${((s.rate ?? 0) * 100).toFixed(1)}%)`;
}

export const SPOT_CHECK_RESULT_PREFIX = "spot_check:";

export interface SpotCheckResult {
  outcome: "passed" | "wrong";
  at: string;
  key: string | null;
}

/** Record one result durably (app_settings). Throws on a write error. */
export async function recordSpotCheck(db: SupabaseClient, questionId: string, result: SpotCheckResult): Promise<void> {
  const { error } = await db
    .from("app_settings")
    .upsert({ key: `${SPOT_CHECK_RESULT_PREFIX}${questionId}`, value: result, updated_at: new Date().toISOString() });
  if (error) throw new Error(`spot-check result not saved: ${error.message}`);
}

/** Every recorded result (question id → result). Throws on a read error. */
export async function loadSpotCheckResults(db: SupabaseClient): Promise<Map<string, SpotCheckResult>> {
  const out = new Map<string, SpotCheckResult>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("app_settings")
      .select("key, value")
      .like("key", `${SPOT_CHECK_RESULT_PREFIX}%`)
      .order("key")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.set((r.key as string).slice(SPOT_CHECK_RESULT_PREFIX.length), r.value as SpotCheckResult);
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Counts for the Question Bank / Review Queue. Fails closed: if the results
 * can't be read, `paused` is true (no automatic decision runs blind) and
 * `error` says why.
 */
export async function spotCheckStats(db: SupabaseClient): Promise<SpotCheckStats & { error: string | null }> {
  const head = () => db.from("questions").select("id", { count: "exact", head: true });
  try {
    const [sys, per, results] = await Promise.all([
      head().eq("parsing_status", "Approved").is("reviewed_by", null),
      head().eq("parsing_status", "Approved").not("reviewed_by", "is", null),
      loadSpotCheckResults(db),
    ]);
    if (sys.error || per.error) throw new Error((sys.error ?? per.error)!.message);
    const system = sys.count ?? 0;
    const all = [...results.values()];
    const w = all.filter((r) => r.outcome === "wrong").length;
    const checked = all.length;
    return {
      system,
      person: per.count ?? 0,
      checked,
      wrong: w,
      rate: checked ? w / checked : null,
      sampleTarget: Math.max(SPOT_CHECK_MIN, Math.ceil(system * SPOT_CHECK_RATE)),
      paused: pausedFor(checked, w),
      error: null,
    };
  } catch (e) {
    return { system: 0, person: 0, checked: 0, wrong: 0, rate: null, sampleTarget: SPOT_CHECK_MIN, paused: true, error: e instanceof Error ? e.message : String(e) };
  }
}
