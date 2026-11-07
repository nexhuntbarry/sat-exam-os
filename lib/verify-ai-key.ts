// lib/verify-ai-key.ts
//
// Code-verify answer keys that came only from AI solving (official_answer is
// null). Owner-approved 2026-11-07. Used by scripts/verify-ai-keys.ts.
//
// Three independent checks per question:
//   1. code solve — the model writes the computation as an expression; it is
//      evaluated in code (lib/math/safe-eval) and the stem's rounding is
//      applied in code. Multiple Choice: the value is mapped to the choice
//      whose (code-evaluated) value matches. Choices that aren't numbers
//      (equations, words) fall back to the model's letter.
//   2. plug-back — the STORED key is substituted back into the problem: the
//      model writes conditions the answer must satisfy as arithmetic
//      equations in `ans`; code evaluates every one with ans = the key.
//   3. second solve — a different model (Opus) and a different method
//      (work backwards / test each choice / eliminate), not shown the key.
// Reading & Writing has no code path: two independent solves (Sonnet,
// standard; Opus, eliminate-each-choice) must agree with the key.
//
// Verdict:
//   verified   — every check agrees with the stored key and the explanation
//                supports it. AI-only-key notes are cleared; a Needs Review
//                row is Approved only when nothing else blocks it (the
//                explanation-autofix "only reason" logic + findApproveBlocker).
//   disagree   — any check reaches a different answer (or plug-back fails):
//                a person decides. A structured note is added (format below).
//   no-answer  — no check produced an answer.
//   unverified — inconclusive (a check couldn't run); nothing is written.
// NEVER changes a key. Never demotes an Approved or live-test question:
// those only get the note (live ones also a "[live-fix]" tag).

import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SPR_TYPE,
  answersAgreeForQuestion,
  applyRounding,
  checkComputedAnswer,
  keyCandidates,
  normalizeKeyText,
  roundingInstruction,
  sprValue,
} from "@/lib/answer-key";
import { nearlyEqual, tryEvaluate } from "@/lib/math/safe-eval";
import { findApproveBlocker, stemFigureMissing } from "@/lib/parse-guards";
import { LIVE_FIX_TAG } from "@/lib/live-questions";
import { hasKeyDoubt } from "@/lib/key-doubt";
import {
  AUTO_FIX_NOTE_PREFIX,
  classifyNote,
  explanationArguesOther,
  failingChecks,
  formattingProblems,
  splitNotes,
  type AutoFixRow,
} from "@/lib/explanation-autofix";
import {
  curlyQuotes,
  explanationSource,
  fetchImageAsBase64,
  looksTruncated,
  SPR_COMPUTATION_RULE,
} from "@/lib/ai/solve-question";
import { logUsage } from "@/lib/ai/parse-pdf";
import { cleanTagText, readTag } from "@/lib/ai/tagged-output";

// ── Structured disagreement note (shared contract) ───────────────────
//
// The review-queue UI parses this note, so its format is fixed:
//
//   Needs review: key says <KEY>, AI says <AI>[ (<VALUE>)] — <DETAIL>
//
//   <KEY>    the stored correct_answer ("B", "6/13")
//   <AI>     the answer the checks reached instead ("C", "6.8"); "?" when only
//            the plug-back of the key failed and no solve gave another answer
//   <VALUE>  optional: the code-computed value behind <AI> ("51.12")
//   <DETAIL> per-check summary, e.g. "code C (51.12); plug-back of B fails
//            (2*ans+3 == 11); second solve C [verify-ai-key 2026-11-07]"
//
// It is ONE parsing_notes segment (no ";" outside parentheses / brackets),
// starts with "Needs review:" so every auto-approve path treats it as
// blocking, and a re-run replaces it. Parse with parseAiKeyDisagreeNote().
export const AI_KEY_DISAGREE_PREFIX = "Needs review: key says";
export const AI_KEY_DISAGREE_RE =
  /^Needs review: key says (.+?), AI says (.+?)(?: \(([^()]*)\))?(?: — (.*))?$/;

