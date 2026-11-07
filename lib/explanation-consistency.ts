// lib/explanation-consistency.ts
//
// Numeric consistency of an explanation (pure, no AI). Incident 2026-11-07,
// [Test #14] J Test Math M1 Q10: the explanation computed
// (200 − 100)/100 × 100% and wrote "= 120%", then "Only choice B is
// correct" while the key had been changed to A. The text checks (cut off,
// "Choice X is correct", the Final answer line) all passed.
//
// Three checks:
//   1. Every written computation "a = b" (and "a ≈ b") whose two sides are
//      plain numbers is re-computed in code (lib/math/safe-eval): the two
//      sides must agree (to the decimals printed on the right). Percent signs
//      are read both as "%" dropped and as ÷100.
//   2. The stated final value ("Final answer: N", \boxed{N}, a bold **N**,
//      "the answer is N") is mapped to a choice (Multiple Choice) or compared
//      with the key (fill-in): it must be the key.
//   3. The letter it concludes ("Choice B is correct", "Only choice B …",
//      "Final answer: B") must be the key.
// Conservative by design: anything it can't read as plain numbers is skipped.

import { tryEvaluate, nearlyEqual } from "@/lib/math/safe-eval";
import { latexToExpr, mapValueToChoice, type ChoiceLike } from "@/lib/math/choice-values";
import { answersAgreeForQuestion, keyCandidates, SPR_TYPE } from "@/lib/answer-key";

export interface ConsistencyInput {
  explanation: string | null | undefined;
  key: string | null | undefined;
  questionType: string | null;
  choices: unknown;
  questionText?: string | null;
}

export interface ChainMismatch {
  /** The written computation, e.g. "\frac{200 - 100}{100} \times 100\% = 120\%". */
  text: string;
  computed: number;
  stated: number;
}

const MONEY = "\u0000"; // stands in for an escaped "\$" so it never opens math

/** A computation written in the explanation and the sentence around it. */
interface Written {
  text: string;
  context: string;
}

/** The sentence around [from, to) (boundaries: ". ", blank line, list item). */
function sentenceAround(s: string, from: number, to: number): string {
  const lead = s.slice(0, from).match(/^[^]*(?:[.!?]\s|\n\s*\n|\n\s*[-*]\s)/);
  const b = lead ? lead[0].length : 0;
  const after = s.slice(to);
  const e = after.search(/[.!?](?:\s|$)|\n\s*\n|\n\s*[-*]\s/);
  return s.slice(b, e < 0 ? s.length : to + e);
}

/** Math segments ($$…$$ and $…$) of the text, with their sentence. */
function mathSegments(text: string): Written[] {
  const s = text.replace(/\\\$/g, MONEY);
  const out: Written[] = [];
  // Same-length blanking keeps the indices of the rest.
  const rest = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, inner: string, at: number) => {
    out.push({ text: inner, context: sentenceAround(s, at, at + m.length) });
    return " ".repeat(m.length);
  });
  for (const m of rest.matchAll(/\$([^$\n]+?)\$/g)) out.push({ text: m[1], context: sentenceAround(s, m.index!, m.index! + m[0].length) });
  return out;
}

/** Plain-text computations outside math ("5900 / 150 = 39.3"). */
function plainChains(text: string): Written[] {
  const s = text
    .replace(/\\\$/g, MONEY)
    .replace(/−/g, "-")
    .replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => " ".repeat(m.length));
  const NUM = String.raw`-?\d[\d,]*(?:\.\d+)?%?`;
  // The right side is the whole result: not followed by more digits, a
  // fraction bar or another operation ("13,900 + 200 = 14,100", "3/6 = 1/2").
  const re = new RegExp(String.raw`(?<![\w.^/{-])(${NUM}(?:\s*[-+×*/÷]\s*\(?${NUM}\)?)+\s*=\s*${NUM})(?![\w.,/]?\d|\s*[-+×*/÷^(]\s*[\d(]|\s*[a-zA-Z])`, "g");
  return [...s.matchAll(re)].map((m) => ({ text: m[1], context: sentenceAround(s, m.index!, m.index! + m[0].length) }));
}

