// lib/explanation-autofix.ts
//
// Explanation-only problems are fixed automatically (owner-approved,
// 2026-11-07): a cut-off explanation, broken formatting (stray "$", raw
// LaTeX, "wait, let me re-check" narration), or an explanation that argues a
// different choice than an official key. The explanation is regenerated from
// the SAVED key (regenerateExplanation) and saved only when:
//   - it is not cut off,
//   - the AI's own independent answer matches the saved key, and
//   - the new explanation supports the saved key (no other conclusion).
// Then the explanation-problem notes are removed, and a Needs Review row whose
// only remaining problem was the explanation is Approved (findApproveBlocker
// must still pass). Approved rows stay Approved. Live-test rows keep their
// status. Never touches correct_answer, official_answer, choices or
// question_text.
//
// Used by scripts/auto-fix-explanations.ts (one-off), the parse pipeline /
// harden / reparse-inplace (per module) and /api/cron/auto-fix-explanations.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  explanationSource,
  looksTruncated,
  regenDisagreeNote,
  regenerateExplanation,
  stripMetaNarration,
  REGEN_DISAGREE_PREFIX,
  REGEN_EXPLANATION_NOTE,
  TRUNCATION_NOTE,
  type RegenExplanationInput,
  type RegenExplanationResult,
} from "@/lib/ai/solve-question";
import { findApproveBlocker, stemFigureMissing } from "@/lib/parse-guards";
import { applyLiveHold, liveQuestionIds, LIVE_FIX_TAG } from "@/lib/live-questions";
import { hasKeyDoubt } from "@/lib/key-doubt";
import { answersAgreeForQuestion, SPR_TYPE } from "@/lib/answer-key";
import { answersMatch } from "@/lib/grade-submission";
import { CHECKS, type AuditRow } from "@/lib/post-parse-cleanup";
import { renderProblems } from "@/lib/math/render-problems";

// ── Rows ─────────────────────────────────────────────────────────────

export const AUTO_FIX_SELECT =
  "id, module_id, original_question_number, section, question_type, question_text, choices, correct_answer, official_answer, explanation, parsing_status, parsing_notes, has_image, image_urls, has_table, updated_at";

export interface AutoFixRow {
  id: string;
  module_id?: string | null;
  original_question_number: number | null;
  section?: string | null;
  question_type: string | null;
  question_text: string | null;
  choices: unknown;
  correct_answer: string | null;
  official_answer: string | null;
  explanation: string | null;
  parsing_status: string | null;
  parsing_notes: string | null;
  has_image?: boolean | null;
  image_urls?: unknown;
  has_table?: boolean | null;
  updated_at?: string | null;
}

const isMcq = (r: { question_type: string | null }) => r.question_type !== SPR_TYPE;

/** Two answers agree (letters as letters, fill-in values by grading rules). */
function sameAnswer(a: string | null | undefined, b: string | null | undefined, questionText: string | null): boolean {
  if (!a || !b) return false;
  return answersMatch(a, b, questionText) || answersMatch(b, a, questionText) || answersAgreeForQuestion(a, b, questionText);
}

/** The saved key is the official key. */
export function keyIsOfficial(r: Pick<AutoFixRow, "official_answer" | "correct_answer" | "question_text">): boolean {
  return !!r.official_answer && sameAnswer(r.official_answer, r.correct_answer, r.question_text);
}

// ── Detectors (explanation text) ─────────────────────────────────────

