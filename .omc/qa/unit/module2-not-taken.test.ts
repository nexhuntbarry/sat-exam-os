// node --experimental-strip-types .omc/qa/unit/module2-not-taken.test.ts
// "Incomplete · Module 2 not taken" (ticket 969e0414): one predicate
// (lib/module2-not-taken) drives every view. A Module 2 closed without
// being opened is not a 0: the attempt is Incomplete, keeps Module 1's
// counts, has no SAT score and stays out of averages; full-length and the
// class gradebook follow.
import assert from "node:assert/strict";
import "./_resolve.ts";
const { isModule2NotTaken, attemptHasModule2NotTaken, M2_NOT_TAKEN_COLUMN, NOT_M2_NOT_TAKEN_OR } = await import(
  "../../../lib/module2-not-taken.ts"
);
const { studentTestProgress, summarizeTestProgress } = await import("../../../lib/test-progress.ts");
const { attemptScore, scoreDisplay, averageSat } = await import("../../../lib/score-display.ts");
const { fullLengthAttemptScore, flBadge, flModuleCells } = await import("../../../lib/full-length-score.ts");
const { sectionCell, INCOMPLETE_LABEL } = await import("../../../lib/class-gradebook-shape.ts");
const { cellHint } = await import("../../../lib/class-gradebook-view.ts");

// ── the predicate ─────────────────────────────────────────────────────────
const m2Closed = { adaptive_track: "module_2_hard", status: "Submitted", metadata: { auto_closed_unopened: true } };
assert.equal(isModule2NotTaken(m2Closed), true);
assert.equal(isModule2NotTaken({ ...m2Closed, status: "Late" }), true);
// The select alias (M2_NOT_TAKEN_COLUMN) instead of full metadata.
assert.equal(isModule2NotTaken({ adaptive_track: "module_2", status: "Submitted", m2_not_taken: true }), true);
assert.equal(M2_NOT_TAKEN_COLUMN, "m2_not_taken:metadata->auto_closed_unopened");
// Not flagged / not a Module 2 / not graded (a reopened row is In Progress) → false.
assert.equal(isModule2NotTaken({ adaptive_track: "module_2", status: "Submitted", metadata: {} }), false);
assert.equal(isModule2NotTaken({ adaptive_track: "module_2", status: "Submitted", m2_not_taken: null }), false);
assert.equal(isModule2NotTaken({ adaptive_track: "module_2", status: "Submitted", metadata: { auto_closed_unopened: "true" } }), false);
assert.equal(isModule2NotTaken({ ...m2Closed, adaptive_track: "module_1" }), false);
assert.equal(isModule2NotTaken({ ...m2Closed, adaptive_track: null }), false);
assert.equal(isModule2NotTaken({ ...m2Closed, status: "In Progress" }), false);
assert.equal(isModule2NotTaken(null), false);
assert.equal(attemptHasModule2NotTaken([{ adaptive_track: "module_1", status: "Submitted" }, m2Closed]), true);
assert.equal(attemptHasModule2NotTaken([{ adaptive_track: "module_1", status: "Submitted" }]), false);
assert.match(NOT_M2_NOT_TAKEN_OR, /auto_closed_unopened\.is\.null/);

// ── a section attempt: Joshua's case (M1 21/22, M2 closed unopened as 0/22) ─
const rows = [
  { id: "m1", student_id: "s1", status: "Submitted", session_id: "x", adaptive_track: "module_1", started_at: "2026-11-07T15:00:00Z", correct_count: 21, total_questions: 22 },
  { id: "m2", student_id: "s1", status: "Submitted", session_id: "x", adaptive_track: "module_2_hard", started_at: "2026-11-07T15:31:00Z", correct_count: 0, total_questions: 22, m2_not_taken: true },
];
const p = studentTestProgress(rows, true);
assert.equal(p.status, "Incomplete");
assert.equal(p.score, null);
assert.equal(p.detailSubmissionId, "m1", "the Module 1 result is the detail");
assert.equal(p.currentModule, null);
assert.deepEqual(p.modules, [
  { number: 1, graded: true, correct: 21, total: 22 },
  { number: 2, graded: false, correct: null, total: null, notTaken: true },
]);
const a = attemptScore(rows, "Math");
assert.equal(a.status, "Incomplete");
assert.equal(a.score?.sat, null, "no total SAT score");
assert.equal(a.score?.pct, null);
assert.equal(a.score?.modules, "M1 21/22", "Module 1 stays visible; no 'M2 0/22'");
// Late Module 1 doesn't turn it into Late.
assert.equal(attemptScore([{ ...rows[0], status: "Late" }, rows[1]], "Math").status, "Incomplete");
// Same rows WITHOUT the flag: an ordinary finished 21/44.
const plain = attemptScore(rows.map((r) => ({ ...r, m2_not_taken: undefined })), "Math");
assert.equal(plain.status, "Submitted");
assert.equal(plain.score?.modules, "M1 21/22 · M2 0/22");
assert.ok(plain.score?.sat != null);

