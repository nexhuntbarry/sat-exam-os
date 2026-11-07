// lib/review-queue.ts
//
// One-decision review queue (owner-approved, 2026-11-07). Every Needs Review
// question is put in ONE group by the reason a person still has to look at
// it, derived from its parsing_notes plus the approve gate. Each group maps to
// the single decision the queue page asks for (key / stem / figure / …).
//
// Also holds the note clean-up shared by every key-change path (PATCH,
// resolve-mismatch, key-check apply, review queue): once the key changes, the
// consensus / semantic-audit / "stored X" notes about the OLD key are stale.
//
// Pure (no DB / AI calls), so it is unit-tested in scripts/test-review-queue.ts.

import {
  AUTO_FIX_NOTE_PREFIX,
  classifyNote,
  failingChecks,
  keyIsOfficial,
  splitNotes,
  type AutoFixRow,
  type NoteContext,
} from "@/lib/explanation-autofix";
import { findApproveBlocker, stemFigureMissing } from "@/lib/parse-guards";
import { KEY_DOUBT_PREFIX, parseKeyDoubt } from "@/lib/key-doubt";
import { LIVE_FIX_TAG, stripLiveFixNote } from "@/lib/live-questions";
import { REGEN_DISAGREE_PREFIX } from "@/lib/ai/solve-question";

// ── Groups ───────────────────────────────────────────────────────────

export type ReviewGroupId =
  | "key_dispute"
  | "module_key"
  | "key_format"
  | "ai_key"
  | "stem"
  | "figure"
  | "render"
  | "explanation"
  | "live_fix"
  | "other";

/** What the queue asks the person to decide for this group. */
export type DecisionKind = "key" | "key_format" | "stem" | "figure" | "render" | "explanation" | "approve";

export interface ReviewGroup {
  id: ReviewGroupId;
  label: string;
  /** One line under the heading: what to decide. */
  ask: string;
  decision: DecisionKind;
}

/** In priority order: a question sits in the first group it qualifies for. */
export const REVIEW_GROUPS: ReviewGroup[] = [
  { id: "key_dispute", label: "Answer key disputed", ask: "The AI (or the official key) gives a different answer. Pick the right key.", decision: "key" },
  { id: "module_key", label: "Module key may belong to another module", ask: "This module's key page disagrees with the solved answers. Confirm or change the key.", decision: "key" },
  { id: "key_format", label: "Key doesn't fit the question type", ask: "A letter key on a fill-in question, or similar. Fix the key or the type.", decision: "key_format" },
  { id: "ai_key", label: "AI-only key not verified", ask: "The key came from the AI solver. Confirm it or change it.", decision: "key" },
  { id: "stem", label: "Question text cut off or passage missing", ask: "Compare with the PDF. Re-extract the text or edit it.", decision: "stem" },
  { id: "figure", label: "Figure, table or choices to check", ask: "Compare the stored figure / table / choices with the PDF.", decision: "figure" },
  { id: "render", label: "Math or formatting doesn't render", ask: "Fix the broken math or formatting.", decision: "render" },
  { id: "explanation", label: "Explanation cut off or contradicts the key", ask: "Regenerate the explanation from the saved key.", decision: "explanation" },
  { id: "live_fix", label: "Live-test re-check", ask: "Changed while in a live test. Check it and approve.", decision: "approve" },
  { id: "other", label: "Other", ask: "Nothing specific is flagged. Check it and approve, or edit.", decision: "approve" },
];

export const GROUP_BY_ID = Object.fromEntries(REVIEW_GROUPS.map((g) => [g.id, g])) as Record<ReviewGroupId, ReviewGroup>;
const PRIORITY = REVIEW_GROUPS.map((g) => g.id);

// ── Key disagreement notes ───────────────────────────────────────────

