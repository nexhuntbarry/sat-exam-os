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
  /** The official key: a verified official number longer than 5/6
   *  characters (e.g. 1905.12) is allowed; the answer box widens for it. */
  official_answer?: string | null;
}): KeyProblem | null {
  const key = (q.correct_answer ?? "").trim();
  if (key.length > MAX_KEY_LENGTH) {
    return { code: "key-too-long", reason: `the answer key is longer than ${MAX_KEY_LENGTH} characters` };
  }
  const official = new Set(keyCandidates(q.official_answer).map((c) => normalizeKeyText(c)));
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
        if (p && p.startsWith("is too long") && official.has(normalizeKeyText(c))) continue;
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

  // Several correct answers ("5 or -13"): keep every one, each in accepted
  // form; the computation must give one of them.
  const declaredCands = keyCandidates(declared);
  if (declaredCands.length > 1 && declaredCands.every((c) => sprValue(c) !== null)) {
    const forms = declaredCands.map((c) => formatSprAnswer(sprValue(c) as number, rule));
    if (forms.some((f) => f === null)) problems.push(`one of the stated answers ${declared} can't be entered as a fill-in answer`);
    if (value !== null && !declaredCands.some((c) => nearlyEqual(applyRounding(sprValue(c) as number, rule?.places ?? 9), applyRounding(value, rule?.places ?? 9), 1e-9))) {
      problems.push(`none of the stated answers ${declared} matches the computed ${computed ?? value}`);
    }
    if (value !== null && input.checkEquation && input.checkEquation.trim()) {
      const ok = equationHolds(input.checkEquation, { ans: value, x: value });
      if (ok === false) problems.push(`plug-back check "${input.checkEquation.slice(0, 80)}" fails for ${value}`);
    }
    const unique = [...new Set(forms.filter((f): f is string => f !== null))];
    return { value, answer: unique.length ? unique.join(" or ") : computed, problems };
  }

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

// ── Official College Board fill-in (SPR) entry rules ────────────────
// Owner-approved 2026-11-07, from the SAT practice test directions /
// Bluebook: one answer only; at most 5 characters (6 with a leading minus);
// a fraction that doesn't fit becomes a decimal; a decimal that doesn't fit
// is truncated or rounded at the 4th digit, filling every space; mixed
// numbers, %, commas and $ are not credited. A rounding instruction in the
// question ("nearest tenth") overrides the fill-the-space rule.

/** Characters an SPR entry may use (positive; one more for a leading minus). */
export const SPR_MAX_CHARS = 5;

/** Bluebook-style directions shown beside every fill-in question. */
export const SPR_DIRECTIONS: string[] = [
  "If you find more than one correct answer, enter only one answer.",
  "You can enter up to 5 characters for a positive answer and up to 6 characters (including the negative sign) for a negative answer.",
  "If your answer is a fraction that doesn't fit in the provided space, enter the decimal equivalent.",
  "If your answer is a decimal that doesn't fit in the provided space, enter it by truncating or rounding at the fourth digit.",
  "If your answer is a mixed number (such as 3 1/2), enter it as an improper fraction (7/2) or its decimal equivalent (3.5).",
  "Don't enter symbols such as a percent sign, comma, or dollar sign.",
];

/** The examples table from the directions. */
export const SPR_EXAMPLES: Array<{ answer: string; accepted: string[]; notAccepted: string[] }> = [
  { answer: "3.5", accepted: ["3.5", "3.50", "7/2"], notAccepted: ["31/2", "3 1/2"] },
  { answer: "2/3", accepted: ["2/3", ".6666", ".6667", "0.666", "0.667"], notAccepted: ["0.66", ".66", "0.67", ".67"] },
  { answer: "-1/3", accepted: ["-1/3", "-.3333", "-0.333"], notAccepted: ["-.33", "-0.33"] },
];

/**
 * What the answer box keeps of what was typed or pasted: digits, ".", "/"
 * and a leading "-" only, at most 5 characters (6 when it starts with "-").
 * Full-width digits and minus look-alikes are mapped first.
 */
export function sanitizeSprInput(raw: string, maxChars: number = SPR_MAX_CHARS + 1): string {
  const s = String(raw ?? "").normalize("NFKC").replace(MINUS_LOOKALIKES, "-");
  let out = "";
  for (const ch of s) {
    if (/[0-9./]/.test(ch)) out += ch;
    else if (ch === "-" && out.length === 0) out += ch;
  }
  // A longer verified key (sprInputMaxChars) widens the box for everyone.
  const limit = maxChars > SPR_MAX_CHARS + 1 ? maxChars : out.startsWith("-") ? SPR_MAX_CHARS + 1 : SPR_MAX_CHARS;
  return out.slice(0, limit);
}

/** A student entry in compact form (NFKC, minus mapped, spaces around "/" removed). */
function compactEntry(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .trim()
    .replace(MINUS_LOOKALIKES, "-")
    .replace(/\s*\/\s*/g, "/");
}

/**
 * Value of a student entry under the official rules, or null when it can't
 * be credited at all. Only an integer, decimal or fraction with an optional
 * leading minus ("3.5", ".75", "-7/2"); commas, %, $, units, mixed numbers,
 * "+", two numbers or a zero denominator → null.
 */
export function parseSprEntry(raw: string | null | undefined): number | null {
  // No real entry is this long (the box allows ≤ 6, verified long keys ≤ 14).
  // Caps a crafted autosave: a 309-digit string is Infinity, and a relative
  // comparison would treat Infinity as equal to every key.
  if (raw != null && String(raw).length > 32) return null;
  let s = compactEntry(raw);
  if (/^-?\d+\.$/.test(s)) s = s.slice(0, -1); // "2." is 2 (the box lets you type it)
  let v: number | null = null;
  if (INT.test(s) || DEC.test(s)) v = Number(s);
  else if (FRAC.test(s)) {
    const [n, d] = s.split("/").map(Number);
    v = d === 0 ? null : n / d;
  }
  return v !== null && Number.isFinite(v) ? v : null;
}

/** Can v be entered exactly as a decimal (or integer) within the space? */
export function fitsExactDecimal(v: number): boolean {
  const a = Math.abs(v);
  for (let d = 0; d <= 4; d++) {
    const str = a.toFixed(d).replace(/^0\./, ".");
    if (str.length <= SPR_MAX_CHARS && Math.abs(Number(str) - a) < 1e-9) return true;
  }
  return false;
}

/**
 * The decimals that fill every space, truncated and rounded, for a value
 * whose exact decimal doesn't fit (2/3 → .6666, .6667, 0.666, 0.667;
 * -1/3 → -.3333, -0.333; 214/3 → 71.33).
 */
export function fillDecimalForms(v: number): string[] {
  if (!Number.isFinite(v)) return [];
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  const intStr = String(Math.trunc(a));
  const variants: Array<{ dropZero: boolean; d: number }> =
    intStr === "0"
      ? [{ dropZero: true, d: 4 }, { dropZero: false, d: 3 }]
      : [{ dropZero: false, d: SPR_MAX_CHARS - intStr.length - 1 }];
  const out: string[] = [];
  for (const { dropZero, d } of variants) {
    if (d < 1) continue;
    const scale = 10 ** d;
    for (const x of [Math.trunc(a * scale + 1e-7) / scale, Math.round(a * scale) / scale]) {
      let s = x.toFixed(d);
      if (dropZero) s = s.replace(/^0(?=\.)/, "");
      if (s.length !== SPR_MAX_CHARS || Number(s) === 0) continue;
      const full = sign + s;
      if (!out.includes(full)) out.push(full);
    }
  }
  return out;
}

/** Simplest fraction p/q (q ≤ 9999) equal to v, or null. */
function exactFraction(v: number): { p: number; q: number } | null {
  for (let q = 1; q <= 9999; q++) {
    const p = Math.round(v * q);
    if (Math.abs(p / q - v) < 1e-9) return { p, q };
  }
  return null;
}

/** Numeric value of a key candidate (a key may still carry "1,000"-style grouping). */
function keyNumber(cand: string): number | null {
  const s = normalizeKeyText(cand).replace(/\s*\/\s*/g, "/");
  const v = sprValue(s);
  if (v !== null) return v;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  return null;
}

/**
 * A key written as a decimal that fills the space (".6667", "0.667",
 * "71.33") is often the rounded or truncated form of a simple fraction.
 * Returns that fraction's value (smallest denominator ≤ 20) when the
 * decimal is one of its fill forms, else null.
 */
export function impliedExactValue(cand: string): number | null {
  const s = normalizeKeyText(cand);
  // At least 3 decimals: a 2-decimal key ("12.86", "71.33") is far more
  // often exact than a rounded fraction, and inferring one would credit a
  // neighbouring wrong value (12.85 for an exact 12.86).
  if (!/^-?\d*\.\d{3,}$/.test(s)) return null;
  // Only a decimal that exactly fills the space (".6667", "0.667", "71.33").
  const body = s.replace(/^-/, "");
  if (body.length !== SPR_MAX_CHARS && body.replace(/^0(?=\.)/, "").length !== SPR_MAX_CHARS) return null;
  const k = Number(s);
  const d = (s.split(".")[1] ?? "").length;
  const scale = 10 ** d;
  // Small denominators only: a key like 0.018 or 11.25 is exact, not 1/53.
  for (let q = 2; q <= 20; q++) {
    const w = Math.round(k * q) / q;
    if (fitsExactDecimal(w) || Math.sign(w) !== Math.sign(k)) continue;
    const a = Math.abs(w);
    const t = Math.trunc(a * scale + 1e-7) / scale;
    const r = Math.round(a * scale) / scale;
    if (Math.abs(t - Math.abs(k)) < 1e-9 || Math.abs(r - Math.abs(k)) < 1e-9) return w;
  }
  return null;
}

/**
 * Is a student's fill-in entry credited for one numeric key candidate?
 *   - its value equals the key exactly (any form: 7/2, 3.5, 3.50); or
 *   - with a rounding instruction in the question: it equals the key
 *     rounded as asked (the fill-the-space rule doesn't apply); or
 *   - without one, when the exact decimal doesn't fit: it is the truncated
 *     or rounded decimal that fills every space.
 * Returns null when the candidate isn't numeric (the caller compares text).
 */
export function sprEntryCreditedForCandidate(
  entry: string | null | undefined,
  cand: string,
  questionText?: string | null,
): boolean | null {
  const kv = keyNumber(cand);
  if (kv === null) return null;
  const sv = parseSprEntry(entry);
  if (sv === null) return false;
  if (nearlyEqual(sv, kv, 1e-9)) return true;
  const rule = roundingInstruction(questionText);
  if (rule) return nearlyEqual(sv, applyRounding(kv, rule.places), 1e-9);
  const implied = impliedExactValue(cand);
  if (implied !== null && nearlyEqual(sv, implied, 1e-9)) return true;
  const s = compactEntry(entry);
  for (const v of implied !== null ? [kv, implied] : [kv]) {
    if (!fitsExactDecimal(v) && fillDecimalForms(v).includes(s)) return true;
  }
  return false;
}

/** Exact forms of a value that fit the space: decimal ("0.5", ".5"), then the fraction. */
function exactForms(v: number): string[] {
  const out: string[] = [];
  if (fitsExactDecimal(v)) {
    const s = String(Number(v.toFixed(4)));
    out.push(s);
    if (/^-?0\./.test(s)) out.push(s.replace(/^(-?)0\./, "$1."));
  }
  if (!Number.isInteger(v)) {
    const f = exactFraction(v);
    const s = f ? `${f.p}/${f.q}` : null;
    if (s && s.replace(/^-/, "").length <= SPR_MAX_CHARS) out.push(s);
  }
  return out;
}

/**
 * Every entry form credited for one key candidate, for students and
 * explanations: "2/3" → ["2/3", ".6666", ".6667", "0.666", "0.667"].
 * A non-numeric candidate comes back as written.
 */
export function acceptedFormsForCandidate(cand: string, questionText?: string | null): string[] {
  const kv = keyNumber(cand);
  if (kv === null) return [normalizeKeyText(cand)];
  const rule = roundingInstruction(questionText);
  if (rule) {
    const r = applyRounding(kv, rule.places);
    const forms = exactForms(r);
    return forms.length ? forms : [String(r)];
  }
  const v = impliedExactValue(cand) ?? kv;
  const forms = exactForms(v);
  if (!fitsExactDecimal(v)) for (const f of fillDecimalForms(v)) if (!forms.includes(f)) forms.push(f);
  return forms.length ? forms : [normalizeKeyText(cand)];
}

/** Accepted forms for each answer listed in a key ("5 or -13" → [["5"], ["-13"]]). */
export function acceptedSprEntries(key: string | null | undefined, questionText?: string | null): string[][] {
  return keyCandidates(key).map((c) => acceptedFormsForCandidate(c, questionText));
}

function formsInWords(forms: string[]): string {
  if (forms.length <= 1) return forms[0] ?? "";
  return `${forms.slice(0, -1).join(", ")} or ${forms[forms.length - 1]}`;
}

/**
 * Closing line for an AI fill-in explanation: the final answer, then the
 * other entry forms that are credited, e.g.
 * "Answer: 2/3; .6666, .6667, 0.666 or 0.667 also accepted."
 */
export function sprAnswerLine(key: string | null | undefined, questionText?: string | null): string | null {
  const groups = acceptedSprEntries(key, questionText).filter((g) => g.length > 0);
  if (groups.length === 0) return null;
  const main = groups.map((g) => g[0]).join(" or ");
  const extra = groups.flatMap((g) => g.slice(1));
  return extra.length ? `Answer: ${main}; ${formsInWords(extra)} also accepted.` : `Answer: ${main}`;
}

/**
 * Explanation text ending in exactly one "Answer: …" line for a fill-in key
 * (replaces a trailing "Final answer: X" or an earlier "Answer: …" line).
 */
export function withSprAnswerLine(explanation: string, key: string | null | undefined, questionText?: string | null): string {
  const line = sprAnswerLine(key, questionText);
  if (!line) return explanation;
  const body = explanation.replace(/(?:^|\n)[ \t]*(?:\*\*)?(?:final\s+)?answer(?:\*\*)?\s*:[^\n]*\s*$/i, "").trimEnd();
  return body ? `${body}\n\n${line}` : line;
}

/**
 * Characters the answer box allows for one question: the official 5 (6 with
 * a minus), or more when a verified key is longer (e.g. "1905.12") — the box
 * must never make a question unanswerable. Only this number reaches the
 * browser, never the key.
 */
export function sprInputMaxChars(key: string | null | undefined): number {
  let max = SPR_MAX_CHARS + 1;
  for (const c of keyCandidates(key)) {
    const s = normalizeKeyText(c).replace(/\s*\/\s*/g, "/");
    if (keyNumber(s) !== null && /^[-0-9./]+$/.test(s)) max = Math.max(max, s.length);
  }
  return max;
}

/** "2/3, .6666, .6667, 0.666, 0.667" (several answers joined by " · or · "). */
export function acceptedAnswersText(key: string | null | undefined, questionText?: string | null): string {
  return acceptedSprEntries(key, questionText)
    .map((g) => g.join(", "))
    .join("  ·  or  ·  ");
}

export interface GradedAnswer {
  /** The key candidate as written. */
  candidate: string;
  /** Main accepted entries (exact form first, then fill-the-space decimals). */
  forms: string[];
  /** Other entries graded the same way (trailing zero, other exact forms, an equal fraction). */
  also: string[];
  /** A non-numeric key compared as text. */
  text: boolean;
}

export interface GradedAsCorrect {
  answers: GradedAnswer[];
  rule: RoundingRule | null;
  /** "Graded as correct: 6/13, .4615, 0.461, 0.462 (also 12/26)…" */
  summary: string;
}

/** Fits the answer box: 5 characters, 6 with a leading minus. */
function fitsBox(s: string): boolean {
  return s.replace(/^-/, "").length <= SPR_MAX_CHARS;
}

/** Same value with one trailing zero ("6.8" → "6.80", "12" → "12.0"), when it fits. */
function trailingZeroForm(s: string): string | null {
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const t = s.includes(".") ? `${s}0` : `${s}.0`;
  return fitsBox(t) ? t : null;
}

/** An unreduced fraction equal to v ("6/13" → "12/26"), when one fits. */
function equalFractionForm(v: number): string | null {
  if (Number.isInteger(v)) return null;
  const f = exactFraction(v);
  if (!f) return null;
  const s = `${2 * f.p}/${2 * f.q}`;
  return fitsBox(s) ? s : null;
}

/**
 * Every entry the grader (lib/grade-submission answersMatch →
 * sprEntryCreditedForCandidate) credits for a fill-in key, for the review
 * page: e.g. "6/13" → 6/13, .4615, 0.461, 0.462 (also 12/26); "6.8" with
 * "nearest tenth" in the question → 6.8 (also 6.80, 34/5). Built from the
 * same helpers the grader uses (keyNumber, roundingInstruction,
 * impliedExactValue, fillDecimalForms), and scripts/test-spr-rules.ts checks
 * every listed entry against answersMatch so the two can't drift. Only
 * entries that fit the answer box are listed.
 */
export function gradedAsCorrect(key: string | null | undefined, questionText?: string | null): GradedAsCorrect {
  const rule = roundingInstruction(questionText);
  const answers: GradedAnswer[] = keyCandidates(key).map((cand) => {
    const kv = keyNumber(cand);
    if (kv === null) return { candidate: cand, forms: [normalizeKeyText(cand)], also: [], text: true };
    const forms: string[] = [];
    const also: string[] = [];
    const push = (list: string[], s: string | null) => {
      if (s && fitsBox(s) && !forms.includes(s) && !also.includes(s)) list.push(s);
    };
    // The grader credits the key's exact value, plus (with a rounding rule)
    // the rounded value or (without one) the implied fraction and its
    // fill-the-space decimals.
    const values: number[] = [];
    if (rule) {
      const r = applyRounding(kv, rule.places);
      values.push(r);
      if (!nearlyEqual(r, kv, 1e-9)) values.push(kv);
    } else {
      values.push(impliedExactValue(cand) ?? kv);
      if (!nearlyEqual(values[0], kv, 1e-9)) values.push(kv);
    }
    for (const v of values) {
      const exact = exactForms(v);
      if (fitsExactDecimal(v)) {
        // A decimal key: the decimal is the answer; the other spellings are extras.
        // Order: 6.8 (also 6.80, 34/5); 0.5 (also .5, 0.50, 1/2).
        push(forms, exact[0] ?? null);
        for (const e of exact.slice(1)) if (!e.includes("/")) push(also, e);
        push(also, trailingZeroForm(exact[0] ?? ""));
        for (const e of exact.slice(1)) if (e.includes("/")) push(also, e);
      } else {
        // A fraction key whose decimal doesn't fit: the fraction and the
        // decimals that fill every space, plus an unreduced fraction.
        for (const e of exact) push(forms, e);
        if (!rule) for (const f of fillDecimalForms(v)) push(forms, f);
        push(also, equalFractionForm(v));
      }
    }
    if (forms.length === 0) forms.push(normalizeKeyText(cand));
    return { candidate: cand, forms, also, text: false };
  });

  const one = (a: GradedAnswer) => `${a.forms.join(", ")}${a.also.length ? ` (also ${a.also.join(", ")})` : ""}`;
  let summary = "";
  if (answers.length > 0) {
    summary = `Graded as correct: ${answers.length > 1 ? answers.map((a, i) => `answer ${i + 1}: ${one(a)}`).join("; ") : one(answers[0])}.`;
    if (rule) summary += ` Rounding rule from the question: ${rule.label}.`;
    else if (answers.some((a) => !a.text && a.forms.some((f) => f.includes("/")))) summary += " Any equal fraction that fits is also accepted.";
  }
  return { answers, rule, summary };
}

/**
 * Why a fill-in entry wasn't credited, in student words, or null when
 * there's nothing specific to say (blank, credited, or a different value).
 */
export function sprEntryFeedback(
  entry: string | null | undefined,
  key: string | null | undefined,
  questionText?: string | null,
): string | null {
  const raw = (entry ?? "").trim();
  if (!raw || !key) return null;
  const cands = keyCandidates(key);
  if (cands.some((c) => sprEntryCreditedForCandidate(raw, c, questionText) === true)) return null;
  const sv = parseSprEntry(raw);
  if (sv === null) {
    const p = sprEntryProblem(raw);
    return p ? `Not credited: your entry ${p}.` : "Not credited: only digits, \".\", \"/\" and a leading \"-\" are allowed.";
  }
  const rule = roundingInstruction(questionText);
  for (const c of cands) {
    const kv = keyNumber(c);
    if (kv === null) continue;
    const target = rule ? applyRounding(kv, rule.places) : impliedExactValue(c) ?? kv;
    if (Math.abs(sv - target) > 0.01 * Math.max(1, Math.abs(target))) continue;
    if (rule) return `Close, but the question asks for the answer to the ${rule.label}.`;
    return "Close, but a shorter approximation isn't credited: enter the exact value, or a decimal that fills all the spaces.";
  }
  return null;
}
