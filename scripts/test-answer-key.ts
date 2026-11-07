// scripts/test-answer-key.ts
//
// Unit tests for the "prevent wrong answer keys" helpers: SPR-form validator,
// rounding instructions, the safe arithmetic evaluator, computed-answer
// checks, key/type mismatch and the approve gate.
// Run: npx tsx scripts/test-answer-key.ts   (exits non-zero on any failure)

import {
  sprEntryProblem,
  roundingInstruction,
  applyRounding,
  roundingProblem,
  formatSprAnswer,
  keyTypeProblem,
  checkComputedAnswer,
  answersAgreeForQuestion,
  mcKeyProblem,
  normalizeKeyText,
} from "../lib/answer-key";
import { safeEvaluate, tryEvaluate, equationHolds, SafeEvalError } from "../lib/math/safe-eval";
import { findApproveBlocker } from "../lib/parse-guards";
import { aiAnswerAgrees } from "../lib/ai/solve-question";
import { reattachStrayChoices, type ParsedQuestion } from "../lib/ai/parse-pdf";

let failed = 0;
let passed = 0;
function eq(actual: unknown, expected: unknown, name: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// ── SPR-form validator ───────────────────────────────────────────────
const valid = ["12", "-3", "3.5", ".75", "0.75", "-.5", "7/2", "-7/2", "99999", "-9999", ".6667", "0.6667", "-1234", "100/3", "\\frac{26}{5}", "$5$", "−4"];
for (const v of valid) eq(sprEntryProblem(v), null, `valid SPR "${v}"`);
const invalid: Array<[string, RegExp]> = [
  ["C", /choice letter/],
  ["(B)", /choice letter/],
  ["50%", /% sign/],
  ["$170", /dollar/],
  ["1,000", /comma/],
  ["3 1/2", /mixed number/],
  ["12 cm", /letters, units/],
  ["x=5", /letters, units|accepted form/],
  ["2π", /letters/],
  ["\\sqrt{2}", /letters/],
  ["123456", /too long/],
  ["-123456", /too long/],
  ["1000/3", /too long/],
  ["0.66667", /too long/],
  ["4/0", /divides by zero/],
  ["+5", /plus sign/],
  ["", /empty/],
  ["1.2.3", /accepted form/],
];
for (const [v, re] of invalid) {
  const p = sprEntryProblem(v);
  eq(p !== null && re.test(p), true, `invalid SPR "${v}" → ${p}`);
}
eq(normalizeKeyText("\\dfrac{7}{2}"), "7/2", "latex frac normalized");

// ── Rounding instructions ────────────────────────────────────────────
eq(roundingInstruction("What is the value of x, rounded to the nearest tenth?")?.places, 1, "nearest tenth");
eq(roundingInstruction("Round your answer to the nearest hundredth.")?.places, 2, "nearest hundredth");
eq(roundingInstruction("to the nearest whole number")?.places, 0, "nearest whole number");
eq(roundingInstruction("to the nearest integer")?.places, 0, "nearest integer");
eq(roundingInstruction("to the nearest percent")?.places, 0, "nearest percent");
eq(roundingInstruction("to the nearest thousandth")?.places, 3, "nearest thousandth");
eq(roundingInstruction("to the nearest ten-thousandth")?.places, 4, "nearest ten-thousandth");
eq(roundingInstruction("to the nearest hundred")?.places, -2, "nearest hundred");
eq(roundingInstruction("to the nearest ten")?.places, -1, "nearest ten");
eq(roundingInstruction("rounded to two decimal places")?.places, 2, "two decimal places");
eq(roundingInstruction("to the nearest cent")?.places, 2, "nearest cent");
eq(roundingInstruction("What is the value of x?"), null, "no rounding");
eq(
  roundingInstruction("The table shows values rounded to the nearest tenth. What is the mean, to the nearest whole number?")?.places,
  0,
  "last instruction wins",
);
eq(applyRounding(248.2, 0), 248, "248.2 → 248");
eq(applyRounding(248.5, 0), 249, "248.5 → 249 (half up)");
eq(applyRounding(2.675, 2), 2.68, "2.675 → 2.68 (float-safe)");
eq(applyRounding(-3.45, 1), -3.5, "-3.45 → -3.5 (half away from zero)");
eq(applyRounding(1234, -2), 1200, "nearest hundred");
eq(roundingProblem("248", roundingInstruction("nearest whole number")), null, "248 ok");
eq(/isn't rounded/.test(roundingProblem("248.2", roundingInstruction("nearest whole number")) ?? ""), true, "248.2 not whole");
eq(roundingProblem("3.5", roundingInstruction("nearest tenth")), null, "3.5 tenth ok");
eq(roundingProblem("7/2", roundingInstruction("nearest tenth")), null, "7/2 = 3.5 tenth ok");
eq(/isn't rounded/.test(roundingProblem("1/3", roundingInstruction("nearest tenth")) ?? ""), true, "1/3 not tenth");

// ── Formatting a computed value as an SPR entry ──────────────────────
eq(formatSprAnswer(248.2, roundingInstruction("nearest whole number")), "248", "format 248.2 whole");
eq(formatSprAnswer(248.2, null), "248.2", "format 248.2");
eq(formatSprAnswer(2 / 3, null), "2/3", "format 2/3");
eq(formatSprAnswer(1 / 7, null), "1/7", "format 1/7");
eq(formatSprAnswer(0.123456, null), "0.1235", "format long decimal fills grid");
eq(formatSprAnswer(3.0, roundingInstruction("nearest tenth")), "3", "3.0 → 3");
eq(formatSprAnswer(-12.345, roundingInstruction("nearest tenth")), "-12.3", "negative tenth");
eq(formatSprAnswer(123456, null), null, "too big for the grid");

// ── Safe evaluator ───────────────────────────────────────────────────
eq(safeEvaluate("(3*412 + 5)/5"), 248.2, "arith");
eq(safeEvaluate("2**3**2"), 512, "power right-assoc (**)");
eq(safeEvaluate("2^3^2"), 512, "power right-assoc (^)");
eq(safeEvaluate("-2^2"), -4, "unary minus binds looser than ^");
eq(safeEvaluate("sqrt(16) + abs(-3)"), 7, "functions");
eq(safeEvaluate("math.sqrt(9)"), 3, "math. prefix");
eq(Math.abs(safeEvaluate("2*pi") - 2 * Math.PI) < 1e-12, true, "pi");
eq(safeEvaluate("ans*2", { ans: 4 }), 8, "variables");
eq(safeEvaluate("1e3/4"), 250, "scientific");
eq(safeEvaluate("max(1, 5, 3)"), 5, "max");
eq(safeEvaluate("log(100)"), 2, "log10");
eq(safeEvaluate("12 × 3 ÷ 4"), 9, "unicode ops");
for (const bad of ["process.exit(1)", "constructor", "alert(1)", "1/0", "2 3", "(1+2", "x", "this", "a=1", "[1]", "''", "`1`", "1;2", "__proto__", "eval('1')"]) {
  let threw = false;
  try {
    safeEvaluate(bad);
  } catch (e) {
    threw = e instanceof SafeEvalError;
  }
  eq(threw, true, `rejects ${JSON.stringify(bad)}`);
}
eq(tryEvaluate("1+"), null, "tryEvaluate null");
eq(tryEvaluate("(".repeat(200) + "1" + ")".repeat(200)), null, "depth limit");
eq(equationHolds("3*ans + 7 == 31", { ans: 8 }), true, "plug-back ok");
eq(equationHolds("3*ans + 7 = 31", { ans: 9 }), false, "plug-back fails");
eq(equationHolds("ans >= 3", { ans: 9 }), null, "unreadable equation");

// ── Computed-answer check ────────────────────────────────────────────
const q17 = "The mean of five values is shown. What is the value of x, to the nearest whole number?";
let c = checkComputedAnswer({ declared: "249", expression: "(3*412 + 5)/5", questionText: q17 });
eq(c.answer, "248", "Math 001 Q17: computed 248");
eq(c.problems.length > 0, true, "Math 001 Q17: 249 flagged");
c = checkComputedAnswer({ declared: "248", expression: "(3*412 + 5)/5", questionText: q17 });
eq([c.answer, c.problems], ["248", []], "consistent 248");
c = checkComputedAnswer({ declared: "248.2", expression: "(3*412 + 5)/5", questionText: q17 });
eq(c.answer, "248", "unrounded declared → rounded in code");
eq(c.problems.some((p) => /isn't rounded/.test(p)), true, "unrounded declared flagged");
c = checkComputedAnswer({ declared: ".6667", expression: "2/3", questionText: "What is p?" });
eq([c.answer, c.problems], ["2/3", []], "grid decimal of 2/3 agrees");
c = checkComputedAnswer({ declared: "8", expression: "24/3", checkEquation: "3*ans + 7 == 31", questionText: "Solve" });
eq(c.problems, [], "plug-back passes");
c = checkComputedAnswer({ declared: "9", expression: "27/3", checkEquation: "3*ans + 7 == 31", questionText: "Solve" });
eq(c.problems.some((p) => /plug-back/.test(p)), true, "plug-back failure flagged");
c = checkComputedAnswer({ declared: "5", expression: "import os", questionText: "Solve" });
eq(c.problems.some((p) => /couldn't evaluate/.test(p)), true, "unsafe expression not evaluated");
c = checkComputedAnswer({ declared: "C", expression: "", questionText: "Solve" });
eq(c.problems.some((p) => /choice letter/.test(p)), true, "letter declared flagged");

// ── Agreement helpers ────────────────────────────────────────────────
eq(answersAgreeForQuestion("248.2", "248", q17), true, "agree after rounding");
eq(answersAgreeForQuestion("249", "248", q17), false, "249 vs 248");
eq(answersAgreeForQuestion("3.5", "7/2 or 3.5", null), true, "candidates");
eq(answersAgreeForQuestion("(B)", "B", null), true, "letters");
eq(aiAnswerAgrees("248.2", "248", false, q17), true, "aiAnswerAgrees rounds AI value");
eq(aiAnswerAgrees("249", "248", false, q17), false, "aiAnswerAgrees 249 vs 248");
eq(aiAnswerAgrees("C", "B", true), false, "aiAnswerAgrees MC");

// ── Key / type mismatch + approve gate ───────────────────────────────
const sprBase = { question_type: "Student Produced Response", question_text: "What is x?", choices: [] };
eq(keyTypeProblem({ ...sprBase, correct_answer: "C" })?.code, "spr-letter-key", "SPR letter key");
eq(keyTypeProblem({ ...sprBase, correct_answer: "1,000" })?.code, "spr-invalid-form", "SPR comma");
eq(keyTypeProblem({ ...sprBase, correct_answer: "7/2 or 3.5" }), null, "SPR multiple answers ok");
eq(keyTypeProblem({ ...sprBase, correct_answer: "5 | -13" }), null, "SPR pipe-separated ok");
eq(keyTypeProblem({ ...sprBase, question_text: q17, correct_answer: "248.2" })?.code, "spr-rounding", "SPR rounding");
eq(keyTypeProblem({ ...sprBase, correct_answer: "12", choices: [{ label: "C", text: "4" }] })?.code, "spr-has-choices", "SPR with choices");
eq(keyTypeProblem({ ...sprBase, correct_answer: null }), null, "no key → no problem");
const mc = { question_type: "Multiple Choice", question_text: "Which?", choices: ["A", "B", "C", "D"].map((l) => ({ label: l, text: l + "x" })) };
eq(keyTypeProblem({ ...mc, correct_answer: "B" }), null, "MC B ok");
eq(keyTypeProblem({ ...mc, correct_answer: "249" })?.code, "mc-invalid-key", "MC numeric key");
eq(keyTypeProblem({ ...mc, correct_answer: "E" })?.code, "mc-invalid-key", "MC E");
eq(mcKeyProblem("A, C", mc.choices), null, "MC multi-letter ok");
eq(/isn't one of this question's choices/.test(mcKeyProblem("D", mc.choices.slice(0, 3)) ?? ""), true, "MC letter not among choices");

const blocker = findApproveBlocker("What is the value of x?", [], "Student Produced Response", "C");
eq(blocker !== null && /Fill-in \(SPR\).*choice letter/.test(blocker.reason), true, "approve blocked: SPR letter key");
eq(findApproveBlocker("What is the value of x?", [], "Student Produced Response", "12"), null, "approve ok: SPR 12");
eq(findApproveBlocker("What is the value of x?", [], "Student Produced Response"), null, "no key arg → old behaviour");
eq(
  /nearest whole number/.test(findApproveBlocker(q17, [], "Student Produced Response", "248.2")?.reason ?? ""),
  true,
  "approve blocked: rounding",
);
eq(
  /Multiple choice.*isn't a choice letter/.test(findApproveBlocker("Which?", mc.choices, "Multiple Choice", "249")?.reason ?? ""),
  true,
  "approve blocked: MC numeric",
);

// ── Layout post-processing: stray choices across a page break ────────
function pq(n: number, type: ParsedQuestion["question_type"], labels: string[], extra: Partial<ParsedQuestion> = {}): ParsedQuestion {
  return {
    original_question_number: n,
    question_text: `Question ${n} text`,
    choices: labels.map((l) => ({ label: l as "A", text: `${l}${n}` })),
    correct_answer: null,
    explanation: null,
    difficulty: "Medium",
    domain: "Algebra",
    skill: "s",
    concept: "c",
    question_type: type,
    has_image: false,
    has_table: false,
    has_formula: false,
    page_number: n,
    ai_confidence_score: 0.95,
    image_regions: [],
    ...extra,
  };
}
{
  const qs = [pq(16, "Multiple Choice", ["A", "B"]), pq(17, "Multiple Choice", ["C", "D"], { has_answer_box: true, correct_answer: "C" })];
  reattachStrayChoices(qs);
  eq(qs[0].choices.map((c) => c.label), ["A", "B", "C", "D"], "Q16 gets C/D back");
  eq([qs[1].question_type, qs[1].choices.length, qs[1].correct_answer], ["Student Produced Response", 0, null], "Q17 is fill-in, no choices, letter key cleared");
  eq((qs[1].review_reasons ?? []).length > 0 && (qs[0].review_reasons ?? []).length > 0, true, "both flagged for review");
}
{
  const qs = [pq(5, "Multiple Choice", ["A", "B", "C", "D"]), pq(6, "Student Produced Response", [], { question_text: "What is y? Answer Preview" })];
  reattachStrayChoices(qs);
  eq([qs[1].question_text, qs[1].review_reasons], ["What is y?", undefined], "Answer Preview stripped, no review needed");
}
{
  const qs = [pq(3, "Multiple Choice", ["A", "B", "C", "D"]), pq(4, "Multiple Choice", ["A", "B", "C", "D"], { has_answer_box: true })];
  reattachStrayChoices(qs);
  eq([qs[1].question_type, qs[1].choices.length, qs[0].choices.length], ["Student Produced Response", 0, 4], "answer box drops own choices");
}
{
  const qs = [pq(1, "Multiple Choice", ["A", "B", "C", "D"]), pq(2, "Multiple Choice", ["A", "B", "C", "D"])];
  reattachStrayChoices(qs);
  eq([qs[0].choices.length, qs[1].choices.length, qs[1].review_reasons], [4, 4, undefined], "normal MC untouched");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
