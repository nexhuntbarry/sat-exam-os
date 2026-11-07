// lib/answer-key.ts
//
// Does a stored answer key fit its question type? (owner-approved
// "prevent wrong answer keys", 2026-11-07). Two incidents drove this:
//   - March 2024 A SAT Math M1 Q17 (fill-in) got key "C": the previous
//     question's choices C/D sat at the top of the next page and were
//     attached to Q17, then a choice letter became its key.
//   - Math Module 001 Test Q17 asked for the nearest whole number and got 249
//     (true value 248.2 → 248) because the arithmetic was done in text.
// Pure and client-safe: used by the parse pipeline, the approve gate, the
// key scanner and the review page.

import { equationHolds, nearlyEqual, tryEvaluate } from "@/lib/math/safe-eval";

export const SPR_TYPE = "Student Produced Response";
export const MC_TYPE = "Multiple Choice";

/** Shown next to the fill-in answer field on the review page. */
export const SPR_FORM_HELP =
  "Accepted: a whole number (12), a decimal (3.5, .75) or a fraction (7/2), with an optional minus sign. At most 5 characters (6 with a minus). Not allowed: %, $, commas, units, mixed numbers (3 1/2). Several acceptable answers: separate them with \" or \" (e.g. 7/2 or 3.5).";

/** parsing_notes segment prefix for a key that doesn't fit its type. */
export const KEY_FORM_NOTE_PREFIX = "Needs review: answer key check";

const MINUS_LOOKALIKES = /[‒–—−﹣－]/g;

/** NFKC, minus look-alikes, LaTeX \frac{a}{b} → a/b, $…$ wrapper removed. */
export function normalizeKeyText(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .normalize("NFKC")
    .trim()
    .replace(MINUS_LOOKALIKES, "-")
    .replace(/\\d?frac\{\s*(-?\d+)\s*\}\{\s*(\d+)\s*\}/g, "$1/$2")
    .replace(/^\$+([^$]*)\$+$/, "$1")
    .trim();
}

/** Longest answer key accepted (PATCH rejects longer; checks cap here). */
export const MAX_KEY_LENGTH = 200;

/**
 * The acceptable answers listed in one key — same split as
 * lib/grade-submission answerCandidates (" or ", "|", ";", newline, ", ").
 */