// lib/verify-ai-key.ts (parser work, in progress elsewhere) will write notes
// like "Needs review: key says B, AI says C (51.12)" from a shared constant
// that doesn't exist yet. Parsed defensively here with our own regex so this
// file never depends on that module: optional "Needs review:" prefix, any
// case, the answers as letters or fill-in values, and an optional
// parenthesised reference after the AI's answer.
const KEY_SAYS_RE = /key says\s+(.+?),\s*AI says\s+(.+?)(?:\s*\(([^()]*)\))?\s*\.?\s*$/i;
const REGEN_DISAGREE_RE = /AI's own answer is (.+?) but the saved key is (.+?) —/;
const MISMATCH_RE = /^Mismatch:\s*AI answered\s+(.+?)\s*,\s*official\s+(.+?)\s*$/i;
const SELF_CONTRADICT_RE = /^Solver self-contradicted \(declared (.+?), explained (.+?)\)$/i;
const FIGURE_AUDIT_KEY_RE = /\(choice ([A-D])\),? but the key is ([A-D])\b/i;
const CONSENSUS_RE = /^Consensus solve NOT unanimous \(([^)]*)\)/i;

export interface KeyDispute {
  /** The answer the note says the AI (or the other source) gives. */
  alternative: string | null;
  /** Where the alternative comes from, for the label ("AI", "official key"…). */
  source: string;
  /** Extra reference printed after the AI's answer (e.g. "51.12"). */
  ref?: string | null;
}

/** The "other" answer this row's notes propose, best source first. */
export function parseKeyDispute(
  notes: string | null | undefined,
  key: string | null | undefined,
  official?: string | null,
): KeyDispute | null {
  const k = (key ?? "").trim();
  const differs = (a: string | null | undefined) => !!a && a.trim() !== "" && a.trim().toUpperCase() !== k.toUpperCase();
  const segs = noteSegments(notes);
  for (const s of segs) {
    const m = s.match(KEY_SAYS_RE);
    if (m && differs(m[2])) return { alternative: m[2].trim(), source: "AI", ref: m[3]?.trim() || null };
  }
  const doubt = parseKeyDoubt(segs.find((s) => s.includes(KEY_DOUBT_PREFIX)) ?? null);
  if (doubt && differs(doubt.suggested)) return { alternative: doubt.suggested.trim(), source: "AI audit" };
  for (const s of segs) {
    const m = s.match(REGEN_DISAGREE_RE);
    if (m && differs(m[1])) return { alternative: m[1].trim(), source: "AI" };
  }
  for (const s of segs) {
    const m = s.match(MISMATCH_RE);
    if (m) {
      if (differs(m[1])) return { alternative: m[1].trim(), source: "AI" };
      if (differs(m[2])) return { alternative: m[2].trim(), source: "official key" };
    }
  }
  if (differs(official)) return { alternative: official!.trim(), source: "official key" };
  for (const s of segs) {
    const m = s.match(FIGURE_AUDIT_KEY_RE);
    if (m && differs(m[1])) return { alternative: m[1].toUpperCase(), source: "figure audit" };
  }
  for (const s of segs) {
    const m = s.match(SELF_CONTRADICT_RE);
    if (m) {
      const alt = [m[2], m[1]].map((x) => x.trim()).find((x) => differs(x) && !/unparsed/i.test(x));
      if (alt) return { alternative: alt, source: "AI solver (other answer it reached)" };
    }
  }
  for (const s of segs) {
    const m = s.match(CONSENSUS_RE);
    if (m) {
      const alt = m[1].split("/").map((x) => x.trim()).find((x) => x !== "?" && differs(x));
      if (alt) return { alternative: alt, source: "AI consensus (one of the solves)" };
    }
  }
  return null;
}

// ── Notes ────────────────────────────────────────────────────────────

/**
 * parsing_notes segments: ";"-separated (outside brackets, splitNotes) and,
 * for a few older notes joined with a blank line, also split there.
 */
export function noteSegments(notes: string | null | undefined): string[] {
  return splitNotes(notes).flatMap((s) => s.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean));
}

const joinNotes = (segs: string[]): string | null => (segs.length ? segs.join("; ") : null);

/**
 * The leading "[live-fix] … re-check." sentence (null when there is none)
 * and the notes after it. The sentence itself contains a ";", so it is cut
 * off before the notes are split and put back unchanged afterwards.
 */
