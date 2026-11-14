// lib/answer-key-merge.ts
//
// Combines a module's answer key with the ✓ marks read deterministically off
// the PDF. Who wins depends on where the key came from:
//
//   - "upload": a person typed or uploaded the key. It is authoritative; a
//     disagreeing ✓ only sends the question to Needs Review.
//   - "probe": the AI answer-key probe (extractAnswerKey) read the key off the
//     same PDF. On printouts where question n−1's choices B–D carry over to
//     the top of the next page, it gives question n the ✓ of question n−1
//     (Tests #9, #22, #23, #2 — .omc/reports/key-shift-scan-2026-11-14.md).
//     A ✓ replaces the probe's answer silently only on strong evidence for
//     that question: exactly one ✓, a multiple-choice question, and (when the
//     text reader bound the choices) choice text that matches the parsed
//     choices. Any other disagreement goes to Needs Review with both values.
//     No ✓ for a question → the probe stands.
//   - Keys already stored in the database (re-parse in place) are treated
//     like an upload: never changed by a ✓ or the probe, only flagged.
//
// Pure functions, no I/O: the parse route and the re-parse-in-place cron both
// go through here so they can't drift apart.

import {
  diffChoices,
  isTextLayerReliable,
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

/** One question's answer as read off the PDF without AI. */
export interface TickEvidence {
  /** A–D for a ✓; a fill-in answer when read from a printout's answer box. */
  tick: string;
  /** Strong enough to replace the AI probe's answer without a person. */
  strong: boolean;
  /** Why it isn't strong (shown in the Needs Review note). */
  why?: string;
}

const MC = "Multiple Choice";
const LETTER = /^[A-D]$/;
const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export const PROBE_OVERRIDE_PREFIX = "Answer key: probe said";
export const uploadConflictNote = (key: string, tick: string) =>
  `Needs review: the uploaded answer key says ${key} but the source PDF ticks ${tick} — confirm which is right`;
export const probeOverrideNote = (key: string, tick: string) =>
  `${PROBE_OVERRIDE_PREFIX} ${key}, PDF ticks ${tick}; used the PDF tick`;
export const probeConflictNote = (key: string, tick: string, why?: string) =>
  `Needs review: probe said ${key}, PDF ticks ${tick} — confirm which is right${why ? ` (${why})` : ""}`;
export const storedConflictNote = (stored: string, tick: string) =>
  `Needs review: the stored key says ${stored} but the source PDF ticks ${tick} — confirm which is right`;
export const storedProbeConflictNote = (stored: string, probe: string) =>
  `Needs review: the stored key says ${stored} but the answer key read from the PDF says ${probe} — confirm which is right`;

/** A letter ✓ on a question known not to be multiple choice is meaningless. */
function tickApplies(tick: string, type: string | null | undefined): boolean {
  return !!tick && !(LETTER.test(tick.toUpperCase()) && type != null && type !== MC);
}

interface Decision {
  key: string;
  conflict?: string;
  note?: string;
  override?: boolean;
}

/** The rule for one question. null = the ✓ is ignored (key unchanged, no note). */
function decide(
  k: string | undefined,
  ev: TickEvidence,
  source: AnswerKeySource,
  type: string | null | undefined,
): Decision | null {
  const tick = ev.tick.trim();
  if (!tickApplies(tick, type)) return null;
  const key = k?.trim();
  if (!key) return { key: tick };
  if (same(key, tick)) return null;
  const T = tick.toUpperCase();
  if (source === "upload") return { key, conflict: uploadConflictNote(key, T) };
  // A fill-in answer read off a printout's answer box only fills gaps: the
  // probe may list accepted forms ("3/4, .75") the box shows one of.
  if (!LETTER.test(T)) return null;
  if (ev.strong && type === MC) return { key: T, note: probeOverrideNote(key, T), override: true };
  const why = ev.why ?? (type == null ? "question type unknown" : undefined);
  return { key, conflict: probeConflictNote(key, T, why) };
}

export interface TickMerge {
  /** The key to use: `key` with the PDF's answers merged in. */
  key: Record<number, string>;
  /** Question → Needs Review note (key kept). */
  conflicts: Map<number, string>;
  /** Question → informational note (the probe's answer was replaced by a strong ✓). */
  notes: Map<number, string>;
  /** How many probe answers a ✓ replaced. */
  overrides: number;
}

/**
 * Merge the PDF's answers into `key` (not mutated):
 * - no key entry → the PDF's answer fills it (either source);
 * - key agrees → unchanged;
 * - "upload" disagrees → key kept, Needs Review;
 * - "probe" disagrees → a strong ✓ on a multiple-choice question replaces it
 *   (with a note); anything weaker → key kept, Needs Review with both values;
 *   a fill-in answer never replaces the probe's;
 * - a letter ✓ on a non-multiple-choice question is ignored;
 * - no ✓ for a question → the key's answer stands.
 */
export function mergeTicksIntoKey(
  key: Record<number, string> | null,
  ticks: Map<number, TickEvidence>,
  source: AnswerKeySource,
  types?: Map<number, string | null>,
): TickMerge {
  const out: Record<number, string> = { ...(key ?? {}) };
  const conflicts = new Map<number, string>();
  const notes = new Map<number, string>();
  let overrides = 0;
  for (const [n, ev] of ticks) {
    const d = decide(out[n], ev, source, types?.get(n));
    if (!d) continue;
    out[n] = d.key;
    if (d.conflict) conflicts.set(n, d.conflict);
    if (d.note) notes.set(n, d.note);
    if (d.override) overrides++;
  }
  return { key: out, conflicts, notes, overrides };
}

export interface ReparseKeyDecision {
  /** official_answer to write. */
  official: string | null;
  /** correct_answer to write (the stored key is kept when there is one). */
  seed: string | null;
  /** Needs Review notes; non-empty → the row waits for a person (no promote, no rescore). */
  review: string[];
  /** Informational note (the probe's answer was replaced by a strong ✓). */
  note: string | null;
}

/**
 * Re-parse in place, one question. A key already stored on the row
 * (official_answer, else correct_answer) is never changed: a ✓ or this run's
 * probe that disagrees only sends the row to Needs Review. A row with no
 * stored key takes this run's probe under probe rules (mergeTicksIntoKey).
 */
export function reparseKeyDecision(
  row: { storedOfficial: string | null; storedCorrect: string | null; probe: string | null; type: string | null },
  ev: TickEvidence | undefined,
): ReparseKeyDecision {
  const stored = row.storedOfficial?.trim() || row.storedCorrect?.trim() || null;
  const probe = row.probe?.trim() || null;
  const tick = ev && tickApplies(ev.tick.trim(), row.type) ? ev.tick.trim() : null;
  if (stored) {
    const review: string[] = [];
    if (tick && !same(stored, tick)) review.push(storedConflictNote(stored, tick.toUpperCase()));
    if (probe && !same(stored, probe)) review.push(storedProbeConflictNote(stored, probe));
    const confirmed = (probe && same(probe, stored)) || (tick && same(tick, stored));
    return { official: row.storedOfficial?.trim() || (confirmed ? stored : null), seed: stored, review, note: null };
  }
  const d = ev ? decide(probe ?? undefined, ev, "probe", row.type) : null;
  const key = d?.key ?? probe;
  return { official: key, seed: key, review: d?.conflict ? [d.conflict] : [], note: d?.note ?? null };
}

export interface TickQuestion {
  /** Stored (1..N) question number. */
  n: number;
  question_type: string | null;
  choices: unknown;
}

/**
 * The PDF's ✓ per stored question number, from the two text-layer readers,
 * with how strong each is. `offset` is the caller's renumbering offset
 * (printed number = stored + offset); a reader whose numbers fall outside
 * offset+1 … offset+max is not used at all (`notes` says why) — the offset is
 * never guessed from what a reader happened to read.
 *
 * extractChoicesFromPdfText's ✓ is used first, when its walk is reliable
 * (≥ 60% of questions bound) and ≥ 50% of what it bound is ticked; the
 * label-only reader (image choices — Math printouts) fills only the gaps,
 * when it bound ≥ 40% of the questions and ≥ 50% of those are ticked.
 * A question with more than one ✓ gets none.
 */
export function deterministicTicks(
  questions: TickQuestion[],
  pdfText: PdfTextChoices | null,
  labelTicks: { byNumber: Map<number, LabelTick> } | null,
  offset: number,
): { ticks: Map<number, TickEvidence & { source: "text-choices" | "label-only" }>; notes: string[] } {
  const ticks = new Map<number, TickEvidence & { source: "text-choices" | "label-only" }>();
  const notes: string[] = [];
  if (questions.length === 0) return { ticks, notes };
  const maxN = Math.max(...questions.map((q) => q.n));
  const fits = (name: string, nums: number[]) => {
    if (nums.length === 0) return true;
    const lo = Math.min(...nums), hi = Math.max(...nums);
    if (lo >= offset + 1 && hi <= offset + maxN) return true;
    notes.push(`${name} ✓ not used: it read questions ${lo}–${hi} but this module's are ${offset + 1}–${offset + maxN}`);
    return false;
  };
  const mainFits = !!pdfText && fits("PDF text", [...pdfText.byNumber.keys()]);
  const labelFits = !!labelTicks && fits("label-only", [...labelTicks.byNumber.keys()]);
  const main = mainFits ? pdfText : null;
  const mainOk =
    !!main &&
    isTextLayerReliable(main, questions.length) &&
    [...main.byNumber.values()].filter((t) => t.checked).length >= Math.ceil(main.byNumber.size * 0.5);
  const label = labelFits ? labelTicks : null;
  const labelOk =
    !!label &&
    label.byNumber.size >= Math.ceil(questions.length * 0.4) &&
    [...label.byNumber.values()].filter((t) => t.checked).length >= Math.ceil(label.byNumber.size * 0.5);

  for (const q of questions) {
    const tq = main?.byNumber.get(q.n + offset) ?? null;
    if (tq?.multi) continue;
    const lt = label?.byNumber.get(q.n + offset) ?? null;
    let tick: string | null = null;
    let source: "text-choices" | "label-only" = "text-choices";
    if (mainOk && tq?.checked) tick = tq.checked;
    else if (labelOk && lt?.checked) {
      tick = lt.checked;
      source = "label-only";
    }
    if (!tick) continue;
    const isMc = q.question_type === MC;
    // Choices the text reader bound must be this question's parsed choices.
    const aligned = !tq || diffChoices(q.choices, tq.choices).diffs.length === 0;
    const why = !isMc
      ? q.question_type == null ? "question type unknown" : "not a multiple-choice question"
      : !aligned ? "the parsed choices don't match the PDF's" : undefined;
    ticks.set(q.n, { tick, strong: isMc && aligned, why, source });
  }
  return { ticks, notes };
}