export function keyCandidates(key: string | null | undefined): string[] {
  if (!key) return [];
  // A real key is a few characters; cap the input so a pasted essay can't
  // make the split regex do much work.
  return String(key)
    .slice(0, MAX_KEY_LENGTH)
    .split(/\s*(?:\bor\b|[\n;|])\s*|,\s+|(?<=\D),(?=\D)/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

const INT = /^-?\d+$/;
const DEC = /^-?\d*\.\d+$/;
const FRAC = /^-?\d+\/\d+$/;

/** Numeric value of one accepted-form SPR entry, else null. */
export function sprValue(entry: string): number | null {
  const s = normalizeKeyText(entry);
  if (INT.test(s) || DEC.test(s)) return Number(s);
  if (FRAC.test(s)) {
    const [n, d] = s.split("/").map(Number);
    return d === 0 ? null : n / d;
  }
  return null;
}

/**
 * Why one fill-in (SPR) entry isn't in an accepted form, or null when it is.
 * Accepted: integer, decimal or fraction, optional leading "-"; at most 5
 * characters (6 with the minus). A leading "0." counts as "." (the grid
 * doesn't need the zero).
 */
export function sprEntryProblem(raw: string): string | null {
  const s = normalizeKeyText(raw);
  if (!s) return "is empty";
  if (/^\(?[A-Da-d]\)?$/.test(s)) return "is a choice letter, not a number";
  if (s.includes("%")) return "has a % sign (write the number only)";
  if (s.includes("$")) return "has a dollar sign (write the number only)";
  if (/\d,\d/.test(s)) return "has a comma (write 1000, not 1,000)";
  if (/^-?\d+\s+\d+\s*\/\s*\d+$/.test(s)) return "is a mixed number (write 7/2, not 3 1/2)";
  if (s.startsWith("+")) return "has a plus sign";
  if (/[A-Za-z°π√\\]/.test(s)) return "has letters, units or symbols (only digits, \".\", \"/\" and \"-\" are allowed)";
  const compact = s.replace(/\s+/g, "");
  if (!(INT.test(compact) || DEC.test(compact) || FRAC.test(compact))) return "isn't a number in an accepted form";
  if (FRAC.test(compact) && Number(compact.split("/")[1]) === 0) return "divides by zero";
  if (compact !== s) return "has spaces inside the number";
  const body = s.replace(/^-/, "");
  const entry = DEC.test(s) ? body.replace(/^0(?=\.)/, "") : body;
  if (entry.length > 5) return "is too long to enter (at most 5 characters, 6 with a minus sign)";
  return null;
}

export interface RoundingRule {
  /** Decimal places to keep (0 = whole number; -1 = nearest ten …). */
  places: number;
  label: string;
}

const ROUNDING_PATTERNS: Array<[RegExp, number, string]> = [
  [/nearest\s+ten[-\s]thousandths?\b/gi, 4, "nearest ten-thousandth"],
  [/nearest\s+thousandths?\b/gi, 3, "nearest thousandth"],
  [/nearest\s+hundredths?\b/gi, 2, "nearest hundredth"],
  [/nearest\s+tenths?\b/gi, 1, "nearest tenth"],
  [/nearest\s+cents?\b/gi, 2, "nearest cent"],
  [
    /nearest\s+(?:whole\s+(?:number|percent(?:age)?|dollar|degree|unit)s?|integers?|whole|percent(?:age\s+point)?s?|dollars?|degrees?)\b/gi,
    0,
    "nearest whole number",
  ],
  [/\btenths?\s+place\b/gi, 1, "nearest tenth"],
  [/\bhundredths?\s+place\b/gi, 2, "nearest hundredth"],
  [/nearest\s+million\b/gi, -6, "nearest million"],
  [/nearest\s+hundred[-\s]thousand\b/gi, -5, "nearest hundred thousand"],
  [/nearest\s+ten[-\s]thousand\b/gi, -4, "nearest ten thousand"],
  [/nearest\s+thousand\b/gi, -3, "nearest thousand"],
  [/nearest\s+hundred\b(?![-\s]thousand\b)/gi, -2, "nearest hundred"],
  [/nearest\s+ten\b(?![-\s]thousand\b)/gi, -1, "nearest ten"],
  [/\b(?:to\s+)?(one|1)\s+decimal\s+places?\b/gi, 1, "one decimal place"],
  [/\b(?:to\s+)?(two|2)\s+decimal\s+places\b/gi, 2, "two decimal places"],
  [/\b(?:to\s+)?(three|3)\s+decimal\s+places\b/gi, 3, "three decimal places"],
];

/**
 * The part of a stem that holds the question: from the last sentence with a
 * "?" to the end (so a trailing "Round to the nearest tenth." still counts),
 * or the final sentence when there is no "?". Data descriptions earlier in
 * the stem ("values rounded to the nearest tenth") are not instructions.
 */
export function questionSentence(questionText: string | null | undefined): string {
  // Split after . ? ! followed by whitespace (so "3.5" stays whole), and on
  // line breaks (tables, separate lines).
  const sentences = (questionText ?? "")
    .split(/(?<=[.?!])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (sentences.length === 0) return "";
  let q = -1;
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (sentences[i].includes("?")) {
      q = i;
      break;
    }
  }
  return q >= 0 ? sentences.slice(q).join(" ") : sentences[sentences.length - 1];
}

/**
 * The rounding the question asks for ("…to the nearest tenth"), or null.
 * Only the question sentence is read (questionSentence); when it names
 * several, the LAST one wins.
 */
export function roundingInstruction(questionText: string | null | undefined): RoundingRule | null {
  const text = questionSentence(questionText);
  let best: { index: number; rule: RoundingRule } | null = null;
  for (const [re, places, label] of ROUNDING_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!best || m.index > best.index) best = { index: m.index, rule: { places, label } };
    }
  }
  return best?.rule ?? null;
}

/** Round half away from zero to `places` (negative = tens, hundreds…). */
export function applyRounding(value: number, places: number): number {
  const f = 10 ** places;
  const r = (Math.sign(value) * Math.round(Math.abs(value) * f + 1e-9)) / f;
  return places > 0 ? Number(r.toFixed(places)) : r;
}

/** Is `value` already rounded to `places`? */
export function isRoundedTo(value: number, places: number): boolean {
  return nearlyEqual(applyRounding(value, places), value, 1e-9);
}

/** Why a numeric key breaks the question's rounding instruction (null = fine). */
export function roundingProblem(key: string, rule: RoundingRule | null): string | null {
  if (!rule) return null;
  for (const c of keyCandidates(key)) {
    const v = sprValue(c);
    if (v === null) continue;
    if (!isRoundedTo(v, rule.places)) {
      return `the question asks for the answer to the ${rule.label}, but "${c}" isn't rounded that way (${applyRounding(v, rule.places)} would be)`;
    }
  }
  return null;
}

function fitsEntry(s: string): boolean {
  return sprEntryProblem(s) === null;
}

/**
 * Turn a computed value into an accepted SPR entry, applying the question's
 * rounding. Without a rounding rule: exact integer/decimal/fraction when it
 * fits, else the SAT grid rule (a decimal that fills the 5 spaces).
 */