export interface AiKeyDisagreement {
  key: string;
  ai: string;
  value: string | null;
  detail: string | null;
}

const noteSafe = (s: string) => s.replace(/;/g, ",").replace(/\s+/g, " ").trim();

export function aiKeyDisagreeNote(d: AiKeyDisagreement): string {
  // Keep KEY / AI free of the separators the regex relies on.
  const clean = (s: string) => noteSafe(s).replace(/,/g, " ").replace(/[()]/g, "");
  return `${AI_KEY_DISAGREE_PREFIX} ${clean(d.key)}, AI says ${clean(d.ai)}${d.value ? ` (${clean(d.value)})` : ""}${d.detail ? ` — ${noteSafe(d.detail)}` : ""}`;
}

export function parseAiKeyDisagreeNote(segment: string): AiKeyDisagreement | null {
  const m = segment.trim().match(AI_KEY_DISAGREE_RE);
  return m ? { key: m[1], ai: m[2], value: m[3] ?? null, detail: m[4] ?? null } : null;
}

export const AI_KEY_VERIFIED_PREFIX = "AI-only key verified";
export function aiKeyVerifiedNote(detail: string, date: string): string {
  return `${AI_KEY_VERIFIED_PREFIX} (${noteSafe(detail)}) [verify-ai-key ${date}]`;
}

/** Notes that exist only because the key came from AI solving. Cleared once verified. */
const AI_ONLY_KEY_NOTES: RegExp[] = [
  /^Answer & explanation generated by AI solver — please verify\.?$/i,
  /^Solver self-contradicted \(declared .+, explained .+\)$/i,
  /^stored the explained answer ".*"\. Please verify\.?$/i,
  /^Consensus solve NOT unanimous\b.*needs human$/i,
  /^\d+ solves agreed on .+ but verifier disagreed — needs human$/i,
  /^No official answer in key for Q\d+ — AI solver only, please verify$/i,
];
export function isAiOnlyKeyNote(seg: string): boolean {
  const s = seg.trim();
  return AI_ONLY_KEY_NOTES.some((re) => re.test(s));
}

// ── Choice values (code) ─────────────────────────────────────────────

/** LaTeX / plain choice text → arithmetic expression for safe-eval (null = not a plain value). */
export function latexToExpr(text: string): string | null {
  let s = (text ?? "").trim();
  if (!s) return null;
  s = s.replace(/\$/g, "").replace(/\\left|\\right|\\displaystyle|\\,|\\!|\\;/g, "").replace(/\\(?:text|mathrm)\{([^{}]*)\}/g, "$1");
  // Innermost first, so \frac{\sqrt{3}}{2} and \sqrt{\frac{1}{4}} both resolve.
  for (let i = 0; i < 8 && /\\(?:[dt]?frac|sqrt)/.test(s); i++) {
    s = s
      .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))")
      .replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, "(($2)^(1/($1)))")
      .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)");
  }
  s = s
    .replace(/\^\{([^{}]*)\}/g, "^($1)")
    .replace(/\\cdot|\\times/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\pi/g, "pi")
    .replace(/[{}]/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\\%|%/g, "")
    .replace(/\s+/g, "");
  if (/\\|[a-oq-zA-Z_]/.test(s.replace(/sqrt|pi/g, ""))) return null; // a variable / word: not a plain value
  // Implicit multiplication: 2sqrt(3), 3pi, 2(4), )(.
  s = s.replace(/(\d|\))(?=sqrt|pi|\()/g, "$1*");
  return s || null;
}

export function choiceValue(text: string | null | undefined): number | null {
  const e = latexToExpr(text ?? "");
  return e ? tryEvaluate(e) : null;
}

/** Decimals printed in a choice (2 for "51.12") — sets the matching tolerance. */
function printedDecimals(text: string): number {
  const m = text.match(/\d\.(\d+)/);
  return m ? m[1].length : 0;
}

type ChoiceLike = { label?: string; text?: string | null; image_url?: string | null };