/** Self-correcting narration anywhere in the text ("Wait, …", "let me re-check"). */
const RAMBLE =
  /\b(?:wait[,!.—–-]|let me (?:re-?check|re-?examine|reconsider|double-check|verify|re-?read|redo|recompute|re-?calculate|try again|recount|look again)|hold on\b|hmm\b|on second thought|I made an? (?:error|mistake)|that(?:'s| is) not right|actually,? (?:wait|no|that|let)|re-?examining|reconsidering)/i;

/** Broken formatting a student would see in this explanation (empty = fine). */
export function formattingProblems(explanation: string | null | undefined): string[] {
  const ex = (explanation ?? "").trim();
  if (!ex) return [];
  const out: string[] = [];
  if (stripMetaNarration(ex) !== ex) out.push("starts with meta narration");
  // Quoted passage text may legitimately say "wait," — only the explanation's own words count.
  const ramble = ex.replace(/"[^"\n]*"|“[^”]*”|'[^'\n]{3,}'/g, " ").match(RAMBLE);
  if (ramble) out.push(`self-correcting narration ("${ramble[0]}")`);
  // The renderer itself (normalizeMath + remark-math + KaTeX, as students see it).
  try {
    const raw = renderProblems(ex);
    if (raw.length) out.push(`renders raw: ${raw[0]}`);
  } catch {
    out.push("does not render");
  }
  return out;
}

/** Letters the explanation names as THE answer ("Choice B is correct", "Therefore, B is the only…"). */
export function concludedLetters(explanation: string): string[] {
  const pats = [
    /\b(?:choice|option|answer)\s*\(?([A-D])\)?\s*(?:[,—–-]\s*[^,.;]{0,80}?[,—–-]\s*)?(?:is|was)\s+(?:therefore\s+|thus\s+|clearly\s+)?(?:the\s+)?(?:correct|best|right|only (?:choice|option|answer|one)|answer)\b/gi,
    /\b(?:correct|best|right) (?:answer|choice|option) is\s*(?:choice\s*|option\s*)?\(?([A-D])\b/gi,
    /\b(?:therefore|thus|hence),?\s+(?:choice\s*|option\s*)?\(?([A-D])\)?\s+is\s+(?:the\s+)?(?:correct|best|right|only|answer)\b/gi,
    /\bthe answer is\s*(?:choice\s*|option\s*)?\(?([A-D])\b/gi,
    /Final answer\s*:\s*\(?([A-D])\b/gi,
  ];
  const out = new Set<string>();
  for (const p of pats) for (const m of explanation.matchAll(p)) out.add(m[1].toUpperCase());
  return [...out];
}

/**
 * The explanation argues for something other than `key` (null = it doesn't).
 * Multiple Choice: it names another letter as the answer. Fill-in: its
 * "Final answer:" line differs from the key.
 */
export function explanationArguesOther(
  explanation: string | null | undefined,
  key: string | null | undefined,
  questionType: string | null,
  questionText: string | null,
): string | null {
  const ex = explanation ?? "";
  if (!ex.trim() || !key) return null;
  if (questionType !== SPR_TYPE) {
    const k = key.trim().replace(/^\(?\s*([A-D])\b.*$/i, "$1").toUpperCase();
    if (!/^[A-D]$/.test(k)) return null;
    const other = concludedLetters(ex).filter((l) => l !== k);
    return other.length ? `explanation concludes ${other.join("/")}, key is ${k}` : null;
  }
  const m = ex.match(/Final answer\s*:\s*([^\n]+)/i);
  if (!m) return null;
  const v = m[1].replace(/\*\*|\\mathbf|[{}$]/g, "").trim().replace(/[.;)]+$/, "").trim();
  if (!v || sameAnswer(v, key, questionText)) return null;
  // "Final answer: 3/2 (also accepted: 1.5)", "a + c = 7 + 1.5 = 8.5": any value on the line counts.
  const values = v.match(/-?\d[\d,]*(?:\.\d+)?(?:\/\d+)?|-?\.\d+/g) ?? [];
  if (values.some((x) => sameAnswer(x.replace(/,/g, ""), key, questionText))) return null;
  if (values.length === 0) return null;
  return `explanation's final answer is ${v}, key is ${key}`;
}

// ── Notes ────────────────────────────────────────────────────────────

/** Split parsing_notes on ";" outside (…) / […] (a note can contain "; " inside parentheses). */
export function splitNotes(notes: string | null | undefined): string[] {
  const s = notes ?? "";
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    if (ch === ";" && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const AUTO_FIX_NOTE_PREFIX = "Explanation auto-fixed";
export function autoFixNote(date = new Date()): string {
  return `${AUTO_FIX_NOTE_PREFIX}: regenerated from the saved key, AI's own answer agreed, checked (${date.toISOString().slice(0, 10)})`;
}

const NON_EXPLANATION_ISSUE =
  /(?:missing|no|needs? a) figure|figure (?:is|was) (?:not|missing)|image (?:is )?(?:not|missing)|all (?:four|4) (?:answer )?choices|choices? [A-D]? ?(?:is|are|has|have) (?:empty|garbled|truncated|duplicat|missing|blank)|choice [A-D] (?:text )?is truncated|\bstem\b|question text/i;
const CONTRADICTION = /conclud|argues?\b|different (?:answer|choice|letter)|self-contradict|contradict|demonstrates that|instead of|rather than the (?:stored|correct)/i;

export type NoteKind = "explanation" | "blocking" | "info";

export interface NoteContext {
  /** The saved key equals the official key. */
  officialKey: boolean;
  /** Post-parse checks that still fail on the row (after the fix). */
  failingChecks: Set<string>;
}

/**
 * explanation = an explanation-problem note this fix clears;
 * blocking    = keeps the row in Needs Review ("Needs review:", key doubt,
 *               figure / choice / extraction, live-fix, …);
 * info        = history that doesn't block (e.g. "Answer = official key").
 */
export function classifyNote(seg: string, ctx: NoteContext): NoteKind {
  const s = seg.trim();
  if (s === TRUNCATION_NOTE || s === REGEN_EXPLANATION_NOTE) return "explanation";
  if (s.startsWith(REGEN_DISAGREE_PREFIX) || hasKeyDoubt(s) || s.startsWith(LIVE_FIX_TAG)) return "blocking";
  if (s.startsWith(AUTO_FIX_NOTE_PREFIX)) return "explanation"; // replaced by a fresh one
  const sem = s.match(/^Semantic audit:\s*([\s\S]*)$/i);
  if (sem) {
    const body = sem[1];
    const aboutExplanation =
      /^(?:the |in the |malformed latex in (?:the )?|answer_explanation_ok:\s*(?:the )?)?explanation\b/i.test(body) ||
      /^(?:stray dollar signs?|garbled latex|malformed latex|raw (?:latex|dollar)[^ ]*)[^.;]{0,40}?\bin (?:the )?explanation\b/i.test(body);
    if (!aboutExplanation || NON_EXPLANATION_ISSUE.test(body.replace(/'[^']*'|"[^"]*"|“[^”]*”/g, ""))) return "blocking";
    if (CONTRADICTION.test(body) && !ctx.officialKey) return "blocking";
    return "explanation";
  }
  if (/^Solver self-contradicted \(declared .+, explained .+\)$/i.test(s) || /^stored the explained answer ".*"\. Please verify\.?$/i.test(s)) {
    return ctx.officialKey ? "explanation" : "blocking";
  }
  const demoted = s.match(/^Demoted by post-parse-cleanup: failed checks → (.+)$/);
  if (demoted) {
    const ids = demoted[1].split(/,\s*/).map((x) => x.trim());
    const explanationOnly = ids.every((id) => id === "math-render-failed" || id === "math-contains-prose" || id === "explanation-final-mismatch");
    return explanationOnly && ids.every((id) => !ctx.failingChecks.has(id)) ? "explanation" : "blocking";
  }
  if (/^Needs review:/i.test(s)) {
    // "…the stored explanation still argues for the old wrong key B… rewrite
    // the explanation, then approve" (Oct 2024 ENG M2 Q19).
    const explanationOnly =
      /explanation (?:still )?(?:argues|contradicts|concludes)|rewrite the explanation/i.test(s) &&
      !/figure|image|graph|choice text|choices (?:are|were)|stem|question text|key may be wrong|key is wrong|check the key/i.test(s);
    return explanationOnly && ctx.officialKey ? "explanation" : "blocking";
  }
  if (/figure|image|graph|diagram|\btable\b|choice|extract|self-repair|re-?review|please verify|still needs review|blind|\bstem\b|question text|garbled|mismatch|disagree|misalign|placeholder|LaTeX|math\/|cut off|truncat/i.test(s)) {
    return "blocking";
  }
  return "info";
}

/** Does this row carry an explanation-problem note? */
export function hasExplanationNote(r: AutoFixRow): boolean {
  // A "Demoted by post-parse-cleanup" note is left to the formatting detector
  // (the same checks run on the text itself).
  const ctx: NoteContext = { officialKey: keyIsOfficial(r), failingChecks: new Set() };
  return splitNotes(r.parsing_notes).some(
    (seg) => !seg.startsWith(AUTO_FIX_NOTE_PREFIX) && !seg.startsWith("Demoted by") && classifyNote(seg, ctx) === "explanation",
  );
}

// ── Targets ──────────────────────────────────────────────────────────

export interface TargetReasons {
  cutOff: boolean;
  formatting: string[];
  contradicts: string | null;
  /** Only an explanation-problem note (the text itself looks fine). */
  noteOnly: boolean;
}

/** Why this row's explanation needs fixing (null = not a target). */
export function explanationTargetReasons(r: AutoFixRow): TargetReasons | null {
  if (r.parsing_status !== "Needs Review" && r.parsing_status !== "Approved") return null;
  if (!r.correct_answer || !r.correct_answer.trim()) return null;
  // Already waiting for a person to decide the key.
  if (splitNotes(r.parsing_notes).some((s) => s.startsWith(REGEN_DISAGREE_PREFIX))) return null;
  const cutOff = looksTruncated(r.explanation, explanationSource(r.question_text, r.choices)) || !(r.explanation ?? "").trim();
  const formatting = formattingProblems(r.explanation);
  const contradicts = keyIsOfficial(r) ? explanationArguesOther(r.explanation, r.correct_answer, r.question_type, r.question_text) : null;
  const note = r.parsing_status === "Needs Review" && hasExplanationNote(r);
  if (!cutOff && formatting.length === 0 && !contradicts && !note) return null;
  return { cutOff, formatting, contradicts, noteOnly: !cutOff && formatting.length === 0 && !contradicts };
}

export function describeReasons(t: TargetReasons): string[] {
  return [
    ...(t.cutOff ? ["cut off"] : []),
    ...t.formatting.map((f) => `formatting: ${f}`),
    ...(t.contradicts ? [`contradicts key: ${t.contradicts}`] : []),
    ...(t.noteOnly ? ["explanation-problem note"] : []),
  ];
}

export function targetGroup(t: TargetReasons): "cut-off" | "formatting" | "contradicts-key" | "note-only" {
  if (t.contradicts) return "contradicts-key";
  if (t.cutOff) return "cut-off";
  if (t.formatting.length) return "formatting";
  return "note-only";
}

// ── Decision after a regenerated explanation ─────────────────────────

/** Why the new explanation can't be saved (null = it can). */
export function draftRejection(r: AutoFixRow, explanation: string): string | null {
  if (!explanation.trim()) return "empty";
  if (looksTruncated(explanation, explanationSource(r.question_text, r.choices))) return "still cut off";
  const other = explanationArguesOther(explanation, r.correct_answer, r.question_type, r.question_text);
  if (other) return `does not support the key (${other})`;
  const fmt = formattingProblems(explanation);
  if (fmt.length) return `formatting: ${fmt[0]}`;
  return null;
}

/** Post-parse checks failing on the row with this explanation. */
export function failingChecks(r: AutoFixRow, explanation: string): Set<string> {
  const row: AuditRow = {
    id: r.id,
    section: r.section ?? null,
    question_type: r.question_type,
    question_text: r.question_text,
    choices: Array.isArray(r.choices) ? (r.choices as AuditRow["choices"]) : null,
    correct_answer: r.correct_answer,
    explanation,
    has_image: r.has_image ?? null,
    image_urls: Array.isArray(r.image_urls) ? (r.image_urls as string[]) : null,
    has_table: r.has_table ?? null,
  };
  return new Set(CHECKS.filter((c) => c.failed(row)).map((c) => c.id));
}

export interface NotePlan {
  /** Notes to save (explanation notes removed, fresh auto-fix note added). */
  notes: string;
  removed: string[];
  /** Reasons the row must stay in Needs Review (empty = may be approved). */
  blockers: string[];
}

/**
 * "Only reason" logic: drop explanation-problem notes, then list what still
 * blocks approval — remaining blocking notes plus findApproveBlocker, a
 * missing stem figure, a key that differs from the official one and failing
 * post-parse checks.
 */
export function planNotes(r: AutoFixRow, newExplanation: string, now = new Date()): NotePlan {
  const failing = failingChecks(r, newExplanation);
  const ctx: NoteContext = { officialKey: keyIsOfficial(r), failingChecks: failing };
  const kept: string[] = [];
  const removed: string[] = [];
  const blockers: string[] = [];
  for (const seg of splitNotes(r.parsing_notes)) {
    const kind = classifyNote(seg, ctx);
    if (kind === "explanation") { removed.push(seg); continue; }
    kept.push(seg);
    if (kind === "blocking") blockers.push(`note: ${seg.length > 140 ? `${seg.slice(0, 140)}…` : seg}`);
  }
  const blocker = findApproveBlocker(r.question_text, r.choices, r.question_type, r.correct_answer, r.official_answer);
  if (blocker) blockers.push(`approve check: ${blocker.reason}`);
  if (stemFigureMissing(r)) blockers.push("the question's figure is missing");
  if (r.official_answer && !keyIsOfficial(r)) blockers.push(`key ${r.correct_answer} differs from the official answer ${r.official_answer}`);
  for (const id of failing) blockers.push(`check: ${id}`);
  kept.push(autoFixNote(now));
  return { notes: kept.join("; "), removed, blockers };
}

export type AutoFixGroup =
  | "fixed_approved" // Needs Review → Approved
  | "fixed_kept_approved" // was Approved, stays Approved
  | "fixed_still_review" // saved, other reasons keep it in Needs Review
  | "fixed_live_held" // saved, would be approved but the question is in a live test
  | "disagree" // AI's own answer differs from the key → person
  | "still_cut_off" // cut off after the retry → left as-is
  | "unverified" // AI gave no independent answer → left as-is
  | "draft_rejected" // new explanation failed a check → left as-is
  | "failed" // AI call failed → left as-is
  | "skipped"; // row changed meanwhile / not a target any more

export interface AutoFixDecision {
  group: AutoFixGroup;
  /** Columns to write (null = leave the row as-is). */
  update: Record<string, unknown> | null;
  blockers: string[];
  removedNotes: string[];
  detail?: string;
}

/** Pure: what to write given the regeneration result. */
export function decideAutoFix(
  r: AutoFixRow,
  t: TargetReasons,
  res: RegenExplanationResult,
  live: boolean,
  now = new Date(),
): AutoFixDecision {
  const none = (group: AutoFixGroup, detail?: string): AutoFixDecision => ({ group, update: null, blockers: [], removedNotes: [], detail });
  if (!res.ok) return none(res.kind === "cut_off" ? "still_cut_off" : "failed", res.error);
  const key = r.correct_answer as string;
  if (!res.aiAnswer) return none("unverified", "the AI gave no independent answer");
  // It must be a bare letter / value; sometimes the model writes its working
  // there instead, which can't be compared — no verdict, row left as-is.
  if (res.aiAnswer.length > 40 || res.aiAnswer.includes("\n")) return none("unverified", "the AI's independent answer was working, not a value");
  if (!res.agrees) {
    // A person decides the key. Explanation is not written.
    const notes = [...splitNotes(r.parsing_notes).filter((s) => !s.startsWith(REGEN_DISAGREE_PREFIX)), regenDisagreeNote(res.aiAnswer, key)].join("; ");
    const update: Record<string, unknown> = { parsing_notes: notes, updated_at: now.toISOString() };
    if (r.parsing_status === "Approved") update.parsing_status = "Needs Review";
    const held = applyLiveHold(
      { id: r.id, parsing_status: r.parsing_status, parsing_notes: r.parsing_notes, correct_answer: r.correct_answer },
      update,
      "AI's own answer differs from the key",
      live ? new Set([r.id]) : new Set(),
    );
    return { group: "disagree", update: held.update, blockers: [], removedNotes: [], detail: `AI ${res.aiAnswer} vs key ${key}` };
  }
  const rejected = draftRejection(r, res.explanation);
  if (rejected) return none(rejected === "still cut off" ? "still_cut_off" : "draft_rejected", rejected);

  const plan = planNotes(r, res.explanation, now);
  const update: Record<string, unknown> = { explanation: res.explanation, updated_at: now.toISOString() };
  let notes = plan.notes;
  let group: AutoFixGroup;
  const tag = (reason: string) => {
    if (!notes.startsWith(LIVE_FIX_TAG)) notes = `${LIVE_FIX_TAG} ${reason} while this question is in a live test; kept ${r.parsing_status} — please re-check. ${notes}`.trim();
  };
  if (r.parsing_status === "Approved") {
    group = "fixed_kept_approved";
    // Material for students: the old explanation argued a different answer.
    if (live && t.contradicts) tag("Explanation rewritten (it argued a different answer than the key)");
  } else if (plan.blockers.length === 0) {
    if (live) {
      group = "fixed_live_held";
      tag("Explanation auto-fixed and nothing else blocks approval");
    } else {
      group = "fixed_approved";
      update.parsing_status = "Approved";
    }
  } else {
    group = "fixed_still_review";
  }
  update.parsing_notes = notes || null;
  return { group, update, blockers: plan.blockers, removedNotes: plan.removed };
}

// ── Runner ───────────────────────────────────────────────────────────

export interface AutoFixOutcome {
  id: string;
  module_id: string | null;
  number: number | null;
  status_before: string | null;
  status_after: string | null;
  target: string;
  reasons: string[];
  group: AutoFixGroup;
  blockers: string[];
  removedNotes: string[];
  detail?: string;
  aiAnswer?: string | null;
  key: string | null;
  explanation_after?: string;
  notes_after?: string | null;
}

export interface AutoFixOptions {
  apply: boolean;
  callerUserId?: string;
  concurrency?: number;
  /** Stop starting new rows after this time (ms since epoch). */
  deadline?: number;
  usageRoute?: string;
  onOutcome?: (o: AutoFixOutcome, done: number, total: number) => void;
  /** Injected for tests. */
  regen?: (input: RegenExplanationInput, callerUserId?: string, usageRoute?: string) => Promise<RegenExplanationResult>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function regenWithBackoff(
  regen: NonNullable<AutoFixOptions["regen"]>,
  input: RegenExplanationInput,
  callerUserId: string | undefined,
  usageRoute: string,
): Promise<RegenExplanationResult> {
  // regenerateExplanation already retries each call (maxRetries) — a "failed"
  // result is usually a rate limit that outlasted those: back off and retry.
  let res = await regen(input, callerUserId, usageRoute);
  for (let i = 0; i < 2 && !res.ok && res.kind === "failed"; i++) {
    await sleep(15_000 * (i + 1));
    res = await regen(input, callerUserId, usageRoute);
  }
  return res;
}

/** Fix the explanation-problem rows among `rows` (dry run unless opts.apply). */
export async function autoFixExplanations(
  db: SupabaseClient,
  rows: AutoFixRow[],
  opts: AutoFixOptions,
): Promise<AutoFixOutcome[]> {
  const regen = opts.regen ?? regenerateExplanation;
  const targets = rows
    .map((r) => ({ r, t: explanationTargetReasons(r) }))
    .filter((x): x is { r: AutoFixRow; t: TargetReasons } => x.t !== null);
  if (targets.length === 0) return [];
  let live: Set<string>;
  try {
    live = await liveQuestionIds(db, targets.map((x) => x.r.id));
  } catch (e) {
    // Can't tell — treat every row as live (status is never changed).
    console.error("[explanation-autofix] live lookup failed:", e instanceof Error ? e.message : e);
    live = new Set(targets.map((x) => x.r.id));
  }
  const out: AutoFixOutcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      if (opts.deadline && Date.now() > opts.deadline) return;
      const { r, t } = targets[next++];
      const base = {
        id: r.id,
        module_id: r.module_id ?? null,
        number: r.original_question_number,
        status_before: r.parsing_status,
        target: targetGroup(t),
        reasons: describeReasons(t),
        key: r.correct_answer,
      };
      let o: AutoFixOutcome;
      try {
        const input: RegenExplanationInput = {
          questionId: r.id,
          questionNumber: r.original_question_number,
          questionText: r.question_text ?? "",
          choices: r.choices,
          questionType: r.question_type,
          answer: r.correct_answer as string,
          imageUrls: Array.isArray(r.image_urls) ? (r.image_urls as string[]) : null,
        };
        const route = opts.usageRoute ?? "auto-fix-explanations";
        let res = await regenWithBackoff(regen, input, opts.callerUserId, route);
        let d = decideAutoFix(r, t, res, live.has(r.id));
        // A draft that narrates ("Wait, let me re-check") or names another
        // letter, or no usable independent answer: one fresh attempt before
        // the row is left as-is.
        if (d.group === "draft_rejected" || d.group === "unverified") {
          res = await regenWithBackoff(regen, input, opts.callerUserId, route);
          d = decideAutoFix(r, t, res, live.has(r.id));
        }
        o = {
          ...base,
          group: d.group,
          status_after: (d.update?.parsing_status as string | undefined) ?? r.parsing_status,
          blockers: d.blockers,
          removedNotes: d.removedNotes,
          detail: d.detail,
          aiAnswer: res.ok ? res.aiAnswer : null,
          explanation_after: d.update && "explanation" in d.update ? (d.update.explanation as string) : undefined,
          notes_after: d.update ? ((d.update.parsing_notes as string | null | undefined) ?? r.parsing_notes) : r.parsing_notes,
        };
        if (opts.apply && d.update) {
          // Only if nobody changed the row since it was read.
          let q = db.from("questions").update(d.update).eq("id", r.id);
          if (r.updated_at) q = q.eq("updated_at", r.updated_at);
          const { data, error } = await q.select("id");
          if (error || !data || data.length === 0) {
            o = { ...o, group: "skipped", status_after: r.parsing_status, detail: error ? `write failed: ${error.message}` : "row changed since it was read" };
          }
        }
      } catch (e) {
        o = { ...base, group: "failed", status_after: r.parsing_status, blockers: [], removedNotes: [], detail: e instanceof Error ? e.message : String(e) };
      }
      out.push(o);
      opts.onOutcome?.(o, out.length, targets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return out;
}

export async function loadAutoFixRows(db: SupabaseClient, moduleId?: string): Promise<AutoFixRow[]> {
  const rows: AutoFixRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from("questions").select(AUTO_FIX_SELECT).in("parsing_status", ["Needs Review", "Approved"]);
    if (moduleId) q = q.eq("module_id", moduleId);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) throw new Error(`loadAutoFixRows: ${error.message}`);
    rows.push(...((data ?? []) as AutoFixRow[]));
    if (!data || data.length < 1000) return rows;
  }
}

export function summarize(outcomes: AutoFixOutcome[]): Partial<Record<AutoFixGroup, number>> {
  const s: Partial<Record<AutoFixGroup, number>> = {};
  for (const o of outcomes) s[o.group] = (s[o.group] ?? 0) + 1;
  return s;
}

/**
 * Pipeline hook: fix explanation-only problems in one module (writes). Stops
 * starting new rows after `budgetMs` so the calling route stays inside its
 * time limit; the daily cron picks up anything left.
 */
export async function autoFixModuleExplanations(
  moduleId: string,
  db: SupabaseClient,
  callerUserId?: string,
  budgetMs = 180_000,
): Promise<Partial<Record<AutoFixGroup, number>>> {
  const rows = await loadAutoFixRows(db, moduleId);
  const out = await autoFixExplanations(db, rows, {
    apply: true,
    callerUserId,
    concurrency: 4,
    deadline: Date.now() + budgetMs,
    usageRoute: "auto-fix-explanations",
  });
  const s = summarize(out);
  if (out.length) console.log(`[explanation-autofix] module=${moduleId} ${JSON.stringify(s)}`);
  return s;
}