export function formatSprAnswer(value: number, rule: RoundingRule | null): string | null {
  if (!Number.isFinite(value)) return null;
  if (rule) {
    const r = applyRounding(value, rule.places);
    const s = rule.places > 0 ? String(Number(r.toFixed(rule.places))) : String(r);
    return fitsEntry(s) ? s : null;
  }
  if (nearlyEqual(value, Math.round(value), 1e-9)) {
    const s = String(Math.round(value));
    return fitsEntry(s) ? s : null;
  }
  for (let d = 1; d <= 4; d++) {
    const s = String(Number(value.toFixed(d)));
    if (nearlyEqual(Number(s), value, 1e-12) && fitsEntry(s)) return s;
  }
  for (let den = 2; den <= 9999; den++) {
    const num = Math.round(value * den);
    if (Math.abs(num / den - value) < 1e-9) {
      const s = `${num}/${den}`;
      if (fitsEntry(s)) return s;
      break;
    }
  }
  for (let d = 4; d >= 0; d--) {
    const s = String(Number(value.toFixed(d)));
    if (fitsEntry(s)) return s;
  }
  return null;
}

/** Why a Multiple Choice key isn't a valid letter (null = fine). */
export function mcKeyProblem(key: string, choices?: unknown): string | null {
  const cands = keyCandidates(key);
  if (cands.length === 0) return null;
  const labels = new Set(
    (Array.isArray(choices) ? choices : [])
      .map((c) => (c && typeof c === "object" ? String((c as { label?: string }).label ?? "").toUpperCase() : ""))
      .filter(Boolean),
  );
  for (const c of cands) {
    const letter = normalizeKeyText(c).replace(/^\(([A-Da-d])\)$/, "$1");
    if (!/^[A-Da-d]$/.test(letter)) return `"${c}" isn't a choice letter A–D`;
    if (labels.size > 0 && !labels.has(letter.toUpperCase())) return `"${c}" isn't one of this question's choices`;
  }
  return null;
}

function hasChoices(choices: unknown): boolean {
  return (
    Array.isArray(choices) &&
    choices.some((c) => {
      if (typeof c === "string") return c.trim().length > 0;
      const cc = c as { text?: string | null; image_url?: string | null } | null;
      return ((cc?.text ?? "").trim().length > 0) || !!cc?.image_url;
    })
  );
}

export type KeyProblemCode = "key-too-long" | "spr-letter-key" | "spr-invalid-form" | "spr-rounding" | "spr-has-choices" | "mc-invalid-key";

export interface KeyProblem {
  code: KeyProblemCode;
  /** Plain-language reason, e.g. for "Can't approve: …". */
  reason: string;
}

/**
 * Does the key fit the question type? Null when it does, or when there is no
 * type or no key to check (a missing key is the completeness gate's job).
 */
export function keyTypeProblem(q: {
  question_type: string | null | undefined;
  correct_answer: string | null | undefined;
  question_text?: string | null;
  choices?: unknown;
}): KeyProblem | null {
  const key = (q.correct_answer ?? "").trim();
  if (key.length > MAX_KEY_LENGTH) {
    return { code: "key-too-long", reason: `the answer key is longer than ${MAX_KEY_LENGTH} characters` };
  }
  if (q.question_type === SPR_TYPE) {
    if (key) {
      const cands = keyCandidates(key);
      const letter = cands.find((c) => /^\(?[A-Da-d]\)?$/.test(normalizeKeyText(c)));
      if (letter) {
        return {
          code: "spr-letter-key",
          reason: `this is a Fill-in (SPR) question but its key "${key}" is a choice letter — enter the number, or switch it to Multiple choice`,
        };
      }
      for (const c of cands) {
        const p = sprEntryProblem(c);
        if (p) return { code: "spr-invalid-form", reason: `the Fill-in (SPR) key "${c}" ${p}` };
      }
      const r = roundingProblem(key, roundingInstruction(q.question_text));
      if (r) return { code: "spr-rounding", reason: r };
    }
    if (hasChoices(q.choices)) {
      return {
        code: "spr-has-choices",
        reason: "a Fill-in (SPR) question can't have answer choices — remove them, or switch it to Multiple choice",
      };
    }
    return null;
  }
  if (q.question_type === MC_TYPE && key) {
    const p = mcKeyProblem(key, q.choices);
    if (p) {
      return {
        code: "mc-invalid-key",
        reason: `this is a Multiple choice question but its key ${p}${sprValue(key) !== null && !hasChoices(q.choices) ? " — it looks like a Fill-in (SPR) answer" : ""}`,
      };
    }
  }
  return null;
}