// Averages: the Incomplete attempt is not "finished" and adds no score.
const other = [
  { id: "o1", student_id: "s2", status: "Submitted", session_id: "y", adaptive_track: "module_1", started_at: "2026-11-07T15:00:00Z", correct_count: 11, total_questions: 22 },
  { id: "o2", student_id: "s2", status: "Submitted", session_id: "y", adaptive_track: "module_2_easy", started_at: "2026-11-07T15:40:00Z", correct_count: 11, total_questions: 22 },
];
const sum = summarizeTestProgress([...rows, ...other], ["s1", "s2"], true);
assert.equal(sum.students, 2);
assert.equal(sum.finished, 1);
assert.equal(sum.avgScore, 50);
assert.equal(averageSat([attemptScore(rows, "Math").score?.sat, attemptScore(other, "Math").score?.sat]), attemptScore(other, "Math").score?.sat);

// scoreDisplay drops a not-taken module from the counts line.
assert.equal(
  scoreDisplay([{ number: 1, graded: true, correct: 20, total: 27 }, { number: 2, graded: false, correct: null, total: null, notTaken: true }], "Reading & Writing")?.modules,
  "M1 20/27",
);

// A retake after an Incomplete attempt: the latest attempt rules.
const retake = [
  ...rows,
  { id: "r1", student_id: "s1", status: "In Progress", session_id: "z", adaptive_track: "module_1", started_at: "2026-11-09T15:00:00Z", correct_count: 0, total_questions: 0 },
];
assert.equal(studentTestProgress(retake, true).status, "In progress");

// ── full-length: a section with Module 2 not taken ────────────────────────
const rw = [
  { id: "rw1", test_id: "rw", student_id: "s1", status: "Submitted", session_id: "a", adaptive_track: "module_1", started_at: "2026-11-07T10:00:00Z", correct_count: 20, total_questions: 27 },
  { id: "rw2", test_id: "rw", student_id: "s1", status: "Submitted", session_id: "a", adaptive_track: "module_2_easy", started_at: "2026-11-07T10:40:00Z", correct_count: 0, total_questions: 27, m2_not_taken: true },
];
const fl = fullLengthAttemptScore(rw, []);
assert.equal(fl.status, "Incomplete");
assert.equal(fl.total, null);
assert.deepEqual(flBadge(fl), { status: "Incomplete", label: "Incomplete · R&W Module 2 not taken" });
assert.deepEqual(flModuleCells(fl.rw), ["20/27", "not taken"]);

// ── class gradebook cell ──────────────────────────────────────────────────
const cell = sectionCell("t1", "Math", rows as never, true);
assert.equal(cell.state, "closed");
assert.equal(cell.statusLabel, INCOMPLETE_LABEL);
assert.equal(cell.sat, null, "kept out of the column average");
assert.equal(cell.detail, "M1 21/22");
assert.equal(cell.href, "/teacher/tests/t1/results/m1");
assert.match(cellHint(cell), /closed before the student opened it/);
// An earlier finished attempt is shown, with the Incomplete retake as "closed".
const earlier = [
  { id: "e1", test_id: "t1", student_id: "s1", status: "Submitted", session_id: "e", adaptive_track: "module_1", started_at: "2026-11-01T15:00:00Z", submitted_at: "2026-11-01T15:30:00Z", correct_count: 15, total_questions: 22, attempt_number: 1 },
  { id: "e2", test_id: "t1", student_id: "s1", status: "Submitted", session_id: "e", adaptive_track: "module_2_easy", started_at: "2026-11-01T15:31:00Z", submitted_at: "2026-11-01T16:00:00Z", correct_count: 15, total_questions: 22, attempt_number: 1 },
  ...rows.map((r) => ({ ...r, test_id: "t1", attempt_number: 2, submitted_at: "2026-11-08T15:35:00Z" })),
];
const shown = sectionCell("t1", "Math", earlier as never, true);
assert.equal(shown.state, "scored");
assert.equal(shown.attemptNumber, 1);
assert.deepEqual(shown.retake, { state: "closed", attemptNumber: 2 });

console.log("module2-not-taken: all assertions passed");
