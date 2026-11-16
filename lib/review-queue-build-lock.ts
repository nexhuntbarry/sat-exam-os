// lib/review-queue-build-lock.ts
//
// Cross-instance build lock for the review-queue index (data.ts).
//
// Problem: after cache invalidation each Vercel instance independently detects
// a stale index and launches buildQueueIndex() via after(). With N concurrent
// heavy rebuilds the DB is saturated and buildCards() latency spikes.
//
// Protocol (compare-and-swap on app_settings):
//   tryBuildLock  – claim the lock by writing a fresh token; skip if another
//                   instance holds an unexpired one (23505 / row still fresh).
//   releaseBuildLock – backdate updated_at to epoch so the NEXT tryBuildLock
//                   sees the row as expired immediately. Only the holder that
//                   wrote the token may release; a slow build that already timed
//                   out and let another instance re-claim cannot clobber it.
//
// The lock is intentionally NOT held forever: it expires after BUILD_TIMEOUT_MS
// so a crashed build never blocks future refreshes. releaseBuildLock is an
// optimistic fast-path; expiry is the safety net.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Backdating updated_at to epoch makes the row look immediately expired. */
const EPOCH = new Date(0).toISOString();

/**
 * Try to atomically claim the build lock at `key` in app_settings.
 * Returns a holder token (UUID string) on success, or null if another
 * instance holds an unexpired lock.
 * Non-fatal: a DB error returns a token and lets the build proceed
 * (a double-build is cheaper than a stall).
 */
export async function tryBuildLock(
  db: SupabaseClient,
  key: string,
  timeoutMs: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const now = new Date().toISOString();
  try {
    // Claim if the lock row is absent, or was last written before cutoff (expired).
    const { data: updated } = await db
      .from("app_settings")
      .update({ value: { token }, updated_at: now })
      .eq("key", key)
      .lt("updated_at", cutoff)
      .select("key");
    if (updated && updated.length > 0) return token;
    // Row absent → try to insert; row present and fresh → 23505.
    const { error } = await db
      .from("app_settings")
      .insert({ key, value: { token }, updated_at: now });
    if (!error) return token;
    if (error.code === "23505") return null; // Another instance holds the lock.
    return token; // Unknown DB error: proceed rather than stall.
  } catch {
    return token;
  }
}

/**
 * Release the build lock, but ONLY if this instance still holds it
 * (token matches). A slow build whose lock already expired and was
 * re-claimed by another instance must not release that holder's lock.
 * Backdates updated_at to epoch so the next tryBuildLock() succeeds
 * immediately — this is what lets a mid-build invalidation trigger a
 * fresh rebuild right after the current build finishes.
 */
export async function releaseBuildLock(
  db: SupabaseClient,
  key: string,
  token: string,
): Promise<void> {
  try {
    await db
      .from("app_settings")
      .update({ updated_at: EPOCH })
      .eq("key", key)
      .filter("value->token", "eq", JSON.stringify(token));
  } catch {
    // Non-fatal: the lock will expire naturally after timeoutMs.
  }
}
