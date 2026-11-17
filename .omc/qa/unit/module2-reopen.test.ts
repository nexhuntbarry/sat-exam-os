// node --experimental-strip-types .omc/qa/unit/module2-reopen.test.ts
// Admin "Reopen Module 2…" (ticket 969e0414, lib/module2-reopen): the
// Module 2 row goes back to a fresh unopened handoff (same track, no
// answers, no module_2_started_at, score cleared, started_at = now for the
// cron's unopened rule); Module 1 is untouched. Refused for an ungraded
// Module 2 / Module 1, an older attempt, a full-length row. Plus the row
// menu facts (lib/attempt-actions) and when a reopened Module 2 closes again.
import assert from "node:assert/strict";
import "./_resolve.ts";
import { fakeDb } from "./_fake-db.ts";
const { reopenModule2, reopenModule2Metadata, reopenRowRefusal } = await import("../../../lib/module2-reopen.ts");
const { attemptFacts, latestAttemptOf, moduleSummary, reopenedModule2ClosesAt } = await import("../../../lib/attempt-actions.ts");
const { isModule2NotTaken } = await import("../../../lib/module2-not-taken.ts");
const { moduleStartedAtIso } = await import("../../../lib/student-exam.ts");

const NOW = new Date("2026-11-17T20:00:00.000Z");
const m1 = {
  id: "m1", test_id: "t1", student_id: "s1", status: "Submitted", session_id: "sess", adaptive_track: "module_1",
  module_id: "mod1", attempt_number: 1, started_at: "2026-11-07T15:00:00.000Z", submitted_at: "2026-11-07T15:30:00.000Z",
  answers: { q1: "A" }, correct_count: 21, total_questions: 22, percentage: 95.5, scaled_score: 760, metadata: { time_multiplier: 1.5 },
};
const m2 = {
  id: "m2", test_id: "t1", student_id: "s1", status: "Submitted", session_id: "sess", adaptive_track: "module_2_hard",
  module_id: "mod2h", attempt_number: 1, started_at: "2026-11-07T15:31:04.000Z", submitted_at: "2026-11-08T15:35:31.000Z",
  answers: {}, correct_count: 0, total_questions: 22, percentage: 0, scaled_score: 200, scaled_section: "Math", time_spent_seconds: 0,
  metadata: { auto_closed_unopened: true, time_multiplier: 1.5, device: { platform: "Mac" }, answers_version: 3, flagged: ["q9"], created_after_due: true },
};
function setup(extra: Record<string, unknown>[] = [], m2Patch: Record<string, unknown> = {}) {
  return fakeDb({
    submissions: [structuredClone(m1), { ...structuredClone(m2), ...m2Patch }, ...extra.map((r) => structuredClone(r))],
    answer_records: [
      { id: "ar1", submission_id: "m1", question_id: "q1", is_correct: true },
      { id: "ar2", submission_id: "m2", question_id: "q9", is_correct: false },
    ],
  });
}
const row = (db: { tables: Record<string, Record<string, unknown>[]> }, id: string) => db.tables.submissions.find((r) => r.id === id)!;

