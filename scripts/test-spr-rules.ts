// scripts/test-spr-rules.ts
//
// Unit checks for the official College Board fill-in (SPR) helpers in
// lib/answer-key: answer-box sanitising, accepted entry forms (results page,
// explanations) and the explanation's closing "Answer: …" line.
// Run: npx tsx scripts/test-spr-rules.ts — exits non-zero on any failure.

import { answersMatch as _am } from "../lib/grade-submission";
import {
  acceptedSprEntries,
  fillDecimalForms,
  gradedAsCorrect,
  impliedExactValue,
  keyTypeProblem,
  acceptedAnswersText,
  sanitizeSprInput,
  sprAnswerLine,
  sprEntryFeedback,
  sprInputMaxChars,
  withSprAnswerLine,
} from "../lib/answer-key";
import { answersMatch } from "../lib/grade-submission";

let failed = 0;
let total = 0;
function eq(label: string, got: unknown, want: unknown) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} = ${JSON.stringify(got)}${ok ? "" : `  (expected ${JSON.stringify(want)})`}`);
}

// Answer box: digits, ".", "/", leading "-"; 5 chars (6 with "-").
eq("sanitize 3.5", sanitizeSprInput("3.5"), "3.5");
eq("sanitize letters", sanitizeSprInput("35abc"), "35");
eq("sanitize $1,000%", sanitizeSprInput("$1,000%"), "1000");
eq("sanitize spaces", sanitizeSprInput("3 1/2"), "31/2");
eq("sanitize 6 chars", sanitizeSprInput("123456"), "12345");
eq("sanitize negative 6", sanitizeSprInput("-.33333"), "-.3333");
eq("sanitize inner minus", sanitizeSprInput("5-3"), "53");
eq("sanitize double minus", sanitizeSprInput("--5"), "-5");
eq("sanitize unicode minus", sanitizeSprInput("−2/3"), "-2/3");
eq("sanitize full-width", sanitizeSprInput("３５"), "35");
eq("sanitize plus", sanitizeSprInput("+5"), "5");
eq("sanitize empty", sanitizeSprInput(""), "");

// Fill forms
eq("fill 2/3", fillDecimalForms(2 / 3), [".6666", ".6667", "0.666", "0.667"]);
eq("fill -1/3", fillDecimalForms(-1 / 3), ["-.3333", "-0.333"]);
eq("fill 214/3", fillDecimalForms(214 / 3), ["71.33"]);
eq("fill 100/7", fillDecimalForms(100 / 7), ["14.28", "14.29"]);

// Accepted forms per key candidate
eq("accepted 2/3", acceptedSprEntries("2/3"), [["2/3", ".6666", ".6667", "0.666", "0.667"]]);
eq("accepted -1/3", acceptedSprEntries("-1/3"), [["-1/3", "-.3333", "-0.333"]]);
eq("accepted 3.5", acceptedSprEntries("3.5"), [["3.5", "7/2"]]);
eq("accepted 0.5", acceptedSprEntries("1/2"), [["0.5", ".5", "1/2"]]);
eq("accepted 12", acceptedSprEntries("12"), [["12"]]);
eq("accepted multi", acceptedSprEntries("5 or -13"), [["5"], ["-13"]]);
eq("accepted approx key", acceptedSprEntries("0.6667"), [["2/3", ".6666", ".6667", "0.666", "0.667"]]);
eq("accepted rounding rule", acceptedSprEntries("3.48", "to the nearest tenth"), [["3.5", "7/2"]]);
eq("accepted whole number", acceptedSprEntries("248.2", "to the nearest whole number"), [["248"]]);
eq("accepted comma key", acceptedSprEntries("1,000"), [["1000"]]);
eq("accepted letter", acceptedSprEntries("B"), [["B"]]);

// Implied fraction behind an approximate key
eq("implied .6667", impliedExactValue(".6667"), 2 / 3);
eq("implied 0.33 (too short)", impliedExactValue("0.33"), null);
eq("implied 0.125 (exact)", impliedExactValue("0.125"), null);

// Explanation closing line
eq("line 2/3", sprAnswerLine("2/3"), "Answer: 2/3; .6666, .6667, 0.666 or 0.667 also accepted.");
eq("line 12", sprAnswerLine("12"), "Answer: 12");
eq("line multi", sprAnswerLine("5 or -13"), "Answer: 5 or -13");
eq("line 3.5", sprAnswerLine("3.5"), "Answer: 3.5; 7/2 also accepted.");
eq(
  "withSprAnswerLine replaces an old line",
  withSprAnswerLine("Work.\n\nAnswer: 2/3; .6666 also accepted", "2/3"),
  "Work.\n\nAnswer: 2/3; .6666, .6667, 0.666 or 0.667 also accepted.",
);
eq(
  "withSprAnswerLine replaces Final answer trailer",
  withSprAnswerLine("So $x = \\frac{2}{3}$.\nFinal answer: 2/3", "2/3"),
  "So $x = \\frac{2}{3}$.\n\nAnswer: 2/3; .6666, .6667, 0.666 or 0.667 also accepted.",
);
eq("withSprAnswerLine appends", withSprAnswerLine("x = 12.", "12"), "x = 12.\n\nAnswer: 12");

// Results-page text
eq("accepted text multi", acceptedAnswersText("5 or -13"), "5  ·  or  ·  -13");
eq("feedback credited", sprEntryFeedback(".6667", "2/3"), null);
eq("feedback blank", sprEntryFeedback("", "2/3"), null);
eq("feedback short approx", sprEntryFeedback("0.67", "2/3"), "Close, but a shorter approximation isn't credited: enter the exact value, or a decimal that fills all the spaces.");
eq("feedback mixed", sprEntryFeedback("3 1/2", "7/2"), "Not credited: your entry is a mixed number (write 7/2, not 3 1/2).");
eq("feedback comma", sprEntryFeedback("1,000", "1000"), "Not credited: your entry has a comma (write 1000, not 1,000).");
eq("feedback rounding", sprEntryFeedback("3.48", "3.5", "to the nearest tenth"), "Close, but the question asks for the answer to the nearest tenth.");
eq("feedback far", sprEntryFeedback("12", "2/3"), null);

// A verified key longer than 5/6 characters (Test #2 Math M2 Q22: 1905.12)
// must stay enterable and gradable.
eq("max chars default", sprInputMaxChars("2/3"), 6);
eq("max chars long key", sprInputMaxChars("1905.12"), 7);
eq("max chars multi", sprInputMaxChars("5 or -1905.12"), 8);
eq("max chars letter key", sprInputMaxChars("B"), 6);
eq("sanitize long key box", sanitizeSprInput("1905.12", sprInputMaxChars("1905.12")), "1905.12");
eq("sanitize long key box cap", sanitizeSprInput("1905.123", sprInputMaxChars("1905.12")), "1905.12");
eq("sanitize default box", sanitizeSprInput("1905.12"), "1905.");
eq("long key graded", answersMatch("1905.12", "1905.12"), true);
eq("long key wrong value", answersMatch("1905.1", "1905.12"), false);
eq("long key feedback none", sprEntryFeedback("1905.12", "1905.12"), null);
eq("long official key allowed", keyTypeProblem({ question_type: "Student Produced Response", correct_answer: "1905.12", official_answer: "1905.12" }), null);
eq("long AI key flagged", keyTypeProblem({ question_type: "Student Produced Response", correct_answer: "1905.12" })?.code, "spr-invalid-form");
eq("accepted 1905.12", acceptedSprEntries("1905.12"), [["1905.12"]]);

// Exact keys are not mistaken for approximations of a fraction.
eq("implied 0.018", impliedExactValue("0.018"), null);
eq("implied 11.25", impliedExactValue("11.25"), null);
eq("implied 1905.12", impliedExactValue("1905.12"), null);
eq("11.26 vs 11.25", answersMatch("11.26", "11.25"), false);
eq("1/53 vs 0.018", answersMatch("1/53", "0.018"), false);
eq(".0189 vs 0.018", answersMatch(".0189", "0.018"), false);

// ── "Graded as correct" on the review page (gradedAsCorrect) ──
// Every listed entry must be credited by the grader, and fit the box;
// near-misses must not be.
{
  const cases: Array<{ key: string; q?: string; summary: string; miss: string[] }> = [
    { key: "6/13", summary: "Graded as correct: 6/13, .4615, 0.461, 0.462 (also 12/26). Any equal fraction that fits is also accepted.", miss: [".46", "0.46", ".4614", "0.463", "6/12", ".462"] },
    { key: "6.8", q: "What is the area of the shaded region, to the nearest tenth?", summary: "Graded as correct: 6.8 (also 6.80, 34/5). Rounding rule from the question: nearest tenth.", miss: ["6.85", "6.9", "6.7", "7", "6.79"] },
    { key: "21.5", summary: "Graded as correct: 21.5 (also 21.50, 43/2).", miss: ["21", "22", "21.4", "21.6"] },
    { key: "0.5", summary: "Graded as correct: 0.5 (also .5, 0.50, 1/2).", miss: [".05", "5", "0.55"] },
    { key: "12", summary: "Graded as correct: 12 (also 12.0).", miss: ["12.1", "11", "1.2"] },
    { key: "-1/3", summary: "Graded as correct: -1/3, -.3333, -0.333 (also -2/6). Any equal fraction that fits is also accepted.", miss: ["-.33", "-0.33", "1/3", "-.3334"] },
    { key: "3 or 5", summary: "Graded as correct: answer 1: 3 (also 3.0); answer 2: 5 (also 5.0).", miss: ["4", "35", "3 or 5", "8"] },
    { key: ".6667", summary: "Graded as correct: 2/3, .6666, .6667, 0.666, 0.667 (also 4/6). Any equal fraction that fits is also accepted.", miss: [".67", "0.66", ".6665"] },
    { key: "248", q: "To the nearest whole number, what is the value of x?", summary: "Graded as correct: 248 (also 248.0). Rounding rule from the question: nearest whole number.", miss: ["248.2", "249", "247"] },
    { key: "248.2", q: "To the nearest whole number, what is the value of x?", summary: "Graded as correct: 248, 248.2 (also 248.0). Rounding rule from the question: nearest whole number.", miss: ["249", "248.3"] },
    { key: "214/3", summary: "Graded as correct: 214/3, 71.33 (also 428/6). Any equal fraction that fits is also accepted.", miss: ["71.3", "71.34", "71"] },
    { key: "1905.12", summary: "Graded as correct: 1905.12.", miss: ["1905.1", "1905"] },
  ];
  for (const c of cases) {
    const g = gradedAsCorrect(c.key, c.q);
    eq(`graded summary ${c.key}`, g.summary, c.summary);
    for (const a of g.answers) {
      for (const f of [...a.forms, ...a.also]) {
        eq(`graded ${c.key}: "${f}" credited`, answersMatch(f, c.key, c.q), true);
        // The box takes 5 characters (6 with "-"); a longer verified key is its own form.
        if (f !== c.key) eq(`graded ${c.key}: "${f}" fits the box`, f.replace(/^-/, "").length <= 5, true);
      }
    }
    for (const m of c.miss) eq(`graded ${c.key}: near-miss "${m}" not credited`, answersMatch(m, c.key, c.q), false);
  }
  eq("graded MC letter", gradedAsCorrect("B").answers[0].text, true);
  eq("graded empty", gradedAsCorrect("").summary, "");
}

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);

// ── Review fixes 2026-11-07 ──
{
  const answersMatch = _am;
  const chk = (n: string, got: boolean, want: boolean) => { if (got !== want) { console.error("FAIL", n, got); process.exitCode = 1; } else console.log("ok", n); };
  chk("400 digits vs 5", answersMatch("1".repeat(400), "5"), false);
  chk("400 digits vs 3/4", answersMatch("1".repeat(400), "3/4"), false);
  chk("309 digits rounding stem", answersMatch("9".repeat(309), "248", "To the nearest whole number, what is x?"), false);
  chk("2. vs 2", answersMatch("2.", "2"), true);
  chk("12.85 vs exact 12.86", answersMatch("12.85", "12.86"), false);
  chk("90/7 vs exact 12.86", answersMatch("90/7", "12.86"), false);
  chk("12.86 vs 12.86", answersMatch("12.86", "12.86"), true);
  chk("2/3 vs .6667", answersMatch("2/3", ".6667"), true);
  chk(".6666 vs .6667", answersMatch(".6666", ".6667"), true);
}
