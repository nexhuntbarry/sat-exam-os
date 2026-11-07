// scripts/test-spr-rules.ts
//
// Unit checks for the official College Board fill-in (SPR) helpers in
// lib/answer-key: answer-box sanitising, accepted entry forms (results page,
// explanations) and the explanation's closing "Answer: …" line.
// Run: npx tsx scripts/test-spr-rules.ts — exits non-zero on any failure.

import {
  acceptedSprEntries,
  fillDecimalForms,
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

console.log(`\n${total - failed}/${total} passed`);
if (failed > 0) process.exit(1);