// ── happy path ────────────────────────────────────────────────────────────
{
  const { db, client } = setup();
  const before1 = structuredClone(row(db, "m1"));
  assert.equal(isModule2NotTaken(row(db, "m2")), true);
  const r = await reopenModule2(client, "m2", NOW);
  assert.deepEqual(r, { ok: true, submissionId: "m2", track: "module_2_hard" });
  const after = row(db, "m2");
  assert.equal(after.status, "In Progress");
  assert.deepEqual(after.answers, {});
  assert.equal(after.submitted_at, null);
  assert.equal(after.score, 0);
  assert.equal(after.correct_count, 0);
  assert.equal(after.percentage, 0);
  assert.equal(after.scaled_score, null);
  assert.equal(after.time_spent_seconds, 0);
  assert.equal(after.started_at, NOW.toISOString(), "new handoff time for the cron's unopened rule");
  // Same track and module (adaptive: hard stays hard).
  assert.equal(after.adaptive_track, "module_2_hard");
  assert.equal(after.module_id, "mod2h");
  assert.equal(after.session_id, "sess");
  // Fresh unopened handoff: no clock stamp, no not-taken flag; extended time and device kept.
  assert.equal(moduleStartedAtIso(after as never), null);
  assert.deepEqual(after.metadata, {
    time_multiplier: 1.5,
    device: { platform: "Mac" },
    answers_version: 4,
    module_2_reopened_at: NOW.toISOString(),
  });
  assert.equal(isModule2NotTaken(after), false);
  // Module 1 untouched, its records kept; Module 2's old records gone.
  assert.deepEqual(row(db, "m1"), before1);
  assert.deepEqual(db.tables.answer_records.map((a) => a.id), ["ar1"]);
  // A second reopen (double click) is refused: nothing graded to reopen.
  const again = await reopenModule2(client, "m2", NOW);
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.reason, "not_graded");
}

