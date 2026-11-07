// Unit checks for the answer-key source guards (lib/answer-marks.ts):
//  - a PDF with no answer marks never yields an "official" key,
//  - an extracted key with a letter on a fill-in (SPR) question is rejected.
//   node --import tsx scripts/test-key-guards.ts
import {
  answerMarkFactsFromText,
  keyRejectedNote,
  noAnswerMarksReason,
  sprLetterKeyQuestions,
  sprLetterKeyReason,
  KEY_REJECTED_PREFIX,
} from "../lib/answer-marks";
import { extractAnswerKey } from "../lib/ai/parse-pdf";
import { autoKeyDecision, checksSummary, moduleHasRealKey, type VerifyChecks } from "../lib/verify-ai-key";
import { markNotRescored, notRescoredNote, rescoreHoldReason, RESCORE_HELD_PREFIX } from "../lib/reparse-rescore";

let fail = 0;
const ok = (n: string, c: boolean, detail?: unknown) => {
  console.log(c ? "PASS" : "FAIL", n, detail !== undefined && !c ? JSON.stringify(detail) : "");
  if (!c) fail++;
};

// ── No answer marks ──────────────────────────────────────────────────
const page = (body: string, url: string) =>
  `10/24/26, 4:59 PM Survey: print page | Premier Plus Education\n${body}\n${url} 3/12\n`.repeat(4);
const STEM = "1. The line m has slope 3/8. Which of the following is the slope of a line perpendicular to m? A -8/3 B -3/8 C 3/8 D 8/3";

// J Test Math M1: student copy — no answer_token, no ✓.
const jM1 = answerMarkFactsFromText(page(STEM, "https://premierdigitalsat.com/survey/print/d1c1704b-ad29-4050-9e74-47202f4e053a?"));
ok("student printout: detected as Premier, no token, no marks", jM1.premierPrintout && !jM1.answerToken && jM1.checkMarks === 0, jM1);
ok("student printout: no key allowed", !!noAnswerMarksReason(jM1));

// Answer version: answer_token + ✓ marks.
const keyed = answerMarkFactsFromText(page(STEM + " ", "https://premierdigitalsat.com/survey/print/1ba5d976?answer_token=4c1cbad9-0964"));
ok("answer printout (token + ✓): key allowed", noAnswerMarksReason(keyed) === null, keyed);

// Token but no marks: still no key.
const tokenOnly = answerMarkFactsFromText(page(STEM, "https://premierdigitalsat.com/survey/print/1ba5d976?answer_token=4c1cbad9-0964"));
ok("token without ✓ marks: no key allowed", !!noAnswerMarksReason(tokenOnly));

// Student copy with an appended key page ([Test #12] L Test M1 p14).
const withKeyPage = answerMarkFactsFromText(
  page(STEM, "https://premierdigitalsat.com/survey/print/d1c1704b?") + "\nSAT MATH MODULE 1 AK\n1. B 2. B 3. 1/3 4. D 5. A 6. C 7. B\n",
);
ok("student printout + answer-key page: key allowed", noAnswerMarksReason(withKeyPage) === null, withKeyPage);
const roster = answerMarkFactsFromText("1. B 2. C 3. A 4. D 5. B 6. A");
ok("a bare 1. B 2. C … roster counts as a key page", roster.keyPageCue);

// Not a Premier printout (screenshot PDF with OCR text): can't judge → allowed (extractor decides).
const other = answerMarkFactsFromText("www.satqas.com Section 2, Module 1: Math ".repeat(20) + STEM);
ok("non-Premier PDF: not blocked by the text rule", noAnswerMarksReason(other) === null, other);
ok("image-only PDF: not blocked", noAnswerMarksReason(answerMarkFactsFromText("")) === null);

// extractAnswerKey returns found=false for a no-marks PDF without calling the model.
async function extractorShortCircuit() {
  const t = Date.now();
  const k = await extractAnswerKey("not-a-pdf", undefined, jM1);
  ok("extractAnswerKey: no-marks PDF → found=false, no answers", k.found === false && Object.keys(k.answers).length === 0, k);
  ok("extractAnswerKey: reason in notes", !!k.notes && /answer_token/.test(k.notes), k.notes);
  ok("extractAnswerKey: no model call (instant)", Date.now() - t < 1000);
}