export function splitLiveFixNote(notes: string | null | undefined): { head: string | null; rest: string | null } {
  if (!notes || !notes.startsWith(LIVE_FIX_TAG)) return { head: null, rest: notes ?? null };
  const rest = stripLiveFixNote(notes);
  const head = (rest ? notes.slice(0, notes.lastIndexOf(rest)) : notes).trim();
  return { head: head || null, rest };
}

/** Remove the segments `drop` selects; keeps everything else (and the leading [live-fix] sentence) as-is. */
export function removeNotes(notes: string | null | undefined, drop: (seg: string) => boolean): { notes: string | null; removed: string[] } {
  const { head, rest } = splitLiveFixNote(notes);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const s of noteSegments(rest)) (drop(s) ? removed : kept).push(s);
  const body = joinNotes(kept);
  return { notes: head ? (body ? `${head} ${body}` : head) : body, removed };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A note that only makes sense for the OLD key (owner item 3): consensus /
 * solver / AI-key notes, key doubts, the semantic audit's verdict on the
 * key or explanation, "stored X" notes and explanation-fix history (the
 * explanation is rewritten for the new key). History of how the key was set
 * ("Key fix …", "[support …]", "Answer key check: …") and notes about the
 * stem / choices / figure stay.
 */
export function isStaleKeyNote(seg: string, oldKey: string | null | undefined): boolean {
  const s = seg.trim();
  if (s.startsWith(LIVE_FIX_TAG)) return false;
  if (s.startsWith(KEY_DOUBT_PREFIX) || s.startsWith(REGEN_DISAGREE_PREFIX)) return true;
  if (KEY_SAYS_RE.test(s) || MISMATCH_RE.test(s)) return true;
  if (/^Consensus solve\b|^Auto-settled:|^Answer & explanation generated by AI solver|^Answer & explanation verified|^Answer verified against official key|^Verified: explanation|^Solver self-contradicted|^stored the explained answer|^Answer = official key\b|^Explanation matches official answer$|^explanation matches \(verified\)$|^explanation rewritten to match|^explanation regenerated from the verified key|^Mismatch\b/i.test(s)) {
    return true;
  }
  if (s.startsWith(AUTO_FIX_NOTE_PREFIX)) return true;
  if (/^Needs review: the stored answer .* may be wrong/i.test(s)) return true;
  const sem = s.match(/^Semantic audit:\s*([\s\S]*)$/i);
  if (sem) {
    const body = sem[1].replace(/'[^']*'|"[^"]*"|“[^”]*”/g, "");
    const aboutKey = /correct[_ ]answer|stored (?:correct )?answer|\bkey\b|explanation|answer_explanation_ok|is correct|the answer is/i.test(body);
    const aboutContent = /\bstem\b|question text|passage|choices? (?:[A-D] )?(?:is|are|has|have) (?:empty|garbled|truncated|missing|blank)|all (?:four|4) (?:answer )?choices|figure|image|graph|table|garbled latex|stray dollar|raw latex|data-entry/i.test(body);
    return aboutKey && !aboutContent;
  }
  // "Pulled for review … but the key is B" (figure audit) about the old key.
  if (oldKey && /^Pulled for review/i.test(s) && new RegExp(`the key is ${esc(oldKey.trim())}\\b`, "i").test(s)) return true;
  return false;
}

/** Drop notes about the old key after a key change. Same notes when the key didn't change. */
export function dropStaleKeyNotes(
  notes: string | null | undefined,
  oldKey: string | null | undefined,
  newKey: string | null | undefined,
): { notes: string | null; removed: string[] } {
  if ((oldKey ?? "").trim() === (newKey ?? "").trim()) return { notes: notes?.trim() ? notes : null, removed: [] };
  return removeNotes(notes, (s) => isStaleKeyNote(s, oldKey));
}

