// Answer-visibility decision tests.
//
//   npx tsx scripts/test-answer-visibility.ts            # pure matrix only
//   npx tsx scripts/test-answer-visibility.ts --db       # + DB loader on qa-test- data
//
// Part 1 exercises decideAnswerVisibility (the one function every
// student-facing answer surface goes through). Part 2 uses the QA harness
// service-role client to build a throwaway qa-test- test + submissions +
// retake grant and checks loadAnswerVisibilityInputs derives hasSubmitted /
// retakePending / overrides correctly. Override rows are only exercised
// when migration 0029 is applied; otherwise that step is reported SKIPPED.
// Everything created is deleted in finally.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decideAnswerVisibility,
  loadAnswerVisibilityInputs,
  summarizeAnswerVisibility,
  visibilityKey,
  type StudentOverride,
  type TestVisibilityFlags,
  type VisibilityInput,
} from "../lib/answer-visibility";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`);
}

const testFlags = (o: Partial<TestVisibilityFlags> = {}): TestVisibilityFlags => ({
  show_answers_after_submission: false,
  show_explanations_after_submission: true,
  review_unlocked: false,
  ...o,
});
const ov = (mode: StudentOverride["mode"], show_explanations = true): StudentOverride => ({
  mode,
  show_explanations,
  updated_by: null,
  updated_at: null,
});
const input = (o: Partial<VisibilityInput> = {}): VisibilityInput => ({
  test: testFlags(),
  override: null,
  hasSubmitted: true,
  retakePending: false,
  ...o,
});
const pick = (d: { answers: boolean; explanations: boolean; source: string }) => [d.answers, d.explanations, d.source];

// ---------------------------------------------------------------- Part 1
console.log("== Part 1: decision matrix (pure) ==");
check(
  "unsubmitted + student Show -> hidden",
  pick(decideAnswerVisibility(input({ hasSubmitted: false, override: ov("show"), test: testFlags({ show_answers_after_submission: true }) }), "results")),
  [false, false, "not_submitted"],
);
check(
  "unsubmitted + student Show + class review unlocked -> review hidden",
  pick(decideAnswerVisibility(input({ hasSubmitted: false, override: ov("show"), test: testFlags({ review_unlocked: true }) }), "class_review")),
  [false, false, "not_submitted"],
);
check(
  "test hidden + student Show -> visible",
  pick(decideAnswerVisibility(input({ override: ov("show") }), "results")),
  [true, true, "student"],
);
check(
  "test visible + student Hide -> hidden",
  pick(decideAnswerVisibility(input({ override: ov("hide"), test: testFlags({ show_answers_after_submission: true }) }), "results")),
  [false, false, "student"],
);
check(
  "class review unlocked + student Hide -> review hidden",
  pick(decideAnswerVisibility(input({ override: ov("hide"), test: testFlags({ review_unlocked: true }) }), "class_review")),
  [false, false, "student"],
);
check(
  "class review locked + student Show (submitted) -> review open",
  pick(decideAnswerVisibility(input({ override: ov("show") }), "class_review")),
  [true, true, "student"],
);
check(
  "follow: test visible -> visible (test setting)",
  pick(decideAnswerVisibility(input({ test: testFlags({ show_answers_after_submission: true }) }), "results")),
  [true, true, "test"],
);
check(
  "follow: test hidden -> hidden (test setting)",
  pick(decideAnswerVisibility(input(), "results")),
  [false, false, "test"],
);
check(
  "follow: class review unlocked, not submitted -> review open (unchanged behaviour)",
  pick(decideAnswerVisibility(input({ hasSubmitted: false, test: testFlags({ review_unlocked: true }) }), "class_review")),
  [true, true, "class_review"],
);
check(
  "first attempt in progress, class review unlocked -> review closed",
  pick(decideAnswerVisibility(input({ hasSubmitted: false, examInProgress: true, test: testFlags({ review_unlocked: true }) }), "class_review")),
  [false, false, "exam_in_progress"],
);
check(
  "Module 1 submitted, Module 2 in progress + student Show -> class review closed",
  pick(decideAnswerVisibility(input({ hasSubmitted: true, examInProgress: true, override: ov("show"), test: testFlags({ review_unlocked: true }) }), "class_review")),
  [false, false, "exam_in_progress"],
);
check(
  "Module 2 in progress -> own results page unchanged (Module 1 result)",
  pick(decideAnswerVisibility(input({ hasSubmitted: true, examInProgress: true, test: testFlags({ show_answers_after_submission: true }) }), "results")),
  [true, true, "test"],
);
check(
  "retake pending + student Show -> hidden",
  pick(decideAnswerVisibility(input({ retakePending: true, override: ov("show") }), "results")),
  [false, false, "retake_pending"],
);
check(
  "retake pending + test visible + class review unlocked -> hidden everywhere",
  pick(summarizeAnswerVisibility(input({ retakePending: true, test: testFlags({ show_answers_after_submission: true, review_unlocked: true }) }))),
  [false, false, "retake_pending"],
);
check(
  "retake submitted (no longer pending) -> previous Show restored",
  pick(decideAnswerVisibility(input({ retakePending: false, override: ov("show", false) }), "results")),
  [true, false, "student"],
);
check(
  "explanations: student Show without explanations -> answers only",
  pick(decideAnswerVisibility(input({ override: ov("show", false) }), "results")),
  [true, false, "student"],
);
check(
  "explanations: student Show without explanations -> class review answers only",
  pick(decideAnswerVisibility(input({ override: ov("show", false), test: testFlags({ review_unlocked: true }) }), "class_review")),
  [true, false, "student"],
);
check(
  "explanations: follow + test explanations off -> answers only",
  pick(decideAnswerVisibility(input({ test: testFlags({ show_answers_after_submission: true, show_explanations_after_submission: false }) }), "results")),
  [true, false, "test"],
);
check(
  "summary: follow, results hidden, class review unlocked -> visible (class review)",
  pick(summarizeAnswerVisibility(input({ test: testFlags({ review_unlocked: true }) }))),
  [true, true, "class_review"],
);
check(
  "explicit follow row behaves like no row",
  pick(decideAnswerVisibility(input({ override: ov("follow"), test: testFlags({ show_answers_after_submission: true }) }), "results")),
  [true, true, "test"],
);

// ---------------------------------------------------------------- Part 2
async function dbPart() {
  console.log("\n== Part 2: DB loader on qa-test- data ==");
  let dir = process.cwd();
  let harness: string | null = null;
  for (let i = 0; i < 8 && !harness; i++) {
    const p = join(dir, ".omc/qa/harness/lib.mjs");
    if (existsSync(p)) harness = p;
    dir = resolve(dir, "..");
  }
  if (!harness) throw new Error("QA harness lib.mjs not found above cwd");
  const lib = await import(pathToFileURL(harness).href);
  const db = lib.db as SupabaseClient;
  const cast = lib.cast() as { admins: { id: string; email: string }[]; students: { id: string; email: string }[] };
  const admin = cast.admins[0];
  const stu = cast.students[cast.students.length - 1];
  if (!admin.email.startsWith("qa-test-") || !stu.email.startsWith("qa-test-")) throw new Error("cast is not qa-test- data");
  // Any module will do — the loader never reads questions.
  const { data: mod, error: modErr } = await db.from("modules").select("id").limit(1).single();
  if (modErr || !mod) throw new Error(`no module: ${modErr?.message}`);

  const { data: t, error: tErr } = await db
    .from("tests")
    .insert({
      test_name: "TEST qa-answer-visibility",
      module_id: mod.id,
      time_limit_minutes: 35,
      status: "Published",
      allow_retake: false,
      is_adaptive: false,
      created_by: admin.id,
      show_answers_after_submission: false,
    })
    .select("id")
    .single();
  if (tErr || !t) throw new Error(`insert test: ${tErr?.message}`);
  const testId = t.id as string;
  const key = visibilityKey(testId, stu.id);
  const load = async () => (await loadAnswerVisibilityInputs(db, [testId], [stu.id])).get(key)!;
  const sub = async (attempt: number, status: string) => {
    const { data, error } = await db
      .from("submissions")
      .insert({
        test_id: testId,
        student_id: stu.id,
        answers: {},
        status,
        started_at: new Date().toISOString(),
        submitted_at: status === "In Progress" ? null : new Date().toISOString(),
        attempt_number: attempt,
        metadata: {},
        module_id: mod.id,
      })
      .select("id")
      .single();
    if (error) throw new Error(`insert submission: ${error.message}`);
    return data.id as string;
  };

  try {
    let v = await load();
    check("db: no submissions -> hasSubmitted=false", [v.hasSubmitted, v.retakePending], [false, false]);
    check("db: unsubmitted -> results hidden", pick(decideAnswerVisibility(v, "results")), [false, false, "not_submitted"]);

    const s1 = await sub(1, "In Progress");
    v = await load();
    check("db: first attempt in progress is not a retake", [v.hasSubmitted, v.retakePending], [false, false]);
    await db.from("submissions").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", s1);
    v = await load();
    check("db: submitted -> hasSubmitted=true", [v.hasSubmitted, v.retakePending], [true, false]);

    await db.from("tests").update({ show_answers_after_submission: true }).eq("id", testId);
    v = await load();
    check("db: test visible + submitted -> visible", pick(decideAnswerVisibility(v, "results")), [true, true, "test"]);

    // Retake granted -> hidden until the retake is submitted.
    const { data: g, error: gErr } = await db
      .from("test_retake_grants")
      .insert({ test_id: testId, student_id: stu.id, granted_by: admin.id })
      .select("id")
      .single();
    if (gErr) throw new Error(`insert grant: ${gErr.message}`);
    v = await load();
    check("db: retake granted -> hidden", pick(decideAnswerVisibility(v, "results")), [false, false, "retake_pending"]);
    // Start consumes the grant; attempt 2 in progress still hides.
    await db.from("test_retake_grants").update({ consumed_at: new Date().toISOString() }).eq("id", g!.id);
    const s2 = await sub(2, "In Progress");
    v = await load();
    check("db: retake in progress -> hidden", pick(decideAnswerVisibility(v, "results")), [false, false, "retake_pending"]);
    await db.from("submissions").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", s2);
    v = await load();
    check("db: retake submitted -> visible again", pick(decideAnswerVisibility(v, "results")), [true, true, "test"]);

    // Overrides (needs migration 0029).
    const probe = await db.from("student_answer_visibility").select("test_id").limit(1);
    if (probe.error) {
      console.log(`SKIPPED  override rows: table not available (${probe.error.code ?? ""} ${probe.error.message}) — migration 0029 not applied; loader tolerated it (override=${JSON.stringify(v.override)})`);
      check("db: missing override table -> override null (follow)", v.override, null);
    } else {
      const setOv = async (mode: string, show_explanations = true) => {
        const { error } = await db.from("student_answer_visibility").upsert(
          { test_id: testId, student_id: stu.id, mode, show_explanations, updated_by: admin.id, updated_at: new Date().toISOString() },
          { onConflict: "test_id,student_id" },
        );
        if (error) throw new Error(`upsert override: ${error.message}`);
      };
      await setOv("hide");
      v = await load();
      check("db: test visible + student Hide -> hidden", pick(decideAnswerVisibility(v, "results")), [false, false, "student"]);
      await db.from("tests").update({ review_unlocked: true }).eq("id", testId);
      v = await load();
      check("db: class review unlocked + Hide -> review hidden", pick(decideAnswerVisibility(v, "class_review")), [false, false, "student"]);
      await db.from("tests").update({ review_unlocked: false, show_answers_after_submission: false }).eq("id", testId);
      await setOv("show", false);
      v = await load();
      check("db: test hidden + student Show (no explanations) -> answers only", pick(decideAnswerVisibility(v, "results")), [true, false, "student"]);
      await db.from("test_retake_grants").insert({ test_id: testId, student_id: stu.id, granted_by: admin.id });
      v = await load();
      check("db: Show + retake granted -> hidden", pick(decideAnswerVisibility(v, "results")), [false, false, "retake_pending"]);
      await db.from("test_retake_grants").update({ consumed_at: new Date().toISOString() }).eq("test_id", testId).is("consumed_at", null);
      const s3 = await sub(3, "In Progress");
      await db.from("submissions").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", s3);
      v = await load();
      check("db: retake submitted -> Show restored", pick(decideAnswerVisibility(v, "results")), [true, false, "student"]);
    }
  } finally {
    await db.from("student_answer_visibility_log").delete().eq("test_id", testId);
    await db.from("student_answer_visibility").delete().eq("test_id", testId);
    await db.from("test_retake_grants").delete().eq("test_id", testId);
    await db.from("submissions").delete().eq("test_id", testId);
    await db.from("tests").delete().eq("id", testId);
    const { data: left } = await db.from("tests").select("id").eq("id", testId);
    console.log(`cleanup: test row remaining = ${(left ?? []).length}`);
  }
}

(async () => {
  if (process.argv.includes("--db")) await dbPart();
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