// ── Letter key on a fill-in question ─────────────────────────────────
const SPR = "Student Produced Response";
const MC = "Multiple Choice";
const types: Record<number, string> = {};
for (let n = 1; n <= 22; n++) types[n] = [5, 14, 19, 20, 21].includes(n) ? SPR : MC;
const qs = Object.entries(types).map(([n, t]) => ({ original_question_number: Number(n), question_type: t }));
// The invented J Test Math M1 key.
const jKeyList = "D A B A B A B C C B A C B 0 A C B C B B B B".split(" ");
const jKey: Record<number, string> = {};
jKeyList.forEach((v, i) => (jKey[i + 1] = v));
ok("J M1 key: letters on fill-ins Q5, Q19, Q20, Q21 found", JSON.stringify(sprLetterKeyQuestions(jKey, qs)) === "[5,19,20,21]", sprLetterKeyQuestions(jKey, qs));

const realKey: Record<number, string> = { ...jKey, 5: "6/13", 14: "0", 19: "6.8", 20: "6", 21: "21.5" };
ok("real key (numbers on fill-ins): accepted", sprLetterKeyQuestions(realKey, qs) === null);
ok("\"(B)\" on a fill-in is a letter", JSON.stringify(sprLetterKeyQuestions({ 5: "(B)" }, qs)) === "[5]");
ok("\"b\" on a fill-in is a letter", JSON.stringify(sprLetterKeyQuestions({ 19: "b" }, qs)) === "[19]");
ok("no key → nothing to reject", sprLetterKeyQuestions(null, qs) === null);
ok("letters on MC questions are fine", sprLetterKeyQuestions({ 1: "D", 2: "A" }, qs) === null);
ok("a fill-in missing from the key is fine", sprLetterKeyQuestions({ 1: "D" }, qs) === null);

const note = keyRejectedNote(sprLetterKeyReason([5, 19, 20, 21]));
ok("rejection note is one parsing_notes segment (no ';')", !note.includes(";"), note);
ok("rejection note starts with the Needs review prefix", note.startsWith(KEY_REJECTED_PREFIX) && note.startsWith("Needs review:"), note);
ok("rejection note names the questions", note.includes("Q5, Q19, Q20, Q21"), note);

// ── Auto-key for modules with no real answer key (lib/verify-ai-key.ts) ──
{
  const mc = { question_type: "Multiple Choice", question_text: "What is the net percentage increase?", correct_answer: "B", official_answer: null };
  const ch = (o: Partial<VerifyChecks> = {}): VerifyChecks => ({
    section: "Math",
    first: { answer: "A", value: 100, mapped: true, method: "code", problems: [] },
    plugBack: { status: "fail", detail: "2.5*0.8 == 2.2" },
    second: { answer: "A", method: "math-alt", problems: [] },
    ...o,
  });
  const noKey = { moduleHasRealKey: false, live: false };
  const d = autoKeyDecision(mc, ch(), noKey);
  ok("no-key module, code solve + second solve agree on A → set key A", d.action === "set_key" && d.key === "A", d);
  ok("module with a real key → a person decides", autoKeyDecision(mc, ch(), { ...noKey, moduleHasRealKey: true }).action === "none");
  ok("question with an official answer → a person decides", autoKeyDecision({ ...mc, official_answer: "B" }, ch(), noKey).action === "none");
  ok("live-test question → queued, key not changed", autoKeyDecision(mc, ch(), { ...noKey, live: true }).action === "queue_live");
  ok("solves disagree with each other → none", autoKeyDecision(mc, ch({ second: { answer: "C", method: "math-alt", problems: [] } }), noKey).action === "none");
  ok("first solve not code-checked (model letter) → none", autoKeyDecision(mc, ch({ first: { answer: "A", value: null, mapped: false, method: "code", problems: [] } }), noKey).action === "none");
  ok("stored key's plug-back holds → none (split evidence)", autoKeyDecision(mc, ch({ plugBack: { status: "pass", detail: "1 condition" } }), noKey).action === "none");
  ok("both give the stored key → none", autoKeyDecision({ ...mc, correct_answer: "A" }, ch(), noKey).action === "none");
  ok("Reading & Writing (no code check) → none", autoKeyDecision(mc, { section: "Reading & Writing", first: { answer: "A", method: "rw-standard", problems: [] }, plugBack: null, second: { answer: "A", method: "rw-eliminate", problems: [] } }, noKey).action === "none");
  const spr = { question_type: "Student Produced Response", question_text: "What is x?", correct_answer: "4224", official_answer: null };
  const ds = autoKeyDecision(spr, ch({ first: { answer: "990", value: 990, method: "code", problems: [] }, second: { answer: "990", value: 990, method: "math-alt", problems: [] } }), noKey);
  ok("fill-in: 4224 → 990 when both solves give 990", ds.action === "set_key" && ds.key === "990", ds);
  // [Test #13] L Test 1 Math M2 Q9 (graph of y = 2f(x) − 3; f(x) = 2 at x = 4):
  // stored 7, code solve 2, second solve 3 → never auto-picked.
  const q9 = { question_type: "Student Produced Response", question_text: "The graph of y = 2f(x) − 3 is shown. For what value of x is f(x) = 2?", correct_answer: "7", official_answer: null, image_urls: ["https://x.public.blob.vercel-storage.com/q9.png"] };
  const q9ch = ch({ first: { answer: "2", value: 2, method: "code", problems: [], figurePoints: "(0,-3), (1,-1), fit: 2x-3" }, plugBack: { status: "fail", detail: "x" }, second: { answer: "3", value: 3, method: "math-alt", problems: [] } });
  const q9d = autoKeyDecision(q9, q9ch, noKey);
  ok("L Test M2 Q9: 7 / 2 / 3 → a person decides (no auto-pick)", q9d.action === "none" && /disagree/.test(q9d.reason), q9d);
  const q9agree = ch({ first: { answer: "4", value: 4, method: "code", problems: [] }, second: { answer: "4", value: 4, method: "math-alt", problems: [] } });
  ok("figure question without read points → no auto-pick even if solves agree", autoKeyDecision(q9, q9agree, noKey).action === "none");
  const q9pts = ch({ first: { answer: "4", value: 4, method: "code", problems: [], figurePoints: "(0,-3), (1,-1), (4,1), (9,3), fit: y = 2*sqrt(x) - 3" }, second: { answer: "4", value: 4, method: "math-alt", problems: [] } });
  ok("figure question: exact points read + both solves 4 → set key 4", autoKeyDecision(q9, q9pts, noKey).key === "4");
  ok("read points shown in the queue note", /read points 0,-3 , 1,-1 , fit: 2x-3/.test(checksSummary(q9ch, "7")), checksSummary(q9ch, "7"));
  ok("moduleHasRealKey", moduleHasRealKey([{ official_answer: null }, { official_answer: "B" }]) && !moduleHasRealKey([{ official_answer: null }, { official_answer: " " }]));
}