/**
 * Notes a person settles by confirming the CURRENT key ("Keep key"): only
 * the ones that dispute or question it (the reasons for the key groups).
 * Verification and auto-fix history ("Answer verified against official
 * key", "Answer = official key", "Explanation auto-fixed …") stay.
 */
export function isKeyQuestionNote(seg: string, key: string | null | undefined): boolean {
  const s = seg.trim();
  if (s.startsWith(LIVE_FIX_TAG) || isHistoryNote(s)) return false;
  if (s.startsWith(KEY_DOUBT_PREFIX) || s.startsWith(REGEN_DISAGREE_PREFIX)) return true;
  if (KEY_SAYS_RE.test(s) || MISMATCH_RE.test(s)) return true;
  if (/answer key disagrees with the solved answer|key page may be for a different module|answer-key page in this PDF says Module|printed key|Pulled for review .*\bkey\b|differs from the official answer/i.test(s)) return true;
  // A semantic-audit verdict counts only when it is about the key (not the
  // stem / figure) AND disputes it.
  if (/^Semantic audit:/i.test(s) && !isStaleKeyNote(s, key)) return false;
  const rule = RULES.find(([, re]) => re.test(s));
  return !!rule && KEY_RULE_GROUPS.has(rule[0]);
}

const KEY_RULE_GROUPS = new Set<ReviewGroupId>(["key_dispute", "module_key", "ai_key"]);

// ── Figure / table / choices notes (owner item 1) ────────────────────

/** A note asking someone to compare the stored figure / table / choices with the PDF. */
export function isFigureNote(seg: string): boolean {
  return (
    /still needs review \(figure\/choices\)/i.test(seg) ||
    /^Image re-extracted by admin self-repair/i.test(seg) ||
    /^choices re-extracted from PDF\b/i.test(seg) ||
    /question has a Markdown table AND an image/i.test(seg) ||
    /^we could not confirm automatically whether the image is the same table/i.test(seg) ||
    /AI re-read of the source PDF .*gave different answer choices/i.test(seg) ||
    /Choice misalignment/i.test(seg) ||
    /^Needs review: choices copied from PDF text/i.test(seg) ||
    seg.startsWith(FIGURE_DIFF_PREFIX)
  );
}

export const FIGURE_MATCH_PREFIX = "Figure check: matches the source PDF";
export const FIGURE_DIFF_PREFIX = "Needs review: figure check —";
export const FIGURE_KEPT_PREFIX = "Figure check: stored version kept by a reviewer";
export const FIGURE_USED_PDF_PREFIX = "Figure check: replaced with the PDF version by a reviewer";

export function figureMatchNote(parts: string[], date = new Date()): string {
  return `${FIGURE_MATCH_PREFIX} (${parts.join(", ") || "checked"}, ${date.toISOString().slice(0, 10)})`;
}

/** `proposalUrl` = JSON blob with the PDF version (lib/figure-compare.ts). */
export function figureDiffNote(what: string[], proposalUrl: string | null): string {
  const clean = what.join(", ").replace(/[;[\]]/g, ",").replace(/\s+/g, " ").trim();
  return `${FIGURE_DIFF_PREFIX} the stored ${clean} differ${what.length === 1 && !/s$/.test(what[0]) ? "s" : ""} from the source PDF, compare them side by side${proposalUrl ? ` [compare:${proposalUrl}]` : ""}`;
}

/** Proposal URL inside a figure-diff note (null = none). */
export function figureProposalUrl(notes: string | null | undefined): string | null {
  const m = (notes ?? "").match(/\[compare:(https:\/\/[^\]\s]+)\]/);
  return m ? m[1] : null;
}

export const STEM_REPLACED_PREFIX = "Question text replaced from the PDF by a reviewer";

/** History left by the automatic fixes and the queue's own decisions (never blocks). */
export function isHistoryNote(seg: string): boolean {
  return [AUTO_FIX_NOTE_PREFIX, FIGURE_MATCH_PREFIX, FIGURE_KEPT_PREFIX, FIGURE_USED_PDF_PREFIX, STEM_REPLACED_PREFIX].some((p) => seg.startsWith(p));
}