/** The one choice whose value equals `value` (null = none or ambiguous, or choices aren't values). */
export function mapValueToChoice(value: number, choices: ChoiceLike[]): string | null {
  const vals = choices.map((c) => ({ label: (c.label ?? "").toUpperCase(), text: c.text ?? "", v: c.image_url ? null : choiceValue(c.text) }));
  if (vals.length === 0 || vals.some((c) => c.v === null)) return null;
  const hits = vals.filter((c) => {
    const d = printedDecimals(c.text);
    return nearlyEqual(c.v as number, value, 1e-6) || (d > 0 && Math.abs((c.v as number) - value) <= 0.5 * 10 ** -d + 1e-12);
  });
  return hits.length === 1 ? hits[0].label : null;
}

// ── Answers ──────────────────────────────────────────────────────────

const letterOf = (s: string | null | undefined): string | null => {
  const m = (s ?? "").trim().match(/^\(?\s*([A-D])\b/i);
  return m ? m[1].toUpperCase() : null;
};

/** Do two answers agree for this question (letters as letters, values by grading rules)? */
export function sameKey(a: string | null | undefined, key: string | null | undefined, isMc: boolean, questionText: string | null): boolean {
  if (!a || !key) return false;
  if (isMc) return letterOf(a) !== null && letterOf(a) === letterOf(key);
  return answersAgreeForQuestion(a, key, questionText) || answersAgreeForQuestion(key, a, questionText);
}

// ── Check results ────────────────────────────────────────────────────

export interface SolveCheck {
  /** Letter (MC) or value (fill-in); null = no answer. */
  answer: string | null;
  /** Code-computed value behind `answer` (Math). */
  value?: number | null;
  /** MC: the value was mapped to a choice in code (false = model's letter). */
  mapped?: boolean;
  method: string;
  problems: string[];
}

export interface PlugBackCheck {
  status: "pass" | "fail" | "n/a";
  detail: string;
}

export interface VerifyChecks {
  section: "Math" | "Reading & Writing";
  /** Math: code solve. R&W: first solve. */
  first: SolveCheck | null;
  /** Math only. */
  plugBack: PlugBackCheck | null;
  second: SolveCheck | null;
}

// ── Decision (pure) ──────────────────────────────────────────────────

export type VerifyOutcome = "verified" | "disagree" | "no-answer" | "unverified";

export interface VerifyRow extends AutoFixRow {
  module_id: string | null;
}

export interface VerifyDecision {
  outcome: VerifyOutcome;
  /** Columns to write (null = leave the row as-is). */
  update: Record<string, unknown> | null;
  /** Why a verified Needs Review row was not Approved. */
  blockers: string[];
  summary: string;
  approved: boolean;
  disagreement?: AiKeyDisagreement;
}

function describe(c: SolveCheck | null): string {
  if (!c) return "n/a";
  const v = c.value !== null && c.value !== undefined ? ` (${+c.value.toPrecision(8)})` : "";
  return `${c.answer ?? "no answer"}${v}${c.mapped === false ? " [model letter]" : ""}`;
}

export function checksSummary(ch: VerifyChecks, key: string): string {
  if (ch.section === "Reading & Writing") return `solve 1 ${describe(ch.first)}, solve 2 ${describe(ch.second)}`;
  const pb = ch.plugBack ? `plug-back of ${key} ${ch.plugBack.status === "pass" ? "holds" : ch.plugBack.status === "fail" ? `fails (${ch.plugBack.detail})` : "n/a"}` : "plug-back n/a";
  return `code ${describe(ch.first)}, ${pb}, second solve ${describe(ch.second)}`;
}

/** What still blocks approval once the AI-only-key notes are gone (empty = may approve). */
export function approvalBlockers(r: VerifyRow, keptNotes: string[]): string[] {
  const failing = failingChecks(r, r.explanation ?? "");
  const ctx = { officialKey: false, failingChecks: failing };
  const blockers: string[] = [];
  for (const seg of keptNotes) {
    // History: our own note, and the explanation auto-fix's "checked" stamp.
    if (seg.startsWith(AI_KEY_VERIFIED_PREFIX) || seg.startsWith(AUTO_FIX_NOTE_PREFIX)) continue;
    // Explanation problems aren't fixed here, so they block too.
    if (classifyNote(seg, ctx) !== "info" || hasKeyDoubt(seg)) blockers.push(`note: ${seg.length > 140 ? `${seg.slice(0, 140)}…` : seg}`);
  }
  const b = findApproveBlocker(r.question_text, r.choices, r.question_type, r.correct_answer, r.official_answer);
  if (b) blockers.push(`approve check: ${b.reason}`);
  if (stemFigureMissing(r)) blockers.push("the question's figure is missing");
  if (!(r.explanation ?? "").trim()) blockers.push("no explanation");
  else if (looksTruncated(r.explanation, explanationSource(r.question_text, r.choices))) blockers.push("explanation looks cut off");
  const fmt = formattingProblems(r.explanation);
  if (fmt.length) blockers.push(`explanation formatting: ${fmt[0]}`);
  for (const id of failing) blockers.push(`check: ${id}`);
  return blockers;
}

export function decideVerification(
  r: VerifyRow,
  ch: VerifyChecks,
  live: boolean,
  now = new Date(),
): VerifyDecision {
  const key = (r.correct_answer ?? "").trim();
  const isMc = r.question_type !== SPR_TYPE;
  const date = now.toISOString().slice(0, 10);
  const summary = checksSummary(ch, key);
  const solves = [ch.first, ch.second].filter((c): c is SolveCheck => !!c);
  const answered = solves.filter((c) => c.answer);
  const none = (outcome: VerifyOutcome): VerifyDecision => ({ outcome, update: null, blockers: [], summary, approved: false });

  // Previous runs' verify notes are replaced.
  const base = splitNotes(r.parsing_notes).filter((s) => !s.startsWith(AI_KEY_DISAGREE_PREFIX) && !s.startsWith(AI_KEY_VERIFIED_PREFIX));

  const wrong = answered.filter((c) => !sameKey(c.answer, key, isMc, r.question_text));
  // A failed plug-back while both solves reach the key is most likely a bad
  // condition written by the model: inconclusive, not a disagreement.
  const plugFail = ch.plugBack?.status === "fail" && answered.length < 2;
  if (ch.plugBack?.status === "fail" && wrong.length === 0 && !plugFail) {
    return { ...none("unverified"), summary: `${summary} — plug-back failed although both solves give the key` };
  }
  if (wrong.length > 0 || plugFail) {
    const w = wrong[0];
    const value = w && w.value != null && Number.isFinite(w.value) ? String(+w.value.toPrecision(8)) : null;
    const d: AiKeyDisagreement = {
      key,
      ai: w?.answer ?? "?",
      value: value && value !== w?.answer ? value : null,
      detail: `${summary} [verify-ai-key ${date}]`,
    };
    const notes = [...base, aiKeyDisagreeNote(d)];
    const update: Record<string, unknown> = { updated_at: now.toISOString() };
    let joined = notes.join("; ");
    if (r.parsing_status === "Approved") {
      if (live && !joined.startsWith(LIVE_FIX_TAG)) {
        joined = `${LIVE_FIX_TAG} AI key check disagrees with the key while this question is in a live test; kept Approved — please re-check. ${joined}`;
      }
    } else if (!live) {
      update.parsing_status = "Needs Review";
    }
    update.parsing_notes = joined;
    return { outcome: "disagree", update, blockers: [], summary, approved: false, disagreement: d };
  }
  if (answered.length === 0) return none("no-answer");

  const complete =
    ch.section === "Reading & Writing"
      ? !!ch.first?.answer && !!ch.second?.answer
      : !!ch.first?.answer && !!ch.second?.answer && ch.plugBack?.status === "pass";
  const explanationOther = explanationArguesOther(r.explanation, key, r.question_type, r.question_text);
  if (!complete || explanationOther || !(r.explanation ?? "").trim()) {
    return { ...none("unverified"), summary: `${summary}${explanationOther ? ` — ${explanationOther}` : !complete ? " — a check could not run" : " — no explanation"}` };
  }

  // Verified.
  const kept = base.filter((s) => !isAiOnlyKeyNote(s));
  const blockers = r.parsing_status === "Needs Review" ? approvalBlockers(r, kept) : [];
  const notes = [...kept, aiKeyVerifiedNote(summary, date)].join("; ");
  const update: Record<string, unknown> = { parsing_notes: notes, updated_at: now.toISOString() };
  let approved = false;
  if (r.parsing_status === "Needs Review" && blockers.length === 0 && !live) {
    update.parsing_status = "Approved";
    approved = true;
  }
  return { outcome: "verified", update, blockers, summary, approved };
}

// ── AI calls ─────────────────────────────────────────────────────────

export interface VerifyQuestion {
  id: string;
  question_type: string | null;
  section?: string | null;
  question_text: string | null;
  choices: unknown;
  correct_answer: string | null;
  image_urls?: unknown;
}

type Block = { type: "image"; image: string; mediaType: string } | { type: "text"; text: string };

async function figureBlocks(q: VerifyQuestion): Promise<Block[]> {
  const out: Block[] = [];
  const urls = Array.isArray(q.image_urls) ? (q.image_urls as string[]) : [];
  for (const url of urls.slice(0, 4)) {
    const f = await fetchImageAsBase64(url);
    if (f) out.push({ type: "image", image: f.base64, mediaType: f.mediaType });
  }
  for (const c of (Array.isArray(q.choices) ? q.choices : []) as ChoiceLike[]) {
    if (!c.image_url) continue;
    const f = await fetchImageAsBase64(c.image_url);
    if (f) out.push({ type: "text", text: `Choice ${c.label}:` }, { type: "image", image: f.base64, mediaType: f.mediaType });
  }
  return out;
}

function questionPrompt(q: VerifyQuestion): string {
  const isSpr = q.question_type === SPR_TYPE;
  const choices = (Array.isArray(q.choices) ? q.choices : []) as ChoiceLike[];
  const ch = isSpr ? "" : choices.map((c) => `${c.label}) ${c.text || (c.image_url ? `(a graph — see the image labelled "Choice ${c.label}")` : "")}`).join("\n");
  return curlyQuotes(`Question (${isSpr ? "Student Produced Response — the answer is a number" : "Multiple Choice — one letter A/B/C/D"}):\n${q.question_text ?? ""}${ch ? `\n\nChoices:\n${ch}` : ""}`);
}

const MODEL_A = "claude-sonnet-4-6";
const MODEL_B = "claude-opus-4-8";

async function ask(
  model: string,
  system: string,
  blocks: Block[],
  prompt: string,
  route: string,
  q: VerifyQuestion,
  callerUserId?: string,
): Promise<string> {
  const res = await generateText({
    model: anthropic(model),
    system,
    maxOutputTokens: 3000,
    maxRetries: 3,
    messages: [{ role: "user", content: [...blocks, { type: "text", text: prompt }] }],
  });
  const inTok = res.usage?.inputTokens ?? 0;
  const outTok = res.usage?.outputTokens ?? 0;
  const [pin, pout] = model.includes("opus") ? [1500, 7500] : [300, 1500];
  await logUsage({
    userId: callerUserId,
    route,
    tokensInput: inTok,
    tokensOutput: outTok,
    model,
    costCents: Math.round((inTok / 1_000_000) * pin + (outTok / 1_000_000) * pout),
    metadata: { question_id: q.id },
  });
  return res.text;
}

const TAG_OUTPUT = `Reply with ONLY these tags (plain text inside, no JSON, quotes need no escaping):`;

/** Math check 1: the model writes the computation; code evaluates it and maps it to a choice. */
export async function codeSolve(q: VerifyQuestion, blocks: Block[], callerUserId?: string): Promise<SolveCheck> {
  const isSpr = q.question_type === SPR_TYPE;
  const system = `You are an expert SAT math solver. Solve the question independently and rigorously.

${SPR_COMPUTATION_RULE}

For Multiple Choice too: put in <answer_expression> a plain arithmetic expression (numbers, + - * / ** ( ), sqrt(), abs(), pi) whose value is the quantity the question asks for — the value of the correct choice — unrounded. Leave it empty only when the choices are not numbers (equations, expressions with variables, words, graphs).

${TAG_OUTPUT}
<work>a few lines of working</work>
<answer>${isSpr ? "the value to enter" : "the single letter A/B/C/D"}</answer>
<answer_expression>the arithmetic expression, or empty</answer_expression>
<check_equation>optional: one equation from the problem the answer must satisfy, with ans for the answer (e.g. 3*ans + 7 == 31), or empty</check_equation>`;
  const raw = await ask(MODEL_A, system, blocks, `${questionPrompt(q)}\n\nSolve it.`, "verify-ai-key", q, callerUserId);
  const declared = cleanTagText(readTag(raw, "answer")).replace(/\$/g, "");
  const expression = cleanTagText(readTag(raw, "answer_expression"));
  const checkEquation = cleanTagText(readTag(raw, "check_equation"));
  if (isSpr) {
    const c = checkComputedAnswer({ declared, expression, checkEquation, questionText: q.question_text });
    if (!expression) c.problems.push("no computation given");
    return { answer: c.answer, value: c.value, method: "code", problems: c.problems };
  }
  const letter = letterOf(declared);
  const value = expression ? tryEvaluate(expression) : null;
  const choices = (Array.isArray(q.choices) ? q.choices : []) as ChoiceLike[];
  if (value !== null) {
    const mapped = mapValueToChoice(value, choices);
    if (mapped) {
      const problems = letter && letter !== mapped ? [`the model said ${letter} but its computation ${+value.toPrecision(8)} is choice ${mapped}`] : [];
      return { answer: mapped, value, mapped: true, method: "code", problems };
    }
    const numericChoices = choices.length > 0 && choices.every((c) => !c.image_url && choiceValue(c.text) !== null);
    if (numericChoices) {
      // The computation matches no choice: no code answer (inconclusive, not a vote).
      return { answer: null, value, mapped: true, method: "code", problems: [`computed ${+value.toPrecision(8)} matches no choice`] };
    }
  }
  return { answer: letter, value: null, mapped: false, method: "code", problems: letter ? [] : [`no letter answer ("${declared.slice(0, 40)}")`] };
}

/** Evaluate one condition ("2*ans+3 == 11", "ans > 4") with ans = value. Null = unreadable. */
export function conditionHolds(cond: string, ans: number | null, tol = 0): boolean | null {
  const m = cond.replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/≠/g, "!=").match(/^(.+?)(==|!=|<=|>=|<|>|=)(.+)$/);
  if (!m) return null;
  const vars: Record<string, number> = ans === null ? {} : { ans, x: ans };
  const l = tryEvaluate(m[1], vars);
  const r = tryEvaluate(m[3], vars);
  if (l === null || r === null) return null;
  const eq = nearlyEqual(l, r) || Math.abs(l - r) <= tol;
  switch (m[2]) {
    case "==":
    case "=":
      return eq;
    case "!=":
      return !eq;
    case "<=":
      return l <= r || eq;
    case ">=":
      return l >= r || eq;
    case "<":
      return l < r;
    case ">":
      return l > r;
  }
  return null;
}