// ── Re-parse: rescore to the official key only when it can be trusted ──
{
  const off = { question_type: "Multiple Choice", correct_answer: "C", official_answer: "C", parsing_notes: null };
  ok("re-parse rescore: clean official key → rescore", rescoreHoldReason(off, null, { sprLetterQuestions: [], keyDisagreement: null }) === null);
  ok("re-parse rescore: module key in doubt → held", /in doubt/.test(rescoreHoldReason(off, "Needs review: the PDF's answer key disagrees with the solved answer on 9 of 22 questions", null) ?? ""));
  ok("re-parse rescore: letter key on a fill-in → held", rescoreHoldReason({ ...off, question_type: "Student Produced Response", correct_answer: "B", official_answer: "B" }, null, null) !== null);
  ok("re-parse rescore: module key gives letters to fill-ins → held", rescoreHoldReason(off, null, { sprLetterQuestions: [5, 19], keyDisagreement: null }) !== null);
  ok("re-parse rescore: key marked as made up → held", rescoreHoldReason({ ...off, parsing_notes: "Needs review: the answer key read from the PDF was not used — x" }, null, null) !== null);
}

// Re-parse: a skipped / failed rescore always leaves the "not rescored" note.
async function notRescoredNotes() {
  const rows: Record<string, { parsing_notes: string | null }> = { a: { parsing_notes: "Re-parse: official key=C, solver said B — verify" }, b: { parsing_notes: null } };
  const db = {
    from: () => {
      let id = "";
      let patch: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        update: (u: Record<string, unknown>) => ((patch = u), b),
        eq: (_k: string, v: string) => ((id = v), patch ? (Object.assign(rows[id], patch), Promise.resolve({ data: null, error: null })) : b),
        maybeSingle: () => Promise.resolve({ data: rows[id] ?? null, error: null }),
      };
      return b;
    },
  } as unknown as Parameters<typeof markNotRescored>[0];
  await markNotRescored(db, ["a", "b"], "the module's key checks didn't finish");
  await markNotRescored(db, ["a"], "again");
  ok("not-rescored note appended to existing notes", rows.a.parsing_notes!.startsWith("Re-parse: official key=C") && rows.a.parsing_notes!.includes(RESCORE_HELD_PREFIX), rows.a.parsing_notes);
  ok("not-rescored note on empty notes", rows.b.parsing_notes === notRescoredNote("the module's key checks didn't finish"), rows.b.parsing_notes);
  ok("not-rescored note added once", rows.a.parsing_notes!.split(RESCORE_HELD_PREFIX).length === 2);
  ok("not-rescored note is one segment (no ';')", !notRescoredNote("a; b").includes(";"));
}

notRescoredNotes().then(extractorShortCircuit).then(() => {
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
});
