// Unit checks for lib/answer-key-merge.ts and the ✓ readers it relies on.
//   node --import tsx scripts/test-answer-key-merge.ts
// (also run by `npm run check` through .omc/qa/unit/answer-key-merge.test.ts)
//
// The AI answer-key probe sometimes gives question n the ✓ of question n−1
// (question n−1's choices B–D carry over to the next page — Tests #9, #22,
// #23, #2). The parse route used to treat the probe's key as a person's
// upload, so the deterministic ✓ lost. Now: a ✓ replaces the probe's answer
// silently only on strong evidence for that question; any other disagreement
// goes to Needs Review with both values; a person's upload and keys already
// stored in the database are never changed by a ✓.
import assert from "node:assert/strict";
import {
  answerKeySourceOf,
  deterministicTicks,
  mergeTicksIntoKey,
  probeConflictNote,
  probeOverrideNote,
  reparseKeyDecision,
  solverConflictNote,
  storedConflictNote,
  storedKeyAfterSolve,
  finalStoredKeyRestore,
  restoredExplanationNote,
  restoredKeyNote,
  weakFillNote,
  uploadConflictNote,
  type TickEvidence,
} from "../lib/answer-key-merge";
import {
  bindChoiceLines,
  bindLabelTickLines,
  type ChoiceLabel,
  type LabelTick,
  type PdfLine,
  type PdfTextQuestion,
} from "../lib/pdf-text-choices";
import { explanationArguesOther } from "../lib/explanation-autofix";

