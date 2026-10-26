// scripts/test-answers-match.ts
//
// Table test for lib/grade-submission answersMatch (QA finding M-02:
// strict SPR parsing). Run: npx tsx scripts/test-answers-match.ts
// Exits non-zero on any failure.

import { answersMatch, parseStrictNumber } from "../lib/grade-submission";

type Case = [student: string | null, key: string | null, expected: boolean, note?: string];

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
  ["-.3333", "-1/3", true, "4-digit truncation within tolerance"],
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

  // Thousands separators
  ["1000", "1,000", true],
  ["1,000", "1,000", true],
  ["1,000", "1000", true],
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
];

let failed = 0;
for (const [student, key, expected, note] of cases) {
  const got = answersMatch(student, key);
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
  ["1,000", 1000],
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
