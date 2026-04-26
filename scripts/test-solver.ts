// One-off solver verification. Run from repo root with:
//   npx tsx --env-file=.env.prod scripts/test-solver.ts
//
// Imports the production solver directly so we exercise the same code
// path as the parse route.

import { solveQuestions } from "../lib/ai/solve-question";
import type { ParsedQuestion } from "../lib/ai/parse-pdf";

const fixtures: ParsedQuestion[] = [
  {
    original_question_number: 1,
    question_text:
      "Line q in the xy-plane has a slope of 1/7 and passes through the point (0, 60). Which equation defines line q?",
    choices: [
      { label: "A", text: "y = (1/7)x - 60" },
      { label: "B", text: "y = (1/7)x - 53" },
      { label: "C", text: "y = (1/7)x + 53" },
      { label: "D", text: "y = (1/7)x + 60" },
    ],
    correct_answer: null,
    explanation: null,
    difficulty: "Easy",
    domain: "Algebra",
    skill: "Linear equations",
    concept: "Slope-intercept form",
    question_type: "Multiple Choice",
    has_image: false,
    has_table: false,
    has_formula: true,
    page_number: 1,
    ai_confidence_score: 0.9,
    image_regions: [],
  },
  {
    original_question_number: 2,
    question_text: "If 3x + 9 = 24, what is the value of x?",
    choices: [
      { label: "A", text: "3" },
      { label: "B", text: "5" },
      { label: "C", text: "7" },
      { label: "D", text: "11" },
    ],
    correct_answer: null,
    explanation: null,
    difficulty: "Easy",
    domain: "Algebra",
    skill: "Linear equations in one variable",
    concept: "Solving for x",
    question_type: "Multiple Choice",
    has_image: false,
    has_table: false,
    has_formula: true,
    page_number: 1,
    ai_confidence_score: 0.95,
    image_regions: [],
  },
];

const expected: Record<number, string> = { 1: "D", 2: "B" };

async function main() {
  console.log(`[test-solver] solving ${fixtures.length} fixtures...`);
  const t0 = Date.now();
  const result = await solveQuestions(fixtures, new Map(), undefined);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[test-solver] done in ${elapsed}s\n`);

  let pass = 0;
  let fail = 0;
  for (const q of fixtures) {
    const ans = result.get(q.original_question_number);
    const exp = expected[q.original_question_number];
    const ok = ans?.correct_answer === exp;
    console.log(`Q${q.original_question_number}:`);
    console.log(`  question:    ${q.question_text.slice(0, 80)}...`);
    console.log(`  expected:    ${exp}`);
    console.log(`  got:         ${ans?.correct_answer ?? "<no answer>"}`);
    console.log(`  ${ok ? "PASS" : "FAIL"}`);
    console.log(`  explanation: ${(ans?.explanation ?? "").slice(0, 240)}...`);
    console.log("");
    if (ok) pass++;
    else fail++;
  }

  console.log(`\n[test-solver] ${pass}/${fixtures.length} correct`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
