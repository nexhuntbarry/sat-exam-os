// lib/answer-key-merge.ts
//
// Combines a module's answer key with the ✓ marks read deterministically off
// the PDF's text layer. Who wins depends on where the key came from:
//
//   - "upload": a person typed or uploaded the key. It is authoritative; a
//     disagreeing ✓ only sends the question to Needs Review.
//   - "probe": the AI answer-key probe (extractAnswerKey) read the key off the
//     same PDF. On printouts where question n−1's choices B–D carry over to
//     the top of the next page, it gives question n the ✓ of question n−1
//     (Tests #9, #22, #23, #2 — .omc/reports/key-shift-scan-2026-11-14.md).
//     The ✓ read from the text layer wins wherever there is one; the
//     disagreement is left as a note. No ✓ for a question → the probe stands.
//
// Pure functions, no I/O: the parse route and the re-parse-in-place cron both
// go through mergeTicksIntoKey so they can't drift apart.

import {
  isTextLayerReliable,
  lookupPdfTextQuestion,
  type ChoiceLabel,
  type LabelTick,
  type PdfTextChoices,
} from "@/lib/pdf-text-choices";

export type AnswerKeySource = "upload" | "probe";

/**
 * The parse request's key source. Only an explicit "upload" makes the key
 * authoritative; anything else (including clients from before the flag
 * existed, which only ever sent the probe's key) is treated as the probe.
 */
export function answerKeySourceOf(v: unknown): AnswerKeySource {
  return v === "upload" ? "upload" : "probe";
}

export interface TickMerge {
  /** The key to use: `key` with the ✓ marks merged in. */
  key: Record<number, string>;
  /** Question → Needs Review note (an uploaded key disagrees with the ✓). */
  conflicts: Map<number, string>;
  /** Question → informational note (the probe disagreed; the ✓ was used). */
  notes: Map<number, string>;
  /** How many probe answers the ✓ replaced. */
  overrides: number;
}

export const uploadConflictNote = (key: string, tick: string) =>
  `Needs review: the uploaded answer key says ${key} but the source PDF ticks ${tick} — confirm which is right`;
export const probeOverrideNote = (key: string, tick: string) =>
  `Answer key: probe said ${key}, PDF ticks ${tick}; used the PDF tick`;

/**
 * Merge deterministic ✓ marks (question number → A–D) into `key`.
 * - no key entry → the ✓ fills it (either source);
 * - key agrees → unchanged;
 * - key disagrees → "upload" keeps the key and records a conflict;
 *   "probe" takes an A–D ✓ and records a note (a fill-in answer only fills
 *   gaps, it never replaces the probe's);
 * - no ✓ for a question → the key's answer stands.
 * `key` is not mutated.
 */
export function mergeTicksIntoKey(
  key: Record<number, string> | null,
  ticks: Map<number, string>,
  source: AnswerKeySource,
): TickMerge {
  const out: Record<number, string> = { ...(key ?? {}) };
  const conflicts = new Map<number, string>();
  const notes = new Map<number, string>();
  let overrides = 0;
  for (const [n, rawTick] of ticks) {
    const tick = rawTick.trim().toUpperCase();
    if (!tick) continue;
    const k = out[n]?.trim();
    if (!k) {
      out[n] = rawTick.trim();
      continue;
    }
    if (k.toUpperCase() === tick) continue;
    if (source === "upload") {
      conflicts.set(n, uploadConflictNote(k, tick));
    } else if (!/^[A-D]$/.test(tick)) {
      // A fill-in answer read off a printout's answer box only fills gaps: the
      // probe may list accepted forms ("3/4, .75") the box shows one of.
      continue;
    } else {
      out[n] = tick;
      notes.set(n, probeOverrideNote(k, tick));
      overrides++;
    }
  }
  return { key: out, conflicts, notes, overrides };
}

/**
 * ✓ marks per stored question number from the two text-layer readers.
 * extractChoicesFromPdfText's ✓ is used first (only when its walk is reliable
 * and most questions carry a ✓, so a stray glyph can't pose as a key); the
 * label-only reader (image choices — Math printouts) fills in only questions
 * the first has no ✓ for, under the same "most questions ticked" rule.
 */
export function deterministicTicks(
  numbers: number[],
  pdfText: PdfTextChoices | null,
  labelTicks: { byNumber: Map<number, LabelTick> } | null,
): Map<number, ChoiceLabel> {
  const ticks = new Map<number, ChoiceLabel>();
  if (pdfText && isTextLayerReliable(pdfText, numbers.length)) {
    const marked = [...pdfText.byNumber.values()].filter((t) => t.checked).length;
    if (marked >= Math.ceil(pdfText.byNumber.size * 0.5)) {
      for (const n of numbers) {
        const c = lookupPdfTextQuestion(pdfText, n)?.checked;
        if (c) ticks.set(n, c);
      }
    }
  }
  if (labelTicks && labelTicks.byNumber.size >= Math.ceil(numbers.length * 0.4)) {
    const marked = [...labelTicks.byNumber.values()].filter((t) => t.checked).length;
    if (marked >= Math.ceil(labelTicks.byNumber.size * 0.5)) {
      for (const n of numbers) {
        if (ticks.has(n)) continue;
        const c = lookupPdfTextQuestion(labelTicks, n)?.checked;
        if (c) ticks.set(n, c);
      }
    }
  }
  return ticks;
}