// A normally finished Module 2 (not "not taken") can be reopened too.
{
  const { db, client } = setup([], { answers: { q9: "B" }, correct_count: 18, metadata: { module_2_started_at: "2026-11-07T15:40:00.000Z", answers_version: 9 } });
  const r = await reopenModule2(client, "m2", NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(row(db, "m2").metadata, { answers_version: 10, module_2_reopened_at: NOW.toISOString() });
}

// ── refusals (nothing written) ───────────────────────────────────────────
async function refused(reason: string, id: string, extra: Record<string, unknown>[] = [], m2Patch: Record<string, unknown> = {}, m1Patch: Record<string, unknown> = {}) {
  const { db, client } = setup(extra, m2Patch);
  Object.assign(row(db, "m1"), m1Patch);
  const snapshot = structuredClone(db.tables);
  const r = await reopenModule2(client, id, NOW);
  assert.equal(r.ok, false, reason);
  assert.equal(!r.ok && r.reason, reason);
  assert.deepEqual(db.tables, snapshot, `${reason}: nothing written`);
}
await refused("not_found", "nope");
await refused("not_module_2", "m1");
await refused("not_graded", "m2", [], { status: "In Progress" });
await refused("full_length", "m2", [], { metadata: { fl_attempt_id: "att-1", auto_closed_unopened: true } });
await refused("module_1_not_graded", "m2", [], {}, { status: "In Progress" });
await refused("module_1_not_graded", "m2", [], { session_id: null });
await refused("newer_attempt", "m2", [
  { id: "n1", test_id: "t1", student_id: "s1", status: "In Progress", session_id: "sess2", adaptive_track: "module_1", attempt_number: 2, started_at: "2026-11-10T15:00:00.000Z", metadata: {} },
]);
// Another student's newer attempt doesn't block.
{
  const { client } = setup([
    { id: "x1", test_id: "t1", student_id: "s2", status: "Submitted", session_id: "o", adaptive_track: "module_1", attempt_number: 3, started_at: "2026-11-10T15:00:00.000Z", metadata: {} },
  ]);
  assert.equal((await reopenModule2(client, "m2", NOW)).ok, true);
}
assert.equal(reopenRowRefusal(null), "not_found");
assert.equal(reopenRowRefusal({ ...m2, status: "Late" } as never), null);

// reopenModule2Metadata: a section row without extras ends up minimal.
assert.deepEqual(reopenModule2Metadata(undefined, "T"), { answers_version: 1, module_2_reopened_at: "T" });

// ── row menu facts (lib/attempt-actions) ─────────────────────────────────
{
  const facts = attemptFacts([
    { ...m1, m2_not_taken: null },
    { ...m2, m2_not_taken: true },
  ]);
  assert.equal(facts?.state, "incomplete");
  assert.equal(facts?.twoModules, true);
  assert.deepEqual(facts?.rowIds, ["m1", "m2"]);
  const [f1, f2] = facts!.modules;
  assert.deepEqual([f1.number, f1.correct, f1.total, f1.notTaken], [1, 21, 22, false]);
  assert.deepEqual([f2.number, f2.correct, f2.total, f2.notTaken, f2.track], [2, null, null, true, "Hard"]);
  assert.deepEqual(moduleSummary(f1), { kind: "score", score: "21/22" });
  assert.deepEqual(moduleSummary(f2), { kind: "notTaken" });

  // In progress: Module 1 graded, Module 2 open but not started → "not opened".
  const open = attemptFacts([m1, { ...m2, status: "In Progress", metadata: {} }])!;
  assert.equal(open.state, "in_progress");
  assert.equal(open.modules[1].opened, false);
  assert.deepEqual(moduleSummary(open.modules[1]), { kind: "notOpened" });
  // Started (stamp via the select alias) with 3 answers saved.
  const started = attemptFacts([m1, { ...m2, status: "In Progress", metadata: {}, m2_started: "2026-11-07T16:00:00Z", answers: { a: "1", b: "2", c: "3" } }])!;
  assert.deepEqual(moduleSummary(started.modules[1]), { kind: "open", answered: 3 });
  // Module 1 graded, Module 2 not created yet: still in progress.
  assert.equal(attemptFacts([m1])!.state, "in_progress");
  // Finished normally.
  assert.equal(attemptFacts([m1, { ...m2, metadata: {} }])!.state, "finished");
  // Single-module test (no track).
  const single = attemptFacts([{ ...m1, adaptive_track: null, session_id: null }])!;
  assert.equal(single.state, "finished");
  assert.equal(single.twoModules, false);
  assert.equal(attemptFacts([]), null);

  // latestAttemptOf: the session of the most recently started row.
  const older = { ...m1, id: "o1", session_id: "old", started_at: "2026-10-01T10:00:00Z" };
  assert.deepEqual(latestAttemptOf([older, m1, m2]).map((r) => r.id), ["m1", "m2"]);
}

// ── when a reopened, unopened Module 2 is closed again (cron rule) ────────
{
  const now = NOW.getTime();
  assert.equal(reopenedModule2ClosesAt(null, now), null, "no due date: stays open");
  // Due date long gone: 24 h from the reopen.
  assert.equal(reopenedModule2ClosesAt("2026-11-01T00:00:00Z", now)?.toISOString(), "2026-11-18T20:00:00.000Z");
  // Due date a week away: at the due date.
  assert.equal(reopenedModule2ClosesAt("2026-11-24T20:00:00Z", now)?.toISOString(), "2026-11-24T20:00:00.000Z");
  // Due in 2 hours: still the full 24 h window.
  assert.equal(reopenedModule2ClosesAt("2026-11-17T22:00:00Z", now)?.toISOString(), "2026-11-18T20:00:00.000Z");
}

// ── the cron leaves a just-reopened Module 2 alone ───────────────────────
// Whichever unopened-Module-2 rule this branch has (24 h after the handoff,
// or ticket 969e0414 part 1: due date + 24 h window), a Module 2 reopened
// now — even long past its due date — is not closed on the next tick.
{
  const { finalizeStaleSubmission } = await import("../../../lib/finalize-stale.ts");
  const { db, client } = setup();
  await reopenModule2(client, "m2", new Date());
  const sub = row(db, "m2");
  for (const due of [null, "2026-11-01T00:00:00Z"]) {
    const test = {
      id: "t1", module_id: null, question_ids: null, due_date: due, time_limit_minutes: 35, time_limit_minutes_module_2: 35,
      is_untimed: false, is_adaptive: true, module_2_id: null, module_2_easy_id: "mod2e", module_2_hard_id: "mod2h", adaptive_threshold: 60,
    };
    const r = await finalizeStaleSubmission(client, sub as never, test);
    assert.equal(r.action, "skipped", `due ${due}`);
    assert.match(r.reason ?? "", /not opened/);
  }
  assert.equal(row(db, "m2").status, "In Progress");
}

console.log("module2-reopen: all assertions passed");