/**
 * Sentences that show a WRONG computation on purpose: a distractor's
 * mistake ("would result from mistakenly using √64 = 16"), a contradiction
 * ("gives 0 = 54"), a value that does not satisfy the equation.
 */
const ON_PURPOSE =
  /\b(?:incorrect(?:ly)?|mistaken(?:ly)?|mistakes?|errors?|erroneous(?:ly)?|wrong(?:ly)?|would (?:get|give|result|lead|produce|yield|be)|if (?:a student|you|someone|one)|false|contradiction|contradicts|impossible|does not|doesn't|do not|not satisf\w*|fails?|confus\w+|instead of|rather than|trap|misread\w*)\b|\\neq|≠/i;

/** A side that is just a number (no operation): "0", "-15", "\frac{1}{7}", "54%". */
function isLiteral(part: string): boolean {
  const p = normalize(part).replace(/\s+/g, "").replace(/\\?%$/, "");
  return /^[+-]?(?:\d[\d,]*(?:\.\d+)?|\\[dt]?frac\{\d+\}\{\d+\})$/.test(p);
}

const UNREADABLE = /\\(?:leq?|geq?|neq|lt|gt|pm|mp|circ|angle|overline|vec|sum|int|lim|infty|cdots|ldots)|[<>≤≥≠±]|\\begin|&/;

function normalize(part: string): string {
  return part
    .replace(/−|–/g, "-")
    .replace(/×/g, "\\times")
    .replace(/÷/g, "\\div")
    .replace(/\\left|\\right/g, "")
    .trim();
}

/** Value of one side, with "%" dropped and with "N%" read as N/100. */
function sideValues(part: string): number[] {
  const p = normalize(part);
  if (!p || p.includes(MONEY) || !/\d/.test(p)) return [];
  const vals: number[] = [];
  const asFrac = p.replace(/(\d+(?:\.\d+)?)\s*\\?%/g, "($1/100)");
  for (const variant of [p, asFrac]) {
    const e = latexToExpr(variant.replace(/\\%|%/g, ""));
    const v = e ? tryEvaluate(e) : null;
    if (v !== null && Number.isFinite(v) && !vals.some((x) => x === v)) vals.push(v);
  }
  return vals;
}

/** Digits printed after the decimal point of the last number in `part`. */
function decimalsOf(part: string): number {
  const nums = part.match(/\d+(?:\.(\d+))?/g) ?? [];
  const last = nums[nums.length - 1] ?? "";
  const m = last.match(/\.(\d+)$/);
  return m ? m[1].length : 0;
}

/** Trailing zeros of an integer written on the right of "≈" (5500 → 2). */
function roundPlaces(part: string): number {
  const m = normalize(part).replace(/,/g, "").match(/(\d+)(?:\.0+)?\s*(?:\\?%)?\s*$/);
  if (!m) return 0;
  const z = m[1].match(/0+$/);
  return z ? Math.min(z[0].length, m[1].length - 1) : 0;
}

function agree(l: number, r: number, rightText: string, approx: boolean): boolean {
  if (nearlyEqual(l, r, 1e-6) || Math.abs(l - r) < 1e-9) return true;
  const d = decimalsOf(rightText);
  if (d > 0 && Math.abs(l - r) <= 0.5 * 10 ** -d + 1e-9) return true;
  if (approx) {
    const tol = Math.max(0.5 * 10 ** -d, 0.5 * 10 ** roundPlaces(rightText), Math.abs(r) * 0.01);
    return Math.abs(l - r) <= tol + 1e-9;
  }
  return false;
}

/** Written computations whose two sides don't agree when re-computed. */
export function chainMismatches(explanation: string | null | undefined): ChainMismatch[] {
  const ex = explanation ?? "";
  if (!ex.trim()) return [];
  const out: ChainMismatch[] = [];
  for (const seg of [...mathSegments(ex), ...plainChains(ex)]) {
    if (ON_PURPOSE.test(seg.context)) continue;
    // One statement per line / comma-separated clause.
    for (const stmt of seg.text.split(/\\\\|\n|;|,\s+(?=[a-zA-Z\\])|\\quad|\\qquad|\\text\{\s*(?:and|so|then|thus)\s*\}/)) {
      if (UNREADABLE.test(stmt)) continue;
      const tokens = stmt.split(/(=|\\approx|≈)/);
      const parts: { text: string; approx: boolean }[] = [];
      for (let i = 0; i < tokens.length; i += 2) {
        parts.push({ text: tokens[i], approx: i > 0 && tokens[i - 1] !== "=" });
      }
      for (let i = 0; i + 1 < parts.length; i++) {
        const L = sideValues(parts[i].text);
        const R = sideValues(parts[i + 1].text);
        if (L.length === 0 || R.length === 0) continue;
        // "0 = 54", "3 = 0": a statement about numbers, not a computation.
        if (isLiteral(parts[i].text) && isLiteral(parts[i + 1].text)) continue;
        if (L.some((l) => R.some((r) => agree(l, r, parts[i + 1].text, parts[i + 1].approx)))) continue;
        out.push({ text: `${parts[i].text.trim()} ${parts[i + 1].approx ? "≈" : "="} ${parts[i + 1].text.trim()}`, computed: L[0], stated: R[0] });
      }
    }
  }
  return out;
}

const VALUE = String.raw`-?\d[\d,]*(?:\.\d+)?(?:\s*\/\s*\d+)?`;

function toNumber(raw: string): number | null {
  const s = raw.replace(/,/g, "").replace(/\s+/g, "");
  if (/^-?\d+(?:\.\d+)?\/\d+$/.test(s)) {
    const [a, b] = s.split("/");
    return Number(b) === 0 ? null : Number(a) / Number(b);
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The final values the explanation states (raw text, in order). */
export function statedValues(explanation: string | null | undefined, isMc: boolean): string[] {
  const ex = (explanation ?? "").replace(/\\\$/g, "");
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.replace(/\$|\\%|%|\\text\{[^}]*\}/g, "").trim();
    if (new RegExp(`^${VALUE}$`).test(t)) out.push(t.replace(/,(?=\d{3}\b)/g, ""));
  };
  for (const m of ex.matchAll(/(?:Final answer|(?:^|\n)[ \t]*\**Answer\**)\s*:\s*\**\s*\$?([^\n$*;]+)/gi)) push(m[1].replace(/[.;)]+\s*$/, ""));
  for (const m of ex.matchAll(/\\boxed\{([^{}]+)\}/g)) push(m[1]);
  for (const m of ex.matchAll(new RegExp(String.raw`\bthe (?:correct )?answer is\s*\$?(${VALUE})\s*(?:\\?%)?\$?(?![\w/])`, "gi"))) push(m[1]);
  // A bold value on its own ("**120%**") — MC explanations bold the result.
  if (isMc) for (const m of ex.matchAll(new RegExp(String.raw`\*\*\s*\$?(${VALUE})\s*(?:\\?%)?\$?\s*\*\*`, "g"))) push(m[1]);
  return out;
}

