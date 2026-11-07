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

extractorShortCircuit().then(() => {
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
});