const MC = "Multiple Choice";
const SPR = "Student Produced Response";
const strong = (tick: string): TickEvidence => ({ tick, strong: true });
const weak = (tick: string, why = "test"): TickEvidence => ({ tick, strong: false, why });
const ev = (o: Record<number, TickEvidence>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
const allMc = (...ns: number[]) => new Map(ns.map((n) => [n, MC as string | null]));

// ── Source flag: only an explicit "upload" is authoritative. Old clients (no
// flag) only ever sent the probe's key.
assert.equal(answerKeySourceOf("upload"), "upload");
assert.equal(answerKeySourceOf("probe"), "probe");
assert.equal(answerKeySourceOf(undefined), "probe");
assert.equal(answerKeySourceOf("UPLOAD"), "probe");
assert.equal(answerKeySourceOf(true), "probe");

// ── Probe vs strong ✓ on an MC question: the ✓ wins, with a note.
{
  const key = { 3: "A", 4: "B" };
  const m = mergeTicksIntoKey(key, ev({ 3: strong("D"), 4: strong("B") }), "probe", allMc(3, 4));
  assert.deepEqual(m.key, { 3: "D", 4: "B" });
  assert.equal(m.notes.get(3), "Answer key: probe said A, PDF ticks D; used the PDF tick");
  assert.equal(m.notes.size, 1);
  assert.equal(m.conflicts.size, 0);
  assert.equal(m.overrides, 1);
  assert.deepEqual(key, { 3: "A", 4: "B" }, "input key not mutated");
}

// ── Probe vs weak ✓: key kept, Needs Review with both values.
{
  const m = mergeTicksIntoKey({ 3: "A" }, ev({ 3: weak("D", "the parsed choices don't match the PDF's") }), "probe", allMc(3));
  assert.equal(m.key[3], "A");
  assert.equal(m.conflicts.get(3), probeConflictNote("A", "D", "the parsed choices don't match the PDF's"));
  assert.match(m.conflicts.get(3)!, /^Needs review: probe said A, PDF ticks D/);
  assert.equal(m.overrides, 0);
  // Strong ✓ but the question type is unknown → not strong enough.
  const u = mergeTicksIntoKey({ 3: "A" }, ev({ 3: strong("D") }), "probe");
  assert.equal(u.key[3], "A");
  assert.match(u.conflicts.get(3)!, /question type unknown/);
}

// ── Upload vs ✓: the uploaded key stays, the question is flagged (today's behaviour).
{
  const m = mergeTicksIntoKey({ 3: "A", 4: "B" }, ev({ 3: strong("D"), 4: strong("B") }), "upload", allMc(3, 4));
  assert.deepEqual(m.key, { 3: "A", 4: "B" });
  assert.equal(m.conflicts.get(3), uploadConflictNote("A", "D"));
  assert.match(m.conflicts.get(3)!, /^Needs review: the uploaded answer key says A but the source PDF ticks D/);
  assert.equal(m.notes.size, 0);
}

// ── No ✓ → the probe's answer stands; a ✓ fills a question the key lacks.
for (const source of ["probe", "upload"] as const) {
  const m = mergeTicksIntoKey({ 1: "C", 2: "17" }, ev({ 5: strong("B") }), source, allMc(1, 5));
  assert.deepEqual(m.key, { 1: "C", 2: "17", 5: "B" }, source);
  assert.equal(m.notes.size + m.conflicts.size, 0, source);
}
assert.deepEqual(mergeTicksIntoKey(null, new Map(), "probe").key, {});
// Case/space differences are not disagreements.
assert.equal(mergeTicksIntoKey({ 1: " c " }, ev({ 1: strong("C") }), "upload", allMc(1)).conflicts.size, 0);
assert.equal(mergeTicksIntoKey({ 1: "c" }, ev({ 1: strong("C") }), "probe", allMc(1)).notes.size, 0);

// ── A letter ✓ on a fill-in (SPR) question never touches its key (either
// source), and never fills one.
for (const source of ["probe", "upload"] as const) {
  const types = new Map<number, string | null>([[7, SPR], [8, SPR]]);
  const m = mergeTicksIntoKey({ 7: "12" }, ev({ 7: strong("B"), 8: strong("C") }), source, types);
  assert.deepEqual(m.key, { 7: "12" }, source);
  assert.equal(m.notes.size + m.conflicts.size, 0, source);
}
// A fill-in answer read off a printout box only fills gaps under the probe
// (the probe may list accepted forms); an upload still flags the difference.
{
  const types = new Map<number, string | null>([[7, SPR], [8, SPR]]);
  const p = mergeTicksIntoKey({ 7: "3/4, .75" }, ev({ 7: weak("3/4"), 8: weak(".5") }), "probe", types);
  assert.deepEqual(p.key, { 7: "3/4, .75", 8: ".5" });
  assert.equal(p.notes.size + p.conflicts.size, 0);
  const u = mergeTicksIntoKey({ 7: "3/4, .75" }, ev({ 7: weak("3/4") }), "upload", types);
  assert.equal(u.key[7], "3/4, .75");
  assert.equal(u.conflicts.size, 1);
}

// ── Shift scenario ([Test #9] Eng M1 shape): the probe gives Q3 and Q10 the
// ✓ of Q2 and Q9. Strong ✓s put every shifted answer back; no ✓ → probe.
{
  const pdf: Record<number, string> = { 1: "B", 2: "A", 3: "D", 4: "C", 9: "A", 10: "C", 11: "A" };
  const probe: Record<number, string> = { ...pdf, 3: "A", 10: "A", 12: "B" };
  const ticks = new Map(Object.entries(pdf).map(([n, t]) => [Number(n), strong(t)]));
  const types = allMc(...Object.keys(probe).map(Number));
  const m = mergeTicksIntoKey(probe, ticks, "probe", types);
  for (const [n, t] of Object.entries(pdf)) assert.equal(m.key[Number(n)], t, `Q${n}`);
  assert.equal(m.key[12], "B", "no tick → probe");
  assert.deepEqual([...m.notes.keys()].sort((a, b) => a - b), [3, 10]);
  assert.equal(m.notes.get(10), probeOverrideNote("A", "C"));
  // The same key sent as an upload is NOT corrected — only flagged.
  const u = mergeTicksIntoKey(probe, ticks, "upload", types);
  assert.equal(u.key[3], "A");
  assert.deepEqual([...u.conflicts.keys()].sort((a, b) => a - b), [3, 10]);
  // Re-merging the merged key changes nothing (the route re-merges per stage).
  const again = mergeTicksIntoKey(m.key, ticks, "probe", types);
  assert.deepEqual(again.key, m.key);
  assert.equal(again.notes.size + again.conflicts.size, 0);
}

// ── Re-parse in place: stored keys behave like an upload.
{
  // [Test #23] Math M1 Q15: official empty, correct_answer B, label-only ✓ D.
  const q15 = reparseKeyDecision({ storedOfficial: null, storedCorrect: "B", probe: null, type: MC }, strong("D"));
  assert.equal(q15.seed, "B", "stored key kept");
  assert.equal(q15.official, null, "official left empty");
  assert.deepEqual(q15.review, [storedConflictNote("B", "D")]);
  assert.equal(q15.note, null);
  // Stored official vs a probe that disagrees (no ✓) → review, key kept.
  const p = reparseKeyDecision({ storedOfficial: "C", storedCorrect: "C", probe: "A", type: MC }, undefined);
  assert.equal(p.seed, "C");
  assert.equal(p.official, "C");
  assert.match(p.review[0], /^Needs review: the stored key says C but the answer key read from the PDF says A/);
  // ✓ and probe confirm the stored key → no review; an empty official is filled with it.
  const ok = reparseKeyDecision({ storedOfficial: null, storedCorrect: "D", probe: "D", type: MC }, strong("D"));
  assert.deepEqual(ok, { official: "D", seed: "D", review: [], note: null, storedKey: true });
  // No stored key: this run's probe under probe rules.
  const fresh = reparseKeyDecision({ storedOfficial: null, storedCorrect: null, probe: "A", type: MC }, strong("D"));
  assert.equal(fresh.official, "D");
  assert.equal(fresh.note, probeOverrideNote("A", "D"));
  const freshWeak = reparseKeyDecision({ storedOfficial: null, storedCorrect: null, probe: "A", type: MC }, weak("D"));
  assert.equal(freshWeak.official, "A");
  assert.equal(freshWeak.review.length, 1);
  // correct_answer (the graded key) is the stored key; a differing stored
  // official answer only flags the row.
  const offDiff = reparseKeyDecision({ storedOfficial: "B", storedCorrect: "A", probe: null, type: MC }, undefined);
  assert.equal(offDiff.seed, "A");
  assert.equal(offDiff.official, "B");
  assert.match(offDiff.review[0], /^Needs review: the stored key is A but the stored official answer says B/);
  assert.equal(fresh.storedKey, false);
  // A letter ✓ on an SPR row with a stored number key: ignored.
  const spr = reparseKeyDecision({ storedOfficial: "12", storedCorrect: "12", probe: null, type: SPR }, strong("B"));
  assert.deepEqual(spr.review, []);
  assert.equal(spr.seed, "12");
}

// ── Re-parse in place, after the solver: the stored key always goes back.
{
  // Solver disagrees (no official answer, no ✓ conflict) → stored key kept, Needs Review.
  assert.deepEqual(storedKeyAfterSolve("B", "C"), { correct: "B", review: solverConflictNote("C", "B") });
  assert.equal(solverConflictNote("C", "B"), "Needs review: solver says C, stored key B — confirm which is right");
  // Agrees (case / spacing aside), or no solver answer → kept, no review.
  assert.deepEqual(storedKeyAfterSolve("B", "b"), { correct: "B", review: null });
  assert.deepEqual(storedKeyAfterSolve("3/4", " 3 / 4 "), { correct: "3/4", review: null });
  assert.deepEqual(storedKeyAfterSolve("12", null), { correct: "12", review: null });
  // A multi-answer stored key: the solver matching one accepted answer agrees.
  assert.deepEqual(storedKeyAfterSolve("5 or -13", "-13"), { correct: "5 or -13", review: null });
  assert.equal(storedKeyAfterSolve("A, C", "B").review, solverConflictNote("B", "A, C"));
  // …and so does an official answer that is one of them ([Test #2] Math M1 Q21 shape).
  assert.deepEqual(reparseKeyDecision({ storedOfficial: "5", storedCorrect: "5 or -13", probe: null, type: "Student Produced Response" }, undefined).review, []);
  assert.deepEqual(reparseKeyDecision({ storedOfficial: null, storedCorrect: "A or C", probe: null, type: MC }, strong("C")).review, []);
  // A row without a stored key is not a stored-key row: today's solver flow.
  const none = reparseKeyDecision({ storedOfficial: null, storedCorrect: null, probe: null, type: MC }, undefined);
  assert.deepEqual(none, { official: null, seed: null, review: [], note: null, storedKey: false });
}

// ── Multi-answer keys use the grader's split (lib/answer-key keyCandidates):
// "1,000" is one number, ", " and " or " separate answers.
assert.notEqual(storedKeyAfterSolve("1,000", "1").review, null, '"1,000" is not "1" or "000"');
assert.notEqual(storedKeyAfterSolve("1,000", "000").review, null);
assert.equal(storedKeyAfterSolve("5, -13", "-13").review, null);
assert.equal(storedKeyAfterSolve("5 or -13", "5").review, null);

// ── A weak ✓ that fills a missing answer leaves a note (a strong one doesn't).
{
  const m = mergeTicksIntoKey({}, ev({ 1: weak("C", "the parsed choices don't match the PDF's"), 2: strong("D") }), "probe", allMc(1, 2));
  assert.deepEqual(m.key, { 1: "C", 2: "D" });
  assert.equal(m.notes.get(1), weakFillNote("C", "the parsed choices don't match the PDF's"));
  assert.equal(m.notes.has(2), false);
  assert.equal(m.conflicts.size, 0);
}

// ── Re-parse in place, end to end: the cron's write order for stored-key
// rows — key decision → row written with the seed → solver overwrites
// correct_answer → stored key put back (storedKeyAfterSolve) → explain-official
// and the truncation guard (mocked: they write correct_answer =
// official_answer || correct_answer, as lib/ai/solve-question.ts does) →
// final restore (finalStoredKeyRestore) before rescore / auto-promote.
{
  const arguesOther = (type: string) => (ex: string | null, key: string) => explanationArguesOther(ex, key, type, "Which choice completes the text?");
  type Row = { correct_answer: string | null; official_answer: string | null; explanation: string | null; parsing_status: string; parsing_notes: string | null };
  const runCron = (stored: { official: string | null; correct: string | null }, type: string, solver: string, explainOfficial: string) => {
    const d = reparseKeyDecision({ storedOfficial: stored.official, storedCorrect: stored.correct, probe: null, type }, undefined);
    const row: Row = { correct_answer: d.seed, official_answer: d.official, explanation: null, parsing_status: d.review.length ? "Needs Review" : "Draft", parsing_notes: ["Re-parsed in place", ...d.review].join("; ") };
    row.correct_answer = solver; // solver
    row.explanation = `The answer is ${solver}.`;
    const after = storedKeyAfterSolve(d.seed!, solver);
    row.correct_answer = after.correct;
    if (after.review) { row.parsing_status = "Needs Review"; row.explanation = null; row.parsing_notes += `; ${after.review}`; }
    // explain-official (approves when nothing blocks) + truncation guard.
    for (let pass = 0; pass < 2; pass++) {
      row.correct_answer = row.official_answer || row.correct_answer;
      if (row.official_answer) {
        row.explanation = explainOfficial;
        if (!/needs review:/i.test(row.parsing_notes ?? "")) row.parsing_status = "Approved";
      }
    }
    const fin = finalStoredKeyRestore(row, d.seed!, arguesOther(type));
    if (fin.update) Object.assign(row, fin.update);
    return { row, d, fin };
  };

  // A reviewer's fix A vs a shifted official B → A survives; the explanation
  // written for B is cleared; Needs Review; never Draft (no auto-promote).
  {
    const { row, d, fin } = runCron({ official: "B", correct: "A" }, MC, "A", "The answer is B.");
    assert.equal(d.storedKey, true);
    assert.equal(row.correct_answer, "A");
    assert.equal(row.explanation, null);
    assert.equal(row.parsing_status, "Needs Review");
    assert.match(fin.review!, /^Needs review: the explanation argued another answer than the stored key A/);
    assert.equal(fin.review, restoredExplanationNote("A", explanationArguesOther("The answer is B.", "A", MC, null)!));
    assert.match(row.parsing_notes!, /stored official answer says B/);
  }
  // Multi-answer key narrowed to "5" by explain-official → "5 or -13" survives;
  // the explanation for 5 is consistent, so it stays.
  {
    const { row, fin } = runCron({ official: "5", correct: "5 or -13" }, SPR, "5", "Final answer: 5");
    assert.equal(row.correct_answer, "5 or -13");
    assert.equal(row.explanation, "Final answer: 5");
    assert.equal(fin.review, null, "consistent explanation on an approved row: no review");
    assert.notEqual(row.parsing_status, "Draft");
  }
  // Stored key only in correct_answer, solver disagrees → kept, review, explanation cleared.
  {
    const { row } = runCron({ official: null, correct: "C" }, MC, "D", "unused");
    assert.equal(row.correct_answer, "C");
    assert.equal(row.parsing_status, "Needs Review");
    assert.match(row.parsing_notes!, /solver says D, stored key C/);
    assert.equal(row.explanation, null);
  }
  // A Draft row whose key a later pass changed never stays Draft.
  {
    const fin = finalStoredKeyRestore({ correct_answer: "B", explanation: null, parsing_status: "Draft", parsing_notes: null }, "A", () => null);
    assert.deepEqual(fin.update, { correct_answer: "A", parsing_status: "Needs Review", parsing_notes: restoredKeyNote("A", "B") });
  }
  // Already right → nothing written.
  assert.deepEqual(finalStoredKeyRestore({ correct_answer: "A", explanation: "x", parsing_status: "Draft", parsing_notes: null }, "A", () => "no"), { update: null, review: null });
}

// ── deterministicTicks
const LABELS: ChoiceLabel[] = ["A", "B", "C", "D"];
// Distinct words per question and label, so another question's choices never "agree".
const choiceText = (n: number, l: string) =>
  Array.from({ length: 14 }, (_, i) => String.fromCharCode(97 + ((n * 7 + l.charCodeAt(0) * 13 + i * (n + 3)) % 26))).join("");
const parsedChoices = (n: number) => LABELS.map((label) => ({ label, text: choiceText(n, label) }));
const tq = (printed: number, checked: ChoiceLabel | null, opts: { multi?: boolean; textOf?: number } = {}): PdfTextQuestion => ({
  number: printed,
  checked,
  multi: opts.multi ?? false,
  stemPage: 1,
  choicesPage: 1,
  choices: LABELS.map((label) => ({ label, text: choiceText(opts.textOf ?? printed, label) })),
});
const pdfText = (qs: PdfTextQuestion[]) => ({ byNumber: new Map(qs.map((q) => [q.number, q])), questionsSeen: qs.length, hasTextLayer: true });
const lt = (printed: number, checked: ChoiceLabel | null, multi = false): LabelTick => ({ number: printed, checked, multi, stemPage: 1, choicesPage: 1 });
const labelSet = (ts: LabelTick[]) => ({ byNumber: new Map(ts.map((t) => [t.number, t])) });
const nums = (k: number, from = 1) => Array.from({ length: k }, (_, i) => i + from);
// Stored questions 1..k; choices text keyed by `printed` = n + offset.
const qs = (k: number, offset = 0, type: string | null = MC) =>
  nums(k).map((n) => ({ n, question_type: type, choices: parsedChoices(n + offset) }));
const letter = (n: number) => LABELS[n % 4];

{
  // English printout: the main reader binds and ticks everything → all strong.
  const r = deterministicTicks(qs(10), pdfText(nums(10).map((n) => tq(n, letter(n)))), null, 0);
  assert.equal(r.ticks.size, 10);
  assert.equal(r.ticks.get(3)?.tick, "D");
  assert.ok([...r.ticks.values()].every((t) => t.strong && t.source === "text-choices"));
  assert.deepEqual(r.notes, []);
}
{
  // Math printout: main reader binds 1 of 10 (unreliable) → label-only ticks, strong.
  const label = labelSet(nums(8).map((n) => lt(n, letter(n))));
  const r = deterministicTicks(qs(10), pdfText([tq(1, "B")]), label, 0);
  assert.equal(r.ticks.size, 8);
  assert.equal(r.ticks.get(2)?.tick, "C");
  assert.equal(r.ticks.get(2)?.source, "label-only");
  assert.equal(r.ticks.get(2)?.strong, true);
}
{
  // Main reader wins where both have a ✓; label fills only the gaps.
  const main = pdfText(nums(10).map((n) => tq(n, n === 5 ? null : "A")));
  const r = deterministicTicks(qs(10), main, labelSet(nums(10).map((n) => lt(n, "B"))), 0);
  assert.equal(r.ticks.get(1)?.tick, "A");
  assert.equal(r.ticks.get(5)?.tick, "B");
  assert.equal(r.ticks.get(5)?.source, "label-only");
}

// Offsets — the caller's offset is used as given, never guessed.
{
  // Q1–Q3 missed by the reader (printed = stored, offset 0): Q4..Q10 stay Q4..Q10.
  const main = pdfText(nums(7, 4).map((n) => tq(n, letter(n))));
  const r = deterministicTicks(qs(10), main, null, 0);
  assert.equal(r.ticks.size, 7);
  assert.equal(r.ticks.has(1), false);
  assert.equal(r.ticks.get(4)?.tick, letter(4), "Q4 keeps Q4's tick (no guessed shift of 3)");
  assert.equal(r.ticks.get(10)?.tick, letter(10));
  assert.deepEqual(r.notes, []);
}
{
  // Booklet numbering: printed 137–146 = stored 1–10 (offset 136).
  const main = pdfText(nums(10, 137).map((n) => tq(n, letter(n))));
  const r = deterministicTicks(qs(10, 136), main, null, 136);
  assert.equal(r.ticks.size, 10);
  assert.equal(r.ticks.get(1)?.tick, letter(137));
  assert.equal(r.ticks.get(1)?.strong, true, "choices compared at the same offset");
}
{
  // Readers disagree with the offset → that reader's ticks are dropped, with a note.
  const booklet = pdfText(nums(10, 137).map((n) => tq(n, letter(n))));
  const r1 = deterministicTicks(qs(10), booklet, null, 0);
  assert.equal(r1.ticks.size, 0);
  assert.match(r1.notes[0], /PDF text ✓ not used: it read questions 137–146 but this module's are 1–10/);
  const plain = labelSet(nums(10).map((n) => lt(n, letter(n))));
  const r2 = deterministicTicks(qs(10, 136), null, plain, 136);
  assert.equal(r2.ticks.size, 0);
  assert.match(r2.notes[0], /label-only ✓ not used/);
}

// Evidence per question.
{
  // Choice text bound but nothing comparable (math symbols) → unverified, weak.
  const sym = (n: number) => LABELS.map((label) => ({ label, text: `${n} + ${LABELS.indexOf(label)}` }));
  const main0 = pdfText(nums(10).map((n) => ({ ...tq(n, letter(n)), choices: sym(n) })));
  const r0 = deterministicTicks(nums(10).map((n) => ({ n, question_type: MC, choices: sym(n) })), main0, null, 0);
  assert.equal(r0.ticks.get(3)?.strong, false);
  assert.equal(r0.ticks.get(3)?.why, "the PDF's choice text can't be compared with the parsed choices");
}
{
  // Choice misalignment: the text reader bound Q4's choices under Q5 → Q5's ✓ is weak.
  const main = pdfText(nums(10).map((n) => tq(n, letter(n), n === 5 ? { textOf: 4 } : {})));
  const r = deterministicTicks(qs(10), main, null, 0);
  assert.equal(r.ticks.get(5)?.strong, false);
  assert.equal(r.ticks.get(5)?.why, "the parsed choices don't match the PDF's");
  assert.equal(r.ticks.get(4)?.strong, true);
  // …so a disagreeing probe goes to review instead of being replaced.
  const m = mergeTicksIntoKey({ 5: "A" }, r.ticks, "probe", allMc(...nums(10)));
  assert.equal(m.key[5], "A");
  assert.match(m.conflicts.get(5)!, /^Needs review: probe said A, PDF ticks B/);
}
{
  // A ✓ on a question parsed as fill-in is weak, and the merge ignores a letter there.
  const types = qs(10).map((q) => (q.n === 2 ? { ...q, question_type: SPR } : q));
  const r = deterministicTicks(types, pdfText(nums(10).map((n) => tq(n, letter(n)))), null, 0);
  assert.equal(r.ticks.get(2)?.strong, false);
  const m = mergeTicksIntoKey({ 2: "7" }, r.ticks, "probe", new Map(types.map((q) => [q.n, q.question_type])));
  assert.equal(m.key[2], "7");
  assert.equal(m.conflicts.size + m.notes.size, 0);
}
{
  // Two ✓ on one question in the main reader → no tick at all (label can't stand in).
  const main = pdfText(nums(10).map((n) => (n === 4 ? tq(n, null, { multi: true }) : tq(n, "D"))));
  const r = deterministicTicks(qs(10), main, labelSet(nums(10).map((n) => lt(n, "D"))), 0);
  assert.equal(r.ticks.has(4), false);
  assert.equal(r.ticks.size, 9);
  // Label reader: two ✓ → checked null → no tick.
  const r2 = deterministicTicks(qs(10), null, labelSet(nums(10).map((n) => (n === 4 ? lt(n, null, true) : lt(n, "D")))), 0);
  assert.equal(r2.ticks.has(4), false);
}

// Gates exactly at the thresholds (10 questions).
{
  // 60%: main reader must bind ≥ 6 of 10.
  assert.equal(deterministicTicks(qs(10), pdfText(nums(6).map((n) => tq(n, "A"))), null, 0).ticks.size, 6);
  assert.equal(deterministicTicks(qs(10), pdfText(nums(5).map((n) => tq(n, "A"))), null, 0).ticks.size, 0);
  // 50%: ≥ 5 of the 10 bound must be ticked.
  const marked = (k: number) => pdfText(nums(10).map((n) => tq(n, n <= k ? "A" : null)));
  assert.equal(deterministicTicks(qs(10), marked(5), null, 0).ticks.size, 5);
  assert.equal(deterministicTicks(qs(10), marked(4), null, 0).ticks.size, 0);
  // 40%: label reader must bind ≥ 4 of 10 …
  assert.equal(deterministicTicks(qs(10), null, labelSet(nums(4).map((n) => lt(n, "C"))), 0).ticks.size, 4);
  assert.equal(deterministicTicks(qs(10), null, labelSet(nums(3).map((n) => lt(n, "C"))), 0).ticks.size, 0);
  // … and ≥ 50% of those ticked.
  const lmarked = (k: number) => labelSet(nums(10).map((n) => lt(n, n <= k ? "C" : null)));
  assert.equal(deterministicTicks(qs(10), null, lmarked(5), 0).ticks.size, 5);
  assert.equal(deterministicTicks(qs(10), null, lmarked(4), 0).ticks.size, 0);
}

// ── The readers' walks on synthetic text-layer lines.
const line = (text: string, checked = false, x = 50): PdfLine => ({ page: 1, text, checked, x });
{
  // Main reader: one ✓ → that label; two ✓ → none (multi).
  const lines = [
    line("1. First stem"), line("A) alpha"), line("B) beta", true), line("C) gamma"), line("D) delta"),
    line("2. Second stem"), line("A) one", true), line("B) two"), line("C) three", true), line("D) four"),
  ];
  const r = bindChoiceLines(lines);
  assert.equal(r.byNumber.get(1)?.checked, "B");
  assert.equal(r.byNumber.get(1)?.multi, false);
  assert.equal(r.byNumber.get(2)?.checked, null);
  assert.equal(r.byNumber.get(2)?.multi, true);
  // A ✓ alone on the row after D belongs to D.
  const r2 = bindChoiceLines([line("1. Stem"), line("A) a"), line("B) b"), line("C) c"), line("D) d"), line("", true)]);
  assert.equal(r2.byNumber.get(1)?.checked, "D");
}
{
  // Label-only reader (image choices): bare number boxes at one x, labels, ✓.
  const lines = [
    line("1", false, 30), line("A"), line("B"), line("C", true), line("D"),
    line("2", false, 30), line("11", false, 200), line("A"), line("B", true), line("C"), line("D", true),
    line("3", false, 30), line("A"), line("B"), line("C"), line("D"), line("", true),
  ];
  const r = bindLabelTickLines(lines);
  assert.equal(r.byNumber.get(1)?.checked, "C");
  assert.equal(r.byNumber.get(2)?.checked, null, "two ✓ → none");
  assert.equal(r.byNumber.get(2)?.multi, true);
  assert.equal(r.byNumber.get(3)?.checked, "D", "✓ on its own row → last label");
  assert.equal(r.byNumber.has(11), false, "a table cell off the box column doesn't open a question");
  // A table cell "2" while Q1 has no labels yet, at another x, doesn't open Q2.
  const r2 = bindLabelTickLines([line("1", false, 30), line("2", false, 120), line("A"), line("B", true), line("C"), line("D"), line("2", false, 30), line("A", true), line("B"), line("C"), line("D")]);
  assert.equal(r2.byNumber.get(1)?.checked, "B");
  assert.equal(r2.byNumber.get(2)?.checked, "A");
}

console.log("answer-key-merge: ok");
