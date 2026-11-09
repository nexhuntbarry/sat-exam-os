// lib/content-hash.ts
//
// Fingerprint of a question's text + choices, stored in verify-ai-key and
// spot-check notes ("[verify-ai-key 2026-11-09 fp:1a2b3c4d]") so evidence
// computed for an older version of the question is never acted on
// automatically (review 2026-11-09, H1). Pure, client-safe.

/**
 * Fingerprint of the question as it was solved (stem + choice texts), stored
 * in the verify-ai-key note ("[verify-ai-key 2026-11-09 fp:1a2b3c4d]").
 * Evidence whose fingerprint differs from the row now was computed for an
 * older text (re-extracted, edited, replaced from the PDF) and is never acted
 * on automatically. FNV-1a 32-bit, pure (client-safe).
 */
export function contentHash(r: { question_text?: string | null; choices?: unknown }): string {
  const choices = Array.isArray(r.choices) ? (r.choices as { label?: string; text?: string }[]).map((c) => `${c?.label ?? ""}:${c?.text ?? ""}`).join("|") : "";
  const src = `${(r.question_text ?? "").replace(/\s+/g, " ").trim()}#${choices.replace(/\s+/g, " ").trim()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The fingerprint stored in a verify-ai-key / spot-check tag (null = none, an older note). */
export function noteStemHash(segment: string): string | null {
  return segment.match(/\[(?:verify-ai-key|spot-check) [^\]]*\b(?:fp|stem):([0-9a-f]{8})\]/)?.[1] ?? null;
}