/** A "verified" fragment left over from "Choices re-extracted from PDF; verified". */
const ORPHAN_VERIFIED = /^verified$/i;

/** Drop figure notes (and their orphan fragments). */
export function dropFigureNotes(notes: string | null | undefined): { notes: string | null; removed: string[] } {
  return removeNotes(notes, (s) => isFigureNote(s) || ORPHAN_VERIFIED.test(s));
}

// ── Approval gate (the "only reason" logic) ──────────────────────────

/**
 * What still keeps this row from being Approved (empty = nothing). Same
 * inputs as planNotes in lib/explanation-autofix.ts: blocking notes,
 * findApproveBlocker, a missing stem figure, a key that differs from the
 * official one and failing post-parse checks. Unlike the auto-fix, an
 * explanation-problem note blocks too (nothing here rewrote the explanation),
 * except the auto-fix's own history note.
 */
export function approvalBlockers(r: AutoFixRow): string[] {
  const failing = failingChecks(r, r.explanation ?? "");
  const ctx: NoteContext = { officialKey: keyIsOfficial(r), failingChecks: failing };
  const out: string[] = [];
  for (const seg of noteSegments(r.parsing_notes)) {
    if (isHistoryNote(seg)) continue;
    if (classifyNote(seg, ctx) !== "info") out.push(`note: ${seg.length > 140 ? `${seg.slice(0, 140)}…` : seg}`);
  }
  const blocker = findApproveBlocker(r.question_text, r.choices, r.question_type, r.correct_answer, r.official_answer);
  if (blocker) out.push(`approve check: ${blocker.reason}`);
  if (stemFigureMissing(r)) out.push("the question's figure is missing");
  if (r.official_answer && !keyIsOfficial(r)) out.push(`key ${r.correct_answer} differs from the official answer ${r.official_answer}`);
  for (const id of failing) out.push(`check: ${id}`);
  return out;
}

// ── Grouping ─────────────────────────────────────────────────────────

/**
 * "Needs review: stem and choices re-extracted from the PDF (…) — check the
 * explanation against the full question, then approve": the content is
 * fixed, only the explanation is left to check (a checked regeneration
 * settles it).
 */
export const EXPLANATION_CHECK_NOTE = /re-extracted from the PDF[^;]*check the explanation/i;

const RULES: [ReviewGroupId, RegExp][] = [
  ["key_dispute", KEY_SAYS_RE],
  ["module_key", /answer key disagrees with the solved answer on \d+ of \d+|key page may be for a different module|answer-key page in this PDF says Module/i],
  ["key_format", /SPR question has a letter answer|^Needs review: answer key check|Student Produced Response question but (?:the )?correct_answer|correct_answer is listed as '[A-D]' but this is a Student Produced Response/i],
  [
    "key_dispute",
    /AI thinks the answer key may be wrong|AI's own answer is .+ but the saved key is|^Mismatch: AI answered|printed key|stored answer .* may be wrong|Pulled for review[\s\S]*(?:the key is|check the key|fix the key)|differs from the official answer|disagrees with official_answer|stored (?:correct )?answer (?:is|of)|stored correct_answer|correct_answer is '|contradicting the stored correct answer|contradicts the stored correct answer|(?:key|answer) (?:is|appears to be) (?:likely )?(?:incorrect|wrong)|\bis (?:likely|clearly) (?:incorrect|wrong)\b/i,
  ],
  ["ai_key", /Solver self-contradicted|stored the explained answer|generated by AI solver|Consensus solve NOT unanimous/i],
  ["explanation", EXPLANATION_CHECK_NOTE],
  ["stem", /question text looks cut off|stem (?:still )?truncated|\bstem\b[^.]*(?:truncat|incomplete|cut off|garbled|inconsistent|concatenat)|passage (?:is )?missing|AI re-read of the source PDF \(scanned page[^)]*\)(?![\s\S]*answer choices)/i],
  ["figure", /figure\/choices|Image re-extracted|choices? re-extracted|Markdown table AND an image|gave different answer choices|Choice misalignment|choices copied from PDF text|answer choices? (?:have|has|are) empty|choices are empty|choice [A-D] (?:is|text is) (?:empty|truncated|garbled)|graph choice|figure check|\bfigure\b|\bimage\b|\bgraph\b|\btable\b|choice check|corrected from PDF/i],
  ["render", /math-render|math-contains-prose|LaTeX|stray dollar|raw dollar|Demoted by post-parse-cleanup|renders? raw|garbled/i],
  ["explanation", /explanation|regenerate/i],
];

