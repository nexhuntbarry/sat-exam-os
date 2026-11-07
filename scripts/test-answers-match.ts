// scripts/test-answers-match.ts
//
// Table test for lib/grade-submission answersMatch (QA finding M-02:
// strict SPR parsing; 2026-11-07: official College Board fill-in rules).
// Run: npx tsx scripts/test-answers-match.ts
// Exits non-zero on any failure.

import { answersMatch, parseStrictNumber } from "../lib/grade-submission";

type Case = [student: string | null, key: string | null, expected: boolean, note?: string, questionText?: string];

const cases: Case[] = [
  // Plain numbers
  ["35", "35", true],
  [" 35 ", "35", true, "trimmed"],
  ["35.0", "35", true],
  ["-7", "-7", true],
  ["11.25", "11.25", true],
  [".5", "0.5", true, "leading dot"],
  ["-.5", "-0.5", true, "negative leading dot"],
  ["0.56", "0.56", true],

  // Malformed SPR input must be wrong (M-02)
  ["35abc", "35", false, "trailing garbage"],
  ["4/0", "4", false, "zero denominator"],
  ["4/0", "4/0", false, "zero denominator even vs identical key"],
  ["263 264", "263", false, "two numbers"],
  ["1 1/2", "1.5", false, "mixed number"],
  ["1 1/2", "3/2", false, "mixed number vs fraction"],
  ["x".repeat(500), "5", false, "500 chars"],
  ["+5", "5", false, "leading plus not accepted"],
  ["5-", "5", false],
  ["1.2.3", "1.2", false],
  ["--5", "-5", false],
  ["1,00", "100", false, "bad thousands grouping"],
  ["", "5", false, "blank"],
  [null, "5", false, "unanswered"],
  ["5", null, false, "no key"],
  ["5", "", false, "empty key"],

  // Unicode minus normalization
  ["−5", "-5", true, "U+2212 minus"],
  ["–5", "-5", true, "en dash"],
  ["-5", "−5", true, "unicode minus in key"],

  // Fractions
  ["13", "26/2", true, "26/2 key"],
  ["26/2", "13", true],
  ["1/2", "0.5", true],
  ["0.5", "1/2", true],
  [".5", "1/2", true],
  ["1 / 2", "0.5", true, "spaces around slash"],
  ["-1/3", "-1/3", true],
  ["-.3333", "-1/3", true, "fills the space"],
  [".5294", "9/17", true],
  ["9/17", "9/17", true],
  ["2/3", "0.6667", true],

  // SAT grid-in rounding/truncation (value doesn't fit 5 chars)
  [".6666", "2/3", true],
  [".6667", "2/3", true],
  ["0.666", "2/3", true],
  ["0.667", "2/3", true],
  ["0.67", "2/3", false, "does not fill the grid"],
  [".66", "2/3", false],
  ["0.142", "1/7", true],
  ["0.143", "1/7", true],
  ["0.14", "1/7", false],
  ["-.3333", "-1/3", true],
  ["-0.333", "-1/3", true],
  ["0.333", "-1/3", false, "sign mismatch"],
  ["71.33", "214/3", true],
  ["0.003", "0.0029", false, "exact .0029 fits — no rounding allowed"],
  [".0029", "0.0029", true],

  // Units / currency are not numbers
  ["24000 grams", "24000", false],
  ["$2.24", "2.24", false],
  ["2.24", "$2.24$", true, "LaTeX-wrapped key"],
  ["-13,5", "5 or -13", false, "two answers in one entry"],

  // Non-numeric keys still compare as text
  ["67/\\sqrt{133}", "67/\\sqrt{133}", true],

  // Multiple acceptable answers in the key
  ["5", "5 or -13", true],
  ["-13", "5 or -13", true],
  ["13", "5 or -13", false],
  ["214/3", "214/3, 71.33", true, "comma-space list"],
  ["71.33", "214/3, 71.33", true],
  ["214", "214/3, 71.33", false, "old parseFloat matched 214"],
  ["0.5", "1/2|0.5", true],
  ["0.5", "1/2;0.5", true],
  ["0.5", "1/2\n0.5", true],

  // Thousands separators: a comma in the entry is never credited (official
  // rules); a legacy key written "1,000" still means 1000.
  ["1000", "1,000", true],
  ["1,000", "1,000", false, "comma in entry"],
  ["1,000", "1000", false, "comma in entry"],
  ["24000", "24000", true],
  ["1000", "100", false],

  // LaTeX keys
  ["26/5", "\\frac{26}{5}", true],
  ["5.2", "\\frac{26}{5}", true],

  // Multiple choice letters unchanged
  ["A", "A", true],
  ["a", "A", true, "case-insensitive"],
  ["A ", "A", true],
  ["B", "A", false],
  ["C", "C", true],
  ["A", "A or C", true, "two acceptable MC keys"],
  ["C", "A, C", true],
  ["B", "A, C", false],
  ["D", "D", true],
  ["A", "5", false, "letter vs numeric key"],
  ["5", "A", false, "number vs letter key"],

  // ── Official College Board directions examples ──
  // 3.5: 3.5, 3.50, 7/2 credited; 31/2, 3 1/2 not.
  ["3.5", "3.5", true],
  ["3.50", "3.5", true],
  ["7/2", "3.5", true],
  ["31/2", "3.5", false, "31/2 is 15.5"],
  ["3 1/2", "3.5", false, "mixed number"],
  ["3.5", "7/2", true],
  ["3 1/2", "7/2", false, "mixed number"],
  // 2/3: 2/3, .6666, .6667, 0.666, 0.667 credited; 0.66, .66, 0.67, .67 not.
  ["2/3", "2/3", true],
  [".6666", "2/3", true],
  [".6667", "2/3", true],
  ["0.666", "2/3", true],
  ["0.667", "2/3", true],
  ["0.66", "2/3", false],
  [".66", "2/3", false],
  ["0.67", "2/3", false],
  [".67", "2/3", false],
  ["4/6", "2/3", true, "unreduced fraction, exact value"],
  [".666", "2/3", false, "doesn't fill the space"],
  ["0.6667", "2/3", false, "6 characters can't be entered"],
  // -1/3: -1/3, -.3333, -0.333 credited; -.33, -0.33 not.
  ["-1/3", "-1/3", true],
  ["-.3333", "-1/3", true],
  ["-0.333", "-1/3", true],
  ["-.33", "-1/3", false],
  ["-0.33", "-1/3", false],
  ["-.3334", "-1/3", false, "neither truncation nor rounding"],
  // No %, comma, $.
  ["50%", "50", false],
  ["$50", "50", false],
  ["5,000", "5000", false],
  // Exact decimals that fit get no approximation slack.
  ["0.13", "0.125", false],
  [".125", "0.125", true],
  ["1/8", "0.125", true],
  ["0.125", "1/8", true],
  // Longer values: fill every space (5 characters).
  ["11.11", "100/9", true, "truncated"],
  ["11.1", "100/9", false],
  ["14.28", "100/7", true, "truncated"],
  ["14.29", "100/7", true, "rounded"],
  ["-14.28", "-100/7", true],
  ["-14.2", "-100/7", false],
  ["1.666", "5/3", true],
  ["1.667", "5/3", true],
  ["1.67", "5/3", false],
  // Approximate keys (stored as a rounded decimal) still credit the exact
  // fraction and the other fill forms.
  ["2/3", "0.6667", true, "approximate key"],
  [".6666", "0.6667", true, "approximate key, truncated entry"],
  ["0.67", "0.6667", false],
  ["214/3", "71.33", true, "approximate key"],
  ["71.33", "71.33", true],

  // ── Question-specific rounding instructions win ──
  ["3.5", "3.5", true, "nearest tenth", "What is x, to the nearest tenth?"],
  ["3.48", "3.48", true, "exact key always counts", "Round to the nearest tenth."],
  ["3.5", "3.48", true, "rounded as asked", "What is the value, to the nearest tenth?"],
  ["3.48", "3.5", false, "not rounded as asked", "What is the value, to the nearest tenth?"],
  ["3.4", "3.48", false, "", "What is the value, to the nearest tenth?"],
  ["7/2", "3.5", true, "value equals the rounded key", "to the nearest tenth"],
  ["248", "248", true, "", "to the nearest whole number"],
  ["248", "248.2", true, "", "to the nearest whole number"],
  ["248.2", "248", false, "", "to the nearest whole number"],
  ["0.67", "2/3", true, "nearest hundredth", "Round your answer to the nearest hundredth."],
  [".6667", "2/3", false, "fill-the-space doesn't apply", "Round your answer to the nearest hundredth."],
  ["5", "5 or -13", true, "multi-answer with a rule", "to the nearest whole number"],

  // Regressions
  ["5", "5|−13", true],
  ["-13", "5|-13", true],
  ["0", "0", true],
  ["-0", "0", true],
  ["00.67", "2/3", false],
  [".5", "\\frac{1}{2}", true],
  // A verified key longer than the 5/6 characters (Test #2 Math M2 Q22).
  ["1905.12", "1905.12", true, "long official key, exact entry"],
  ["1905.1", "1905.12", false],
  ["1905.", "1905.12", false],
];

let failed = 0;
for (const [student, key, expected, note, questionText] of cases) {
  const got = answersMatch(student, key, questionText);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  answersMatch(${JSON.stringify(student && student.length > 20 ? student.slice(0, 20) + "…" : student)}, ${JSON.stringify(key)}) = ${got}` +
      (ok ? "" : `  (expected ${expected})`) +
      (note ? `  — ${note}` : ""),
  );
}

// parseStrictNumber spot checks
const parseCases: [string, number | null][] = [
  ["12", 12],
  ["-3.5", -3.5],
  [".75", 0.75],
  ["26/2", 13],
  ["1,000", null],
  ["4/0", null],
  ["35abc", null],
  ["263 264", null],
  ["−2", -2],
];
for (const [input, expected] of parseCases) {
  const got = parseStrictNumber(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  parseStrictNumber(${JSON.stringify(input)}) = ${got}${ok ? "" : `  (expected ${expected})`}`);
}

console.log(`\n${cases.length + parseCases.length - failed}/${cases.length + parseCases.length} passed`);
if (failed > 0) process.exit(1);
