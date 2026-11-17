// node --experimental-strip-types .omc/qa/unit/custom-test-score.test.ts
// Custom test results (plan custom-test.md D4, "Results"): no bogus "N
// questions in review, not scored" notes (FULL_MODULE assumes 27/22), the
// SAT score labelled "Estimated", none for a part under 10 questions, the
// R&W + Math total; uploaded tests score exactly as before. Plus the
// publish readiness of a Custom test (referenced questions still eligible)
// and the no-break full-length path.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import "./_resolve.ts";
if (!existsSync(new URL("../../../lib/custom-test/stage.ts", import.meta.url))) {
  console.log("custom-test-score: skipped (lib/custom-test not on this branch)");
  process.exit(0);
}
const { scoreDisplay, attemptScore, isCustomRows, CUSTOM_MIN_SCALED_QUESTIONS } = await import("../../../lib/score-display.ts");
const { fullLengthAttemptScore } = await import("../../../lib/full-length-score.ts");
const { newStageModuleId, buildQuestionIds } = await import("../../../lib/custom-test/stage.ts");
const { publishBlockers, customStageApprovals, moduleApprovals } = await import("../../../lib/test-readiness.ts");
const { flState, skipsBreak, breakEndsAtMs, flStateLabel } = await import("../../../lib/full-length-attempt.ts");
type FlAttempt = import("../../../lib/full-length-attempt.ts").FlAttempt;
type FlRow = import("../../../lib/full-length-attempt.ts").FlRow;

// ---- score display
const mods = (a: [number, number], b?: [number, number]) => [
  { number: 1, graded: true, correct: a[0], total: a[1] },
  ...(b ? [{ number: 2, graded: true, correct: b[0], total: b[1] }] : []),
];
// Uploaded test: unchanged (notes for a short module, no "estimated").
const up = scoreDisplay(mods([20, 27], [20, 25]), "Reading & Writing")!;
assert.deepEqual(up.notes, ["M2: 2 questions in review, not scored"]);
assert.equal(up.estimated, undefined);
assert.equal(up.sat, scoreDisplay(mods([20, 27], [20, 25]), "Reading & Writing", {})!.sat);
// Custom: no notes, estimated, same curve.
const c = scoreDisplay(mods([8, 10], [7, 10]), "Math", { custom: true })!;
assert.deepEqual(c.notes, []);
assert.equal(c.estimated, true);
assert.equal(c.sat, scoreDisplay(mods([8, 10], [7, 10]), null)!.sat, "the existing 200–800 curve");
assert.equal(c.pct, 75);
// Under 10 questions: counts and %, no SAT estimate.
assert.equal(CUSTOM_MIN_SCALED_QUESTIONS, 10);
const tiny = scoreDisplay(mods([5, 6]), "Math", { custom: true })!;
assert.equal(tiny.sat, null);
assert.equal(tiny.pct, 83.3);
assert.equal(tiny.modules, "5/6");
assert.equal(scoreDisplay(mods([5, 9]), "Math", { custom: true })!.sat, null);
assert.notEqual(scoreDisplay(mods([5, 10]), "Math", { custom: true })!.sat, null);
// Unfinished: no SAT either way.
assert.equal(scoreDisplay([{ number: 1, graded: true, correct: 9, total: 12 }, { number: 2, graded: false, correct: null, total: null }], "Math", { custom: true })!.sat, null);

// attemptScore recognises a Custom test from the rows' module.
const stage = newStageModuleId();
const rows = (moduleId: string | null, total: number) => [
  { student_id: "s", status: "Submitted", session_id: "x", adaptive_track: "module_1", started_at: "2026-11-17T10:00:00Z", correct_count: 4, total_questions: total, module_id: moduleId },
];
assert.equal(isCustomRows(rows(stage, 6)), true);
assert.equal(isCustomRows(rows("0be2ea31-7054-4517-8d80-a66060a8557d", 6)), false);
assert.equal(isCustomRows([{ student_id: "s", status: "x" }]), false, "rows without module_id: as before");
assert.equal(attemptScore(rows(stage, 6), "Math").score!.sat, null);
assert.equal(attemptScore(rows(stage, 12), "Math").score!.estimated, true);
assert.deepEqual(attemptScore(rows("upload", 20), "Math").score!.notes, ["M1: 2 questions in review, not scored"], "uploaded: as before");

// Full-length (R&W + Math) Custom total.
const fl = (moduleId: string, track: string, correct: number, total: number, test: string) => ({
  test_id: test, student_id: "s", status: "Submitted", session_id: `${test}-sess`, adaptive_track: track,
  started_at: "2026-11-17T10:00:00Z", correct_count: correct, total_questions: total, module_id: moduleId,
});
const rw = [fl(stage, "module_1", 10, 14, "rw"), fl(stage, "module_2_hard", 9, 13, "rw")];
const math = [fl(stage, "module_1", 9, 11, "m"), fl(stage, "module_2", 8, 11, "m")];
const total = fullLengthAttemptScore(rw, math);
assert.equal(total.score!.estimated, true);
assert.deepEqual(total.score!.notes, []);
assert.equal(total.total, total.rw.score!.sat! + total.math.score!.sat!);
// A short section: no section SAT, no total, but the % still shows.
const short = fullLengthAttemptScore([fl(stage, "module_1", 3, 4, "rw"), fl(stage, "module_2", 3, 4, "rw")], math);
assert.equal(short.rw.score!.sat, null);
assert.equal(short.total, null);
assert.notEqual(short.score!.pct, null);
// Uploaded full-length: unchanged (no estimated flag).
const upFl = fullLengthAttemptScore([fl("u1", "module_1", 20, 27, "rw"), fl("u2", "module_2", 20, 27, "rw")], [fl("u3", "module_1", 20, 22, "m"), fl("u4", "module_2", 20, 22, "m")]);
assert.equal(upFl.score!.estimated, undefined);