export interface RowGrouping {
  primary: ReviewGroupId;
  /** Every group with at least one reason (primary first). */
  groups: ReviewGroupId[];
  /** The reasons, as short text, in group order. */
  reasons: { group: ReviewGroupId; text: string }[];
}

/** The group(s) of one Needs Review row. */
export function groupRow(r: AutoFixRow): RowGrouping {
  const failing = failingChecks(r, r.explanation ?? "");
  const ctx: NoteContext = { officialKey: keyIsOfficial(r), failingChecks: failing };
  const reasons: { group: ReviewGroupId; text: string }[] = [];
  const add = (group: ReviewGroupId, text: string) => reasons.push({ group, text });
  for (const seg of noteSegments(r.parsing_notes)) {
    if (seg.startsWith(LIVE_FIX_TAG)) {
      add("live_fix", seg);
      continue;
    }
    if (isHistoryNote(seg)) continue;
    const kind = classifyNote(seg, ctx);
    if (kind === "info") continue;
    if (kind === "explanation" && !/\bstem\b|question text/i.test(seg)) {
      add("explanation", seg);
      continue;
    }
    const rule = RULES.find(([, re]) => re.test(seg));
    add(rule ? rule[0] : "other", seg);
  }
  const blocker = findApproveBlocker(r.question_text, r.choices, r.question_type, r.correct_answer, r.official_answer);
  if (blocker) {
    const g: ReviewGroupId = /answer key|key/i.test(blocker.note) && !/cut off|placeholder/i.test(blocker.reason) ? "key_format" : /choice/i.test(blocker.reason) ? "figure" : "stem";
    add(g, `approve check: ${blocker.reason}`);
  }
  if (stemFigureMissing(r)) add("figure", "the question's figure is missing");
  if (r.official_answer && !keyIsOfficial(r)) add("key_dispute", `key ${r.correct_answer} differs from the official answer ${r.official_answer}`);
  for (const id of failing) add(/^math-/.test(id) ? "render" : /explanation/.test(id) ? "explanation" : /spr|answer|key/.test(id) ? "key_format" : "other", `check: ${id}`);
  if (reasons.length === 0) add("other", "no blocking note left");
  const groups = PRIORITY.filter((g) => reasons.some((x) => x.group === g));
  return { primary: groups[0], groups, reasons: reasons.sort((a, b) => PRIORITY.indexOf(a.group) - PRIORITY.indexOf(b.group)) };
}

/** Count per primary group (every group present, 0 when empty). */
export function countByGroup(rows: AutoFixRow[]): Record<ReviewGroupId, number> {
  const out = Object.fromEntries(PRIORITY.map((g) => [g, 0])) as Record<ReviewGroupId, number>;
  for (const r of rows) out[groupRow(r).primary]++;
  return out;
}

// ── Automatic fixes, for the summary ─────────────────────────────────

/**
 * Which group an APPROVED row was fixed for automatically (null = not an
 * automatic fix): the explanation auto-fix and the figure check leave a
 * history note on the rows they approve.
 */
export function autoFixedGroup(r: Pick<AutoFixRow, "parsing_status" | "parsing_notes">): ReviewGroupId | null {
  if (r.parsing_status !== "Approved") return null;
  const segs = noteSegments(r.parsing_notes);
  if (segs.some((s) => s.startsWith(FIGURE_MATCH_PREFIX))) return "figure";
  if (segs.some((s) => s.startsWith(AUTO_FIX_NOTE_PREFIX))) return "explanation";
  return null;
}
