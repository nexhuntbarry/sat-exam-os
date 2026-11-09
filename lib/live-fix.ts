// lib/live-fix.ts
//
// "Fixed in a live test · re-check" as a Review Queue group (Premier
// 2026-11-07, Question Bank item 3): questions changed while students are
// taking the test stay Approved with a leading "[live-fix]" note. The queue
// shows them first, before / after, with one "Confirm" and an "Undo".
//
// The version before the change is kept in app_settings under
// "live_fix_before:<question id>" (no schema change): written by the review
// queue / key-change paths when they change a live question, and backfilled
// for older live fixes from the local .omc/backups by
// scripts/backfill-live-fix-snapshots.ts. Only the FIRST unconfirmed version
// is kept, so Undo goes back to what students saw before any unchecked change.

import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE_FIX_TAG, stripLiveFixNote } from "@/lib/live-questions";

export const LIVE_FIX_SNAPSHOT_PREFIX = "live_fix_before:";

export const SNAPSHOT_FIELDS = ["question_text", "choices", "correct_answer", "explanation", "image_urls", "image_alts", "has_image", "question_type"] as const;
export type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];

export interface LiveFixSnapshot {
  /** When the earlier version was captured. */
  at: string;
  /** What captured it (review queue, key change, backfill file). */
  source: string;
  fields: Partial<Record<SnapshotField, unknown>>;
  /**
   * The leading "[live-fix] …" text the change wrote. The snapshot belongs
   * to that change only: once the row's live-fix text differs (confirmed
   * elsewhere, or another tool tagged it), the snapshot is ignored.
   */
  tag?: string;
}

export const LIVE_FIX_CONFIRMED_PREFIX = "Live-fix confirmed by";
export const LIVE_FIX_UNDONE_PREFIX = "Live-fix undone by";

/** Every leading "[live-fix] …" sentence removed (a row can carry several). */
export function stripAllLiveFix(notes: string | null | undefined): string | null {
  let cur = notes ?? null;
  for (let i = 0; i < 6 && cur && cur.startsWith(LIVE_FIX_TAG); i++) cur = stripLiveFixNote(cur);
  return cur?.trim() ? cur.trim() : null;
}

/** The leading "[live-fix] …" text as stored (null when the row has none). */
export function liveFixHead(notes: string | null | undefined): string | null {
  const n = (notes ?? "").trim();
  if (!n.startsWith(LIVE_FIX_TAG)) return null;
  const rest = stripAllLiveFix(n);
  return (rest ? n.slice(0, n.lastIndexOf(rest)) : n).replace(/\s+/g, " ").trim() || null;
}

/** Does this snapshot belong to the row's current live-fix change? */
export function snapshotValid(snap: LiveFixSnapshot | null | undefined, notes: string | null | undefined): snap is LiveFixSnapshot {
  const head = liveFixHead(notes);
  return !!snap && !!snap.tag && !!head && snap.tag.replace(/\s+/g, " ").trim() === head;
}

/** The leading "[live-fix] …" sentences, without the tag (what changed, in the tool's words). */
export function liveFixWhat(notes: string | null | undefined): string | null {
  const n = (notes ?? "").trim();
  if (!n.startsWith(LIVE_FIX_TAG)) return null;
  const rest = stripAllLiveFix(n);
  const head = (rest ? n.slice(0, n.lastIndexOf(rest)) : n).trim();
  return head
    .split(LIVE_FIX_TAG)
    .map((s) => s.replace(/;?\s*kept (?:Approved|Needs Review)\s*—\s*please re-check\.?/i, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

const norm = (v: unknown): string => JSON.stringify(v ?? null);

export function pickSnapshotFields(row: Record<string, unknown>): Partial<Record<SnapshotField, unknown>> {
  const out: Partial<Record<SnapshotField, unknown>> = {};
  for (const f of SNAPSHOT_FIELDS) if (f in row) out[f] = row[f];
  return out;
}

/** Fields whose value differs between the snapshot and the row now. */
export function changedFields(snap: LiveFixSnapshot | null, row: Record<string, unknown>): SnapshotField[] {
  if (!snap) return [];
  return SNAPSHOT_FIELDS.filter((f) => f in snap.fields && norm(snap.fields[f]) !== norm(row[f]));
}

export async function loadLiveFixSnapshots(db: SupabaseClient, ids: string[]): Promise<Map<string, LiveFixSnapshot>> {
  const out = new Map<string, LiveFixSnapshot>();
  for (let i = 0; i < ids.length; i += 100) {
    const keys = ids.slice(i, i + 100).map((id) => `${LIVE_FIX_SNAPSHOT_PREFIX}${id}`);
    const { data, error } = await db.from("app_settings").select("key, value").in("key", keys);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.set((r.key as string).slice(LIVE_FIX_SNAPSHOT_PREFIX.length), r.value as LiveFixSnapshot);
  }
  return out;
}

/**
 * Keep the version of a live question from before an unchecked change.
 * `afterNotes` are the notes the change writes (their leading [live-fix]
 * text binds the snapshot to this change). A snapshot that still belongs to
 * the row's current unconfirmed change is kept (Undo goes back to before the
 * FIRST unconfirmed change) and re-bound to the new text; anything else is
 * replaced. Best-effort: a failure here never blocks the fix itself.
 */
export async function saveLiveFixSnapshot(
  db: SupabaseClient,
  before: Record<string, unknown> & { id: string; parsing_notes?: string | null },
  source: string,
  afterNotes: string | null | undefined,
): Promise<boolean> {
  try {
    const key = `${LIVE_FIX_SNAPSHOT_PREFIX}${before.id}`;
    const tag = liveFixHead(afterNotes) ?? undefined;
    const { data } = await db.from("app_settings").select("key, value").eq("key", key).maybeSingle();
    const existing = (data?.value as LiveFixSnapshot | undefined) ?? null;
    const value: LiveFixSnapshot = snapshotValid(existing, before.parsing_notes)
      ? { ...existing, tag }
      : { at: new Date().toISOString(), source, fields: pickSnapshotFields(before), tag };
    const { error } = await db.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
    return !error;
  } catch {
    return false;
  }
}

export async function clearLiveFixSnapshot(db: SupabaseClient, id: string): Promise<void> {
  await db.from("app_settings").delete().eq("key", `${LIVE_FIX_SNAPSHOT_PREFIX}${id}`);
}