/** Math check 2: substitute the STORED key back into the problem; code evaluates every condition. */
export async function plugBackKey(q: VerifyQuestion, blocks: Block[], callerUserId?: string): Promise<PlugBackCheck> {
  const key = (q.correct_answer ?? "").trim();
  const isSpr = q.question_type === SPR_TYPE;
  const choices = (Array.isArray(q.choices) ? q.choices : []) as ChoiceLike[];
  const keyChoice = isSpr ? null : choices.find((c) => (c.label ?? "").toUpperCase() === letterOf(key));
  const proposed = isSpr ? key : `${letterOf(key)}) ${keyChoice?.text ?? ""}`;
  const system = `You check a PROPOSED answer to an SAT math question by substituting it back into the problem. Do not solve the problem from scratch and do not judge the other choices.

1. <key_value>: the exact numeric value of the proposed answer as a plain arithmetic expression (numbers, + - * / ** ( ), sqrt(), pi). If the proposed answer was rounded ("to the nearest tenth"), give the UNROUNDED exact value that it is the rounding of. Empty if the proposed answer is not a single number (an equation, an expression with variables, words, a graph).
2. <conditions>: 1–4 conditions from the problem that the proposed answer must satisfy, one per line, each a plain arithmetic comparison using ==, <, >, <= or >= (Python/JS style). Use ans for key_value when there is one. When the answer is an equation or expression, substitute concrete numbers from the problem instead (e.g. for "y = 2x + 3" through (1, 5): 2*1 + 3 == 5). Each condition must check the PROPOSED answer against the GIVEN information — never restate the proposed answer itself (no "ans == 6").

${TAG_OUTPUT}
<key_value>expression or empty</key_value>
<conditions>
one condition per line
</conditions>`;
  const raw = await ask(MODEL_A, system, blocks, `${questionPrompt(q)}\n\nPROPOSED ANSWER: ${curlyQuotes(proposed)}\n\nSubstitute it back.`, "verify-ai-key-plugback", q, callerUserId);
  const kvExpr = cleanTagText(readTag(raw, "key_value"));
  const conds = cleanTagText(readTag(raw, "conditions"))
    .split("\n")
    // List markers only ("- ", "1. ") — never a leading "-3*".
    .map((l) => l.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").replace(/\$/g, "").trim())
    .filter((l) => /(==|<=|>=|<|>|=)/.test(l));
  let ans: number | null = kvExpr ? tryEvaluate(kvExpr) : null;
  // The value must really be the stored key (rounded the way the question asks).
  if (ans !== null) {
    const rule = roundingInstruction(q.question_text);
    const keyNum = isSpr ? keyCandidates(key).map((c) => sprValue(c)).find((v) => v !== null) ?? null : choiceValue(keyChoice?.text);
    if (keyNum !== null && keyNum !== undefined) {
      const same = rule ? nearlyEqual(applyRounding(ans, rule.places), applyRounding(keyNum, rule.places), 1e-9) : nearlyEqual(ans, keyNum, 1e-6) || Math.abs(ans - keyNum) < 1e-4;
      if (!same) ans = keyNum;
    }
  } else if (isSpr) {
    ans = keyCandidates(key).map((c) => sprValue(c)).find((v) => v !== null) ?? null;
  }
  if (conds.length === 0) return { status: "n/a", detail: "no conditions" };
  const results = conds.map((c) => ({ c, ok: conditionHolds(c, ans, 1e-6 * Math.max(1, Math.abs(ans ?? 0))) }));
  const readable = results.filter((x) => x.ok !== null);
  if (readable.length === 0) return { status: "n/a", detail: `no condition could be evaluated (${conds[0].slice(0, 60)})` };
  const failed = readable.filter((x) => x.ok === false);
  if (failed.length > 0) return { status: "fail", detail: failed.map((x) => x.c.slice(0, 80)).join(" | ") };
  return { status: "pass", detail: `${readable.length} condition${readable.length > 1 ? "s" : ""}` };
}

/** Independent solve by a different model and method. `variant` picks the method. */
export async function independentSolve(
  q: VerifyQuestion,
  blocks: Block[],
  variant: "math-alt" | "rw-standard" | "rw-eliminate",
  callerUserId?: string,
): Promise<SolveCheck> {
  const isSpr = q.question_type === SPR_TYPE;
  const method =
    variant === "math-alt"
      ? `Use a DIFFERENT method from the textbook one: for Multiple Choice, test each choice against the conditions (work backwards) and keep the only one that works; for a fill-in, solve by an alternative route (e.g. substitution instead of elimination, a diagram, or estimation followed by an exact check) and confirm the value satisfies the problem.`
      : variant === "rw-eliminate"
        ? `Method: go through ALL FOUR choices. For each, quote the words of the text that rule it out or support it. Keep the only choice the text fully supports.`
        : `Read the text closely, decide what the question requires, and pick the best-supported choice.`;
  const system = `You are an expert SAT ${variant === "math-alt" ? "math" : "Reading and Writing"} solver. Solve independently. ${method}
${isSpr ? `\nThe answer is a number in SAT grid form (integer, decimal or fraction such as 7/2); apply any rounding the question asks for.\n` : ""}
${TAG_OUTPUT}
<work>your reasoning, briefly</work>
<answer>${isSpr ? "the value only (no units, no $)" : "the single letter A/B/C/D"}</answer>`;
  const model = variant === "rw-standard" ? MODEL_A : MODEL_B;
  const raw = await ask(model, system, blocks, `${questionPrompt(q)}\n\nSolve it.`, `verify-ai-key-${variant}`, q, callerUserId);
  const a = cleanTagText(readTag(raw, "answer")).replace(/\$/g, "").trim();
  if (isSpr) {
    const v = sprValue(normalizeKeyText(a)) ?? tryEvaluate(a);
    return { answer: a || null, value: v, method: variant, problems: a ? [] : ["no answer"] };
  }
  const l = letterOf(a);
  return { answer: l, method: variant, problems: l ? [] : [`no letter ("${a.slice(0, 40)}")`] };
}

/** Run every check for one question. */
export async function runChecks(q: VerifyQuestion, callerUserId?: string): Promise<VerifyChecks> {
  const blocks = await figureBlocks(q);
  const isMath = q.section === "Math";
  const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      console.error(`[verify-ai-key] ${q.id}:`, e instanceof Error ? e.message : e);
      return fallback;
    }
  };
  const failed = (method: string): SolveCheck => ({ answer: null, method, problems: ["AI call failed"] });
  if (isMath) {
    const plug = () => safe(() => plugBackKey(q, blocks, callerUserId), { status: "n/a", detail: "AI call failed" } as PlugBackCheck);
    const [first, firstPlug, second] = await Promise.all([
      safe(() => codeSolve(q, blocks, callerUserId), failed("code")),
      plug(),
      safe(() => independentSolve(q, blocks, "math-alt", callerUserId), failed("math-alt")),
    ]);
    // A failed or unreadable plug-back is re-done once with a fresh call:
    // the model sometimes writes a wrong condition, a wrong key fails both.
    let plugBack = firstPlug;
    if (firstPlug.status !== "pass") {
      const again = await plug();
      if (again.status !== "n/a") plugBack = { ...again, detail: `${again.detail}, on retry (first: ${firstPlug.status})` };
    }
    return { section: "Math", first, plugBack, second };
  }
  const [first, second] = await Promise.all([
    safe(() => independentSolve(q, blocks, "rw-standard", callerUserId), failed("rw-standard")),
    safe(() => independentSolve(q, blocks, "rw-eliminate", callerUserId), failed("rw-eliminate")),
  ]);
  return { section: "Reading & Writing", first, plugBack: null, second };
}

// ── Rows ─────────────────────────────────────────────────────────────

export const VERIFY_SELECT =
  "id, module_id, original_question_number, section, question_type, question_text, choices, correct_answer, official_answer, explanation, parsing_status, parsing_notes, has_image, image_urls, has_table, updated_at";

/** AI-only keys: no official answer, a stored key, not Rejected. */
export async function loadAiOnlyRows(db: SupabaseClient, moduleIds?: string[]): Promise<VerifyRow[]> {
  const out: VerifyRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db
      .from("questions")
      .select(VERIFY_SELECT)
      .is("official_answer", null)
      .not("correct_answer", "is", null)
      .neq("parsing_status", "Rejected")
      .order("module_id")
      .order("original_question_number")
      .range(from, from + 999);
    if (moduleIds) q = q.in("module_id", moduleIds);
    const { data, error } = await q;
    if (error) throw new Error(`loadAiOnlyRows: ${error.message}`);
    out.push(...((data ?? []) as VerifyRow[]));
    if (!data || data.length < 1000) break;
  }
  return out.filter((r) => (r.correct_answer ?? "").trim());
}
