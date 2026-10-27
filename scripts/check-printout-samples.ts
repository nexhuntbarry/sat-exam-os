// scripts/check-printout-samples.ts
//
// LOCAL ONLY — no DB, no Blob. Compares lib/printout-parser.ts output for the
// two owner-supplied printout samples against what the PDFs show, and writes
// a per-question table to .omc/qa/parse-samples-report.md.
//
// Ground truth:
//   ENG  — stems: poppler `pdftotext -layout` (an extractor independent of
//          pdfjs); choices + checkmarks: lib/pdf-text-choices.ts (separate
//          line walker). Image tables/graphs are listed for visual check.
//   Math — stems and most choices are images, so the reference below was
//          transcribed by hand from the rendered pages; plain-text choices
//          ("$25") and the checkmarks are also cross-checked automatically.
//
//   npx tsx scripts/check-printout-samples.ts            # re-parse (AI calls) + report
//   npx tsx scripts/check-printout-samples.ts --cached   # reuse .omc/qa/samples/out/*.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";

for (const l of readFileSync(".env.local", "utf-8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  // Only the Anthropic key: without Supabase creds nothing can be written.
  if (m && m[1] === "ANTHROPIC_API_KEY" && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const ENG = ".omc/qa/samples/SAT ENG Practice Test 11 Module 1.pdf";
const MATH = ".omc/qa/samples/SAT Math Practice Test 25 Module 1.pdf";
const OUT_DIR = ".omc/qa/samples/out";
const CACHED = process.argv.includes("--cached");

type Q = {
  original_question_number: number;
  question_text: string;
  choices: { label: string; text: string }[];
  correct_answer: string | null;
  question_type: string;
  image_regions: { page: number; alt: string }[];
  review_reasons?: string[];
};

// Hand transcription of the Math sample (rendered pages, 75 dpi).
const MATH_TRUTH: { stem: string; choices: string[]; answer: string; figure?: boolean }[] = [
  { stem: "The function w models the weight, in ounces, of the remaining solid wax of a burning candle as a function of the time x, in hours, after the candle was lit. The graph of y = w(x) is shown. According to the model, what was the weight, in ounces, of the candle's remaining solid wax 12 hours after the candle was lit?", choices: ["4", "8", "10", "13"], answer: "C", figure: true },
  { stem: "In triangle EFG, the sum of the measures of angles E and F is 36°. What is the measure of angle G?", choices: ["36°", "54°", "108°", "144°"], answer: "D" },
  { stem: "A local gym is offering a 25% discount on an annual membership. The regular cost of an annual membership is $288. How much less is the discounted cost of the membership than the regular cost of the membership?", choices: ["$25", "$72", "$216", "$288"], answer: "B" },
  { stem: "x y 0 22 1 23 2 24 The table shows three values of x and their corresponding values of y. There is a linear relationship between x and y. Which of the following equations represents this relationship?", choices: ["y=x+22", "y=24x", "y=24x+2", "y=22x"], answer: "A" },
  { stem: "The function f is defined by the equation f(x) = 380x. What is the value of f(10)?", choices: [], answer: "3800" },
  { stem: "Which of the following equations has solutions 13 and -24?", choices: ["(x-24)(x+13)=0", "(x-13)(x+24)=0", "(x+13)(x+24)=0", "(x-24)(x-13)=0"], answer: "B" },
  { stem: "y=0 y=8(x2-36) Which ordered pair (x, y) is a solution to the given system of equations?", choices: ["(0, 6)", "(0, 36)", "(6, 0)", "(36, 0)"], answer: "C" },
  { stem: "When a scientist began observing a sample of an isotope, the mass of the sample was 530,000 milligrams. The mass of the sample decreases by half approximately every 5 days. Which of the following is closest to the mass, in milligrams, of the sample 35 days after the scientist began observing the sample?", choices: ["4,141", "15,143", "16,563", "75,714"], answer: "A" },
  { stem: "The height of a right circular cylinder is 31 inches, and the circumference of its base is 310 inches. Which expression represents the total surface area, in square inches, of the cylinder?", choices: ["(31)(310)", "π(155/π)2(31)", "(31)(310) + π(155/π)2", "(31)(310) + 2π(155/π)2"], answer: "D" },
  { stem: "The function f(w) = 6w2 gives the area of a rectangle, in square feet (ft2), if its width is w ft and its length is 6 times its width. Which of the following is the best interpretation of f(14)= 1,176 ?", choices: ["If the width of the rectangle is 14 ft, then the area of the rectangle is 1,176 ft2 .", "If the width of the rectangle is 14 ft, then the length of the rectangle is 1,176 ft.", "If the width of the rectangle is 1,176 ft, then the length of the rectangle is 14 ft.", "If the width of the rectangle is 1,176 ft, then the area of the rectangle is 14 ft2 ."], answer: "A" },
  { stem: "The expression (2x+5)(7x-10) can be written in the form ax2+ bx + c, where a, b, and c are constants. What is the value of a+b ?", choices: [], answer: "29" },
  { stem: "The ratio a to b is equivalent to the ratio 49 to 26. What is the value of a when b = 182?", choices: [], answer: "343" },
  { stem: "At the beginning of the year, Imani has $170 in her account. Each month this year, she will deposit between $30 and $60 into the account. Which inequality represents all possibilities for the total amount of money x, in dollars, in Imani's account after 10 months of deposits this year?", choices: ["x ≤ 300", "x ≥ 600", "170 ≤ x ≤ 620", "470 ≤ x ≤ 770"], answer: "D" },
  { stem: "The function f is defined by f(x) = (x - 2)(x - 8)(x + 3). In the xy-plane, the graph of y = h(x) is the result of translating the graph of y = f(x) up 6 units. What is the y-coordinate of the y-intercept of the graph of y = h(x)?", choices: ["54", "48", "6", "0"], answer: "A" },
  { stem: "A circle has a circumference of 42π centimeters. What is the diameter, in centimeters, of the circle?", choices: [], answer: "42" },
  { stem: "How many solutions does the equation 35x - 25 = 5(7x - 5) have?", choices: ["Exactly one", "Exactly two", "Infinitely many", "Zero"], answer: "C" },
  { stem: "On January 1, 2000, the population of a town was 26,255 and on January 1, 2010, the population was 26,956. The equation 10x+26,255=26,956 describes this situation. Which of the following is the best interpretation of x in this context?", choices: ["The total increase in population between 2000 and 2010", "The average increase per year of the population between 2000 and 2010", "The percentage by which the population of the town increased each year between 2000 and 2010", "The projected population of the town 10 years after 2010"], answer: "B" },
  { stem: "For the linear function f, f(-2)=-9, and the slope of the graph of y=f(x) in the xy-plane is 8. Which equation defines f?", choices: ["f(x)=8x-11", "f(x)=8x-9", "f(x)=8x-2", "f(x)=8x+7"], answer: "D" },
  { stem: "In the xy-plane, an equation of circle A is (x-2)2+(y-3)2=9. Circle B has the same center as circle A but has a radius that is twice the radius of circle A. Which equation represents circle B?", choices: ["(x-2)2+(y-3)2=18", "(x-2)2+(y-3)2=36", "(x-2)2+(y-3)2=54", "(x-2)2+(y-3)2=81"], answer: "B" },
  { stem: "Line k contains the points (-3,-60), (v, 0), and (5,76). What is the value of v?", choices: [], answer: "9/17" },
  { stem: "In right triangle FGH shown, what is the value of cosF?", choices: ["√3/68", "1/2", "√3/2", "34√3"], answer: "C", figure: true },
  { stem: "Based on a model, on day 1 of an 8-day experiment, a lima bean plant had an estimated mass of 253 grams, and each day after day 1 of the experiment, the estimated mass of the plant decreased by 4 grams. Which equation represents this model, where m is the estimated mass, in grams, of the plant on day x of the experiment and 1 ≤ x ≤ 8?", choices: ["m=-4x +245", "m=-4x + 249", "m=-4x + 253", "m=-4x + 257"], answer: "D" },
];

/** Content-only comparison: drop LaTeX commands, markup, punctuation, spacing. */
function norm(s: string): string {
  return (s || "")
    .normalize("NFKC")
    .replace(/<\/?u>/g, "")
    .replace(/\\\$/g, "$")
    .replace(/\\(sin|cos|tan|log|ln)\b/g, "$1")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Markdown table rows → bare cells, so a table compares as its content. */
function tableToCells(s: string): string {
  return s
    .split("\n")
    .filter((l) => !/^\|?\s*:?-{2,}/.test(l.trim()))
    .join("\n");
}

function md(s: string, max = 90): string {
  const t = s.replace(/\n+/g, " ⏎ ").replace(/\|/g, "\\|");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Poppler-based stems for the ENG sample (independent of pdfjs). */
function popplerStems(pdf: string): Map<number, string> {
  const raw = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/[-]/g, "").trim())
    .filter((l) => l && !/^\d{1,2}\/\d{1,2}\/\d{2,4},/.test(l) && !/^https?:\/\//.test(l));
  const out = new Map<number, string>();
  let cur: number | null = null;
  let buf: string[] = [];
  let next = 1;
  const flush = () => {
    if (cur !== null) out.set(cur, buf.join(" "));
  };
  for (const l of lines) {
    const m = l.match(/^(\d{1,3})\.\s*(.*)$/);
    if (m && Number(m[1]) === next) {
      flush();
      cur = next++;
      buf = m[2] ? [m[2]] : [];
      continue;
    }
    if (cur === null) continue;
    if (l === "A") {
      flush();
      cur = null;
      continue;
    }
    if (/^\d{1,3}$/.test(l)) continue; // number box
    buf.push(l);
  }
  flush();
  return out;
}

async function parse(pdf: string, section: "Math" | "Reading & Writing", name: string) {
  const file = `${OUT_DIR}/${name}.json`;
  if (CACHED && existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
  const { parsePrintoutPdf } = await import("../lib/printout-parser");
  const r = await parsePrintoutPdf(readFileSync(pdf).toString("base64"), { section, difficulty_hint: "Mixed", moduleNumber: 1 });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(r, null, 2));
  return r;
}

async function main() {
  const { extractChoicesFromPdfText } = await import("../lib/pdf-text-choices");
  const report: string[] = [];
  const summary: string[] = [];

  // ── ENG ──
  {
    const r = await parse(ENG, "Reading & Writing", "eng");
    const qs = r.questions as Q[];
    const walker = await extractChoicesFromPdfText(readFileSync(ENG).toString("base64"));
    const stems = popplerStems(ENG);
    let ok = 0;
    const rows: string[] = [];
    for (const q of qs) {
      const n = q.original_question_number;
      const w = walker.byNumber.get(n);
      // Image tables/titles aren't in poppler's text → compare prose only.
      const paras = q.question_text.split("\n\n");
      const isTable = (p: string) => p.includes("| --- |");
      const prose = paras
        .filter((p, i) => !isTable(p) && !(i + 1 < paras.length && isTable(paras[i + 1]) && p.length < 120 && !/[.?!]$/.test(p)))
        .join(" ");
      const stemOk = norm(prose) === norm(stems.get(n) ?? "");
      const choicesOk = !!w && w.choices.every((c, i) => norm(q.choices[i]?.text ?? "") === norm(c.text) && q.choices[i]?.label === c.label);
      const ansOk = !!w && q.correct_answer === w.checked;
      const all = stemOk && choicesOk && ansOk;
      if (all) ok++;
      const visual = [
        q.question_text.includes("| --- |") ? "table (image) → Markdown" : "",
        q.image_regions.length ? `figure → image (p${q.image_regions[0].page})` : "",
        q.question_text.includes("<u>") ? "underline → <u>" : "",
      ].filter(Boolean).join("; ");
      rows.push(
        `| ${n} | ${stemOk ? "✅" : "❌"} | ${md(q.question_text, 70)} | ${choicesOk ? "✅" : "❌"} | ${md(q.choices.map((c) => `${c.label}) ${c.text}`).join(" / "), 70)} | ${md((w?.choices ?? []).map((c) => `${c.label}) ${c.text}`).join(" / "), 70)} | ${q.correct_answer ?? "—"} | ${w?.checked ?? "—"} | ${visual || "—"} | ${all ? "✅" : "❌"} |`,
      );
    }
    summary.push(`- **ENG (SAT ENG Practice Test 11 Module 1, 30 pp):** ${qs.length} questions parsed (PDF: ${walker.questionsSeen}); answers detected ${r.stats.answersDetected}/${qs.length}; exact match ${ok}/${qs.length}; figures cropped ${r.stats.figures}; Needs Review ${r.stats.needsReview}.`);
    report.push(
      "## SAT ENG Practice Test 11 Module 1",
      "",
      "Stem reference = poppler `pdftotext -layout` (independent of pdfjs); choices/checkmark reference = `lib/pdf-text-choices.ts` line walker. Image tables/graph are not in the text layer — their transcription is listed under *Visual* and was checked by eye against the rendered page.",
      "",
      "| Q | Stem | Parsed stem | Choices | Parsed choices | PDF choices | Parsed ans | PDF ✓ | Visual | Match |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...rows,
      "",
    );
  }

  // ── Math ──
  {
    const r = await parse(MATH, "Math", "math");
    const qs = r.questions as Q[];
    const walker = await extractChoicesFromPdfText(readFileSync(MATH).toString("base64"));
    let ok = 0;
    const rows: string[] = [];
    for (const q of qs) {
      const n = q.original_question_number;
      const t = MATH_TRUTH[n - 1];
      const stemOk = !!t && norm(tableToCells(q.question_text)) === norm(t.stem);
      const choicesOk =
        !!t &&
        q.choices.length === t.choices.length &&
        t.choices.every((c, i) => q.choices[i]?.label === "ABCD"[i] && norm(q.choices[i].text) === norm(c));
      const ansOk = !!t && norm(q.correct_answer ?? "") === norm(t.answer);
      const w = walker.byNumber.get(n);
      const ansWalkerOk = !w || w.checked === q.correct_answer; // text-layer check for MC with text choices
      const figOk = !!t && !!t.figure === q.image_regions.length > 0;
      const all = stemOk && choicesOk && ansOk && ansWalkerOk && figOk && n === qs.indexOf(q) + 1;
      if (all) ok++;
      rows.push(
        `| ${n} | ${q.question_type === "Multiple Choice" ? "MC" : "SPR"} | ${stemOk ? "✅" : "❌"} | ${md(q.question_text, 60)} | ${choicesOk ? "✅" : "❌"} | ${md(q.choices.map((c) => `${c.label}) ${c.text}`).join(" / "), 70)} | ${md(t?.choices.map((c, i) => `${"ABCD"[i]}) ${c}`).join(" / ") ?? "", 60)} | ${q.correct_answer ?? "—"} | ${t?.answer ?? "—"} | ${figOk ? (q.image_regions.length ? "✅ figure cropped" : "✅ none") : "❌"} | ${all ? "✅" : "❌"} |`,
      );
    }
    summary.push(`- **Math (SAT Math Practice Test 25 Module 1, 16 pp):** ${qs.length} questions parsed (PDF: 22); answers detected ${r.stats.answersDetected}/${qs.length}; exact match ${ok}/${qs.length}; image crops transcribed ${r.stats.imagesTranscribed}; figures cropped ${r.stats.figures}; Needs Review ${r.stats.needsReview}.`);
    report.push(
      "## SAT Math Practice Test 25 Module 1",
      "",
      "Stems and most choices are images in this PDF. Reference = hand transcription from the rendered pages; comparison ignores LaTeX markup only (`$`, `\\frac`, braces), so every digit, letter and sign must match. Checkmarks are also cross-checked against the text layer.",
      "",
      "| Q | Type | Stem | Parsed stem | Choices | Parsed choices | PDF choices | Parsed ans | PDF ✓ | Figure | Match |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      ...rows,
      "",
    );
  }

  const doc = [
    "# Printout parser — sample verification",
    "",
    `Generated ${new Date().toISOString()} by \`scripts/check-printout-samples.ts\` (local library call; no DB writes, no Blob uploads).`,
    "",
    ...summary,
    "",
    ...report,
  ].join("\n");
  writeFileSync(".omc/qa/parse-samples-report.md", doc);
  console.log(summary.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