/** Letters the explanation picks as the answer, beyond the usual "Choice X is correct". */
export function statedLetters(explanation: string | null | undefined): string[] {
  const ex = explanation ?? "";
  const out = new Set<string>();
  // Case-sensitive letter (an "option consistent with…" is not option C):
  // keywords spelled out in both cases instead of the /i flag.
  const C = "(?:[Cc]hoice|[Oo]ption|[Aa]nswer)";
  const pats = [
    new RegExp(String.raw`\b[Oo]nly ${C}\s*\(?([A-D])\)?(?![\w'’])(?!\s*(?:is|was)\s+(?:in|wrong|not))`, "g"),
    new RegExp(String.raw`\b${C}\s*\(?([A-D])\)?\s+is\s+(?:therefore\s+|thus\s+)?(?:the\s+)?(?:[Cc]orrect|best|right)\b`, "g"),
    new RegExp(String.raw`\b(?:[Cc]orrect|[Bb]est|[Rr]ight) (?:answer|choice|option) is\s*(?:choice\s*|option\s*)?\(?([A-D])\b`, "g"),
    new RegExp(String.raw`\b[Tt]he answer is\s*(?:choice\s*|option\s*)?\(?([A-D])\b(?![\d.])`, "g"),
    /Final answer\s*:\s*\**\s*\(?([A-D])\b/g,
    /(?:^|\n)[ \t]*\**Answer\**\s*:\s*\**\s*\(?([A-D])\b(?![\w'’])/g,
  ];
  for (const p of pats) for (const m of ex.matchAll(p)) out.add(m[1].toUpperCase());
  return [...out];
}

/**
 * The letters a Multiple Choice key accepts: "C" → [C], "C, D" / "C or D"
 * → [C, D] (split like the grader, lib/answer-key keyCandidates). [] when
 * any part isn't a single letter.
 */
export function keyLetters(key: string | null | undefined): string[] {
  const parts = keyCandidates(key).flatMap((c) => c.split(/\s+and\s+|\s*&\s*/));
  const letters = parts.map((c) => c.trim().match(/^\(?\s*([A-Da-d])\s*\)?\.?$/)?.[1]?.toUpperCase() ?? null);
  if (letters.length === 0 || letters.some((l) => !l)) return [];
  return [...new Set(letters as string[])];
}

/**
 * Problems with the explanation's numbers (empty = consistent). A non-empty
 * result means the computation, the stated answer and the key don't all agree.
 */
export function explanationNumericProblems(input: ConsistencyInput): string[] {
  const ex = input.explanation ?? "";
  const key = (input.key ?? "").trim();
  if (!ex.trim()) return [];
  const problems: string[] = [];
  for (const m of chainMismatches(ex).slice(0, 2)) {
    problems.push(`writes "${m.text.replace(/\s+/g, " ").slice(0, 80)}" but it computes to ${+m.computed.toPrecision(6)}`);
  }
  if (!key) return problems;
  const isMc = input.questionType !== SPR_TYPE;
  if (isMc) {
    const ks = keyLetters(key);
    if (ks.length === 0) return problems;
    const k = ks.join(", ");
    const other = statedLetters(ex).filter((l) => !ks.includes(l));
    if (other.length) problems.push(`it names ${other.join("/")} as the answer, key is ${k}`);
    const choices = (Array.isArray(input.choices) ? input.choices : []) as ChoiceLike[];
    const mapped = statedValues(ex, true)
      .map((raw) => ({ raw, v: toNumber(raw) }))
      .filter((x): x is { raw: string; v: number } => x.v !== null)
      .map((x) => ({ ...x, choice: mapValueToChoice(x.v, choices) }))
      .filter((x) => x.choice);
    if (mapped.length && !mapped.some((x) => ks.includes(x.choice as string))) {
      const w = mapped[mapped.length - 1];
      problems.push(`its final value ${w.raw} is choice ${w.choice}, key is ${k}`);
    }
    return problems;
  }
  const vals = statedValues(ex, false);
  const same = (v: string) => answersAgreeForQuestion(v, key, input.questionText ?? null) || answersAgreeForQuestion(key, v, input.questionText ?? null);
  if (vals.length && !vals.some(same)) problems.push(`its final value ${vals[vals.length - 1]} is not the key ${key}`);
  return problems;
}
