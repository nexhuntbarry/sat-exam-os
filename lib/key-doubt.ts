// "AI thinks the answer key may be wrong" — written by the semantic audit
// when its own solve disagrees with correct_answer. The note starts with
// "Needs review:" so every automatic approve path (explain-official,
// repair-ops, consensus) already treats it as a blocking defect: only an
// admin approving (or fixing the key) clears it. Barry, 2026-11-02.

import { LIVE_FIX_TAG, stripLiveFixNote } from "@/lib/live-questions";

export const KEY_DOUBT_PREFIX = "Needs review: AI thinks the answer key may be wrong";

/** One parsing_notes segment (no ";" inside, notes are ";"-separated). */
export function keyDoubtNote(stored: string, suggested: string, reason: string): string {
  const clean = (s: string) => s.replace(/;/g, ",").replace(/\s+/g, " ").trim();
  return `${KEY_DOUBT_PREFIX} (stored ${clean(stored)}, AI suggests ${clean(suggested)}) — ${clean(reason).replace(/\.$/, "")}. Check the official answer before approving.`;
}

export function hasKeyDoubt(notes: string | null | undefined): boolean {
  return (notes ?? "").includes(KEY_DOUBT_PREFIX);
}

export function parseKeyDoubt(
  notes: string | null | undefined,
): { stored: string; suggested: string; reason: string } | null {
  const m = (notes ?? "").match(
    /AI thinks the answer key may be wrong \(stored (.+?), AI suggests (.+?)\) — (.+?)\. Check the official answer before approving\./,
  );
  return m ? { stored: m[1], suggested: m[2], reason: m[3] } : null;
}

/** Drop key-doubt segments (re-audit replaces them; a human approve clears them). */
export function stripKeyDoubtNote(notes: string | null | undefined): string {
  return (notes ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith(KEY_DOUBT_PREFIX))
    .join("; ");
}

/** A person approved the row: drop the live-test re-check tag and any key doubt. */
export function clearReviewTags(notes: string | null | undefined): string | null {
  return stripKeyDoubtNote(stripLiveFixNote(notes)) || null;
}

export function hasReviewTags(notes: string | null | undefined): boolean {
  return (notes ?? "").startsWith(LIVE_FIX_TAG) || hasKeyDoubt(notes);
}