// ---- readiness: a Custom module's referenced questions must still be eligible
{
  const m1 = newStageModuleId();
  const m2 = newStageModuleId();
  const qids = buildQuestionIds([{ moduleId: m1, questionIds: ["a", "b"] }, { moduleId: m2, questionIds: ["c"] }]);
  const q = (id: string, over: Record<string, unknown> = {}) => ({
    id, module_id: "SRC", section: "Math", domain: "Algebra", skill: "Linear functions", difficulty: "Easy", parsing_status: "Approved",
    parsing_notes: null, correct_answer: "A", question_text: "?", choices: [], has_image: false, has_table: false, image_urls: [], ...over,
  });
  const questions = [q("a"), q("b", { parsing_status: "Needs Review" }), q("c", { parsing_notes: "[live-fix] re-check" })];
  // Minimal stub: tests by jsonb containment, questions by id.
  const db = {
    from(table: string) {
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      const chain = {
        select() { return chain; },
        filter(col: string, op: string, v: string) {
          assert.equal(op, "cs");
          const want = JSON.parse(v) as string[];
          filters.push((r) => want.every((x) => ((r[col] as string[]) ?? []).includes(x)));
          return chain;
        },
        in(col: string, vs: string[]) { filters.push((r) => vs.includes(r[col] as string)); return chain; },
        limit() { return chain; },
        then(ok: (v: unknown) => unknown) {
          const rows = table === "tests" ? [{ id: "t", question_ids: qids }] : table === "questions" ? questions : [];
          return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r as Record<string, unknown>))), error: null }).then(ok);
        },
      };
      return chain;
    },
  };
  const a = await customStageApprovals(db as never, [{ id: m1, label: "Module 1" }, { id: m2, label: "Module 2 (harder)" }]);
  assert.deepEqual(a.map((x) => [x.approved, x.pending, x.custom]), [[1, 1, true], [0, 1, true]]);
  const blockers = publishBlockers({ isFlSection: false, shapeError: null, modules: a });
  assert.deepEqual(blockers.map((b) => b.message), [
    "1 question no longer eligible (Module 1) — replace it on the test page",
    "1 question no longer eligible (Module 2 (harder)) — replace it on the test page",
  ]);
  assert.ok(blockers.every((b) => !b.href), "no link to a placeholder module page");
  // moduleApprovals routes stage ids to the Custom check (and keeps the order).
  const mixed = await moduleApprovals(db as never, [{ id: m2, label: "M2" }]);
  assert.equal(mixed[0].custom, true);
  // All eligible → publishable.
  questions[1] = q("b");
  questions[2] = q("c");
  const ok = await customStageApprovals(db as never, [{ id: m1, label: "Module 1" }, { id: m2, label: "Module 2" }]);
  assert.deepEqual(publishBlockers({ isFlSection: false, shapeError: null, modules: ok }), []);
}

// ---- R&W + Math with no break: straight into Math
{
  const T0 = Date.parse("2026-11-17T14:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const attempt = (over: Partial<FlAttempt> = {}): FlAttempt => ({
    id: "a", test_id: "p", student_id: "s", attempt_number: 1, rw_session_id: "rw", math_session_id: null, time_multiplier: 1,
    break_minutes: 0, allow_section_pause: false, started_at: iso(T0), closed_at: null, closed_reason: null, ...over,
  });
  const row = (test: string, track: string, at: number): FlRow => ({
    id: `${test}-${track}`, test_id: test, status: "Submitted", adaptive_track: track, attempt_number: 1, session_id: `${test}-s`,
    started_at: iso(at), submitted_at: iso(at + 1000), metadata: {},
  });
  const rwDone = [row("rw", "module_1", T0), row("rw", "module_2", T0 + 60_000)];
  const st = flState(attempt(), rwDone, { rw: "rw", math: "math" }, { due_date: null }, T0 + 61_500);
  assert.equal(st.state, "break", "R&W finished, Math not created yet");
  assert.equal(st.breakRemainingSeconds, 0, "a 0-minute break is already over");
  assert.equal(breakEndsAtMs(attempt(), rwDone[1]), T0 + 61_000);
  assert.equal(skipsBreak(attempt()), true, "the SAT runner starts Math at once (no break screen)");
  assert.equal(flStateLabel(st), "Break over · Math not started yet");
  // Existing full-length tests keep their break; pausing keeps the screen.
  assert.equal(skipsBreak(attempt({ break_minutes: 10 })), false);
  assert.equal(skipsBreak(attempt({ break_minutes: 1 })), false);
  assert.equal(skipsBreak(attempt({ break_minutes: 0, allow_section_pause: true })), false);
  assert.equal(skipsBreak(attempt({ break_minutes: null })), false, "missing snapshot = the 10-minute default");
  const ten = flState(attempt({ break_minutes: 10 }), rwDone, { rw: "rw", math: "math" }, { due_date: null }, T0 + 61_500);
  assert.equal(ten.breakRemainingSeconds, 600, "10-minute break unchanged");
}

console.log("custom-test-score: all assertions passed");