/** parsing_notes segment for a key problem (one segment, no ";"). */
export function keyFormNote(p: KeyProblem): string {
  return `${KEY_FORM_NOTE_PREFIX} (${p.code}) — ${p.reason.replace(/;/g, ",")}.`;
}

// ── Computed answers ────────────────────────────────────────────────

export interface ComputedAnswerCheck {
  /** Value of the computation, before rounding. */
  value: number | null;
  /** The key to store: the computed value in accepted SPR form, rounded as asked. */
  answer: string | null;
  /** Each disagreement found; empty = consistent. */
  problems: string[];
}

/**
 * Check an AI fill-in answer against its own computation. The expression is
 * evaluated in code (lib/math/safe-eval), the question's rounding rule is
 * applied in code, and an optional plug-back equation ("3*ans + 7 == 31") is
 * checked with the unrounded value. Any disagreement goes in `problems`.
 */
export function checkComputedAnswer(input: {
  declared: string | null | undefined;
  expression: string | null | undefined;
  checkEquation?: string | null;
  questionText: string | null | undefined;
}): ComputedAnswerCheck {
  const problems: string[] = [];
  const rule = roundingInstruction(input.questionText);
  const declared = normalizeKeyText(input.declared ?? "");
  const expr = (input.expression ?? "").trim();
  let value: number | null = null;
  if (expr) {
    value = tryEvaluate(expr);
    if (value === null) problems.push(`couldn't evaluate the computation "${expr.slice(0, 80)}"`);
  }
  const computed = value !== null ? formatSprAnswer(value, rule) : null;
  if (value !== null && computed === null) problems.push(`the computed value ${value} can't be entered as a fill-in answer`);

  const dv = declared ? sprValue(declared) : null;
  if (declared && dv === null && !/^\(?[A-Da-d]\)?$/.test(declared)) {
    // Not a plain number (e.g. "248.2 → 248"): only the computation counts.
  } else if (dv !== null && value !== null) {
    if (rule) {
      if (!nearlyEqual(applyRounding(dv, rule.places), applyRounding(value, rule.places), 1e-9)) {
        problems.push(`stated answer ${declared} ≠ computed ${computed ?? value} (${rule.label})`);
      } else if (!isRoundedTo(dv, rule.places)) {
        problems.push(`stated answer ${declared} isn't rounded to the ${rule.label}`);
      }
    } else {
      const decimals = (declared.split(".")[1] ?? "").length;
      // A decimal that fills the grid may be the rounded or truncated value.
      const tol = decimals >= 3 ? 10 ** -decimals : 0;
      if (!(nearlyEqual(dv, value) || Math.abs(dv - value) < tol)) {
        problems.push(`stated answer ${declared} ≠ computed ${computed ?? value}`);
      }
    }
  } else if (/^\(?[A-Da-d]\)?$/.test(declared)) {
    problems.push(`stated answer "${declared}" is a choice letter`);
  }

  if (value !== null && input.checkEquation && input.checkEquation.trim()) {
    const ok = equationHolds(input.checkEquation, { ans: value, x: value });
    if (ok === false) problems.push(`plug-back check "${input.checkEquation.slice(0, 80)}" fails for ${value}`);
  }

  let answer = computed;
  if (!answer && dv !== null && !sprEntryProblem(declared)) {
    answer = rule && !isRoundedTo(dv, rule.places) ? formatSprAnswer(dv, rule) : declared;
  }
  return { value, answer, problems };
}

/**
 * Do two answers agree for this question? Letters compare as letters;
 * fill-in values compare numerically after the question's rounding rule
 * (so 248.2 and 248 agree when the stem asks for the nearest whole number).
 * Any candidate of `b` may match (keys can list several acceptable answers).
 */
export function answersAgreeForQuestion(
  a: string | null | undefined,
  b: string | null | undefined,
  questionText?: string | null,
): boolean {
  const x = normalizeKeyText(a);
  if (!x || !b) return false;
  const letter = (s: string) => normalizeKeyText(s).replace(/^\(?\s*([A-Da-d])\)?(?:\W.*)?$/, "$1").toUpperCase();
  const rule = roundingInstruction(questionText);
  const xv = sprValue(x) ?? tryEvaluate(x);
  for (const cand of keyCandidates(b)) {
    const cv = sprValue(cand) ?? tryEvaluate(normalizeKeyText(cand));
    if (xv !== null && cv !== null) {
      if (rule ? nearlyEqual(applyRounding(xv, rule.places), applyRounding(cv, rule.places), 1e-9) : nearlyEqual(xv, cv)) return true;
      continue;
    }
    if (letter(x) === letter(cand) && /^[A-D]$/.test(letter(x))) return true;
    if (x.replace(/\s+/g, "").toLowerCase() === normalizeKeyText(cand).replace(/\s+/g, "").toLowerCase()) return true;
  }
  return false;
}
