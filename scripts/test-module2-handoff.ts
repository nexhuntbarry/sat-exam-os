// scripts/test-module2-handoff.ts
//
// Module 1 → Module 2 handoff (lib/module2-handoff, lib/finalize-stale)
// against the real database, on QA data only: QA students 091/092 and the
// QA tests from .omc/qa/tests.json. Every row it creates is deleted at the
// end (and that student's rows for the two tests are cleared first).
//
//   node --env-file=.env.local --import tsx scripts/test-module2-handoff.ts
//
// Checks:
//   1. cron finalizes an overdue Module 1 → exactly one Module 2, unopened
//      (no module_2_started_at), and a second cron pass changes nothing
//   2. the unopened Module 2 is left alone by the cron (clock not started)
//   3. ensureModule2 x2 and x6 concurrently → one row, all callers agree
//   4. adaptive: concurrent handoffs that disagree on the track → one row
//   5. recoverModule2: creates the missing Module 2 once, then no-ops
//   6. the per-track unique index exists (a raw duplicate insert → 23505)
//   7. recovery rules: only the latest session (onlySessionId), Published,
//      past the due date only within 24 h of Module 1 → else { blocked }
//   8. the duplicate clean-up never deletes an opened / answered row
//   9. cron closing an unopened Module 2 after 24 h: 0 s spent, flagged
//      auto_closed_unopened, and the analytics filter leaves it out
//  10. Late: M1 straddling the due date + normal handoff → not Late;
//      Module 2 created by past-due recovery (created_after_due) → Late
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  ensureModule2, recoverModule2, module2RecoveryBlock, MODULE_2_TRACKS, HANDOFF_TEST_COLUMNS, RECOVERY_TEST_COLUMNS,
  type RecoveryTest,
} from "../lib/module2-handoff";
import { finalizeStaleSubmission, STALE_SUBMISSION_COLUMNS, STALE_TEST_COLUMNS, type StaleSubmission, type StaleTest } from "../lib/finalize-stale";
import { finalizeSubmission } from "../lib/grade-submission";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const cast = JSON.parse(readFileSync(".omc/qa/cast.json", "utf-8"));
const TESTS = JSON.parse(readFileSync(".omc/qa/tests.json", "utf-8")) as Record<string, string>;
const student = (n: number) => {
  const s = cast.students.find((x: { name: string }) => x.name === `TEST Student ${String(n).padStart(3, "0")}`);
  if (!s) throw new Error(`QA student ${n} missing`);
  return s.id as string;
};

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function assertQa(studentId: string) {
  const { data } = await db.from("users").select("email").eq("id", studentId).single();
  if (!data?.email?.startsWith("qa-test-")) throw new Error(`refusing to touch non-QA user ${studentId}`);
}
async function clear(studentId: string, testId: string) {
  await assertQa(studentId);
  const { data } = await db.from("submissions").select("id").eq("student_id", studentId).eq("test_id", testId);
  const ids = (data ?? []).map((r) => r.id);
  if (ids.length) {
    await db.from("answer_records").delete().in("submission_id", ids);
    await db.from("submissions").delete().in("id", ids);
  }
}
async function module2Rows(sessionId: string) {
  const { data } = await db
    .from("submissions")
    .select("id, status, adaptive_track, metadata, started_at")
    .eq("session_id", sessionId)
    .in("adaptive_track", MODULE_2_TRACKS as unknown as string[]);
  return data ?? [];
}
async function loadTest(testId: string) {
  const { data } = await db.from("tests").select(STALE_TEST_COLUMNS).eq("id", testId).single();
  return data as unknown as StaleTest;
}
/** Insert an In Progress Module 1 that started `minutesAgo` minutes ago. */
async function insertModule1(studentId: string, testId: string, moduleId: string, minutesAgo: number, attempt = 1) {
  const sessionId = globalThis.crypto.randomUUID();
  const { data, error } = await db
    .from("submissions")
    .insert({
      test_id: testId,
      student_id: studentId,
      answers: {},
      status: "In Progress",
      started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      attempt_number: attempt,
      metadata: {},
      session_id: sessionId,
      module_id: moduleId,
      adaptive_track: "module_1",
    })
    .select(STALE_SUBMISSION_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as StaleSubmission;
}
/** Grade a Module 1 directly (what a submit does before the handoff). */
async function grade(sub: StaleSubmission, test: StaleTest) {
  const r = await finalizeSubmission({
    submissionId: sub.id,
    submission: { ...sub, answers: {} },
    test: { ...test, question_ids: (test.question_ids as string[] | null) ?? null },
    db,
  });
  if (!r) throw new Error("grade lost the claim");
  return r;
}
const asM1 = (s: StaleSubmission) => ({
  test_id: s.test_id,
  student_id: s.student_id,
  session_id: s.session_id,
  attempt_number: s.attempt_number,
  adaptive_track: s.adaptive_track,
});

async function main() {
  const S1 = student(91);
  const S2 = student(92);
  const linear = await loadTest(TESTS.mathLinear);
  const adaptive = await loadTest(TESTS.adaptive);
  const { data: adaptiveFull } = await db.from("tests").select("module_1_id").eq("id", TESTS.adaptive).single();
  for (const [s, t] of [[S1, TESTS.mathLinear], [S1, TESTS.adaptive], [S2, TESTS.mathLinear], [S2, TESTS.adaptive]]) await clear(s, t);

  try {
    // 1. cron path
    const limit = linear.time_limit_minutes ?? 35;
    const m1 = await insertModule1(S1, linear.id, linear.module_id!, limit + 7);
    const r1 = await finalizeStaleSubmission(db, m1, linear);
    check("cron finalizes the overdue Module 1", r1.action === "finalized", r1);
    let m2s = await module2Rows(m1.session_id!);
    check("cron created exactly one Module 2", m2s.length === 1, m2s.map((r) => r.adaptive_track));
    check("cron result reports that Module 2 id", r1.module2Id === m2s[0]?.id);
    check("Module 2 is In Progress, track module_2", m2s[0]?.status === "In Progress" && m2s[0]?.adaptive_track === "module_2");
    check(
      "Module 2 clock not started (no module_2_started_at)",
      !((m2s[0]?.metadata ?? {}) as Record<string, unknown>).module_2_started_at,
      m2s[0]?.metadata,
    );
    const r1b = await finalizeStaleSubmission(db, m1, linear);
    m2s = await module2Rows(m1.session_id!);
    check("second cron pass: skipped, still one Module 2", r1b.action === "skipped" && m2s.length === 1, r1b.reason);

    // 2. unopened Module 2 is not graded by the cron
    const { data: m2Row } = await db.from("submissions").select(STALE_SUBMISSION_COLUMNS).eq("id", m2s[0].id).single();
    const r2 = await finalizeStaleSubmission(db, m2Row as unknown as StaleSubmission, linear);
    check("cron leaves the unopened Module 2 alone", r2.action === "skipped" && /not opened/.test(r2.reason ?? ""), r2.reason);

    // 3. concurrent handoffs, same track
    const m1b = await insertModule1(S2, linear.id, linear.module_id!, 5);
    const g = await grade(m1b, linear);
    const pair = await Promise.all([0, 1].map(() => ensureModule2(db, asM1(m1b), linear, { module1Percentage: g.percentage })));
    m2s = await module2Rows(m1b.session_id!);
    check("2 concurrent handoffs → one Module 2", m2s.length === 1, m2s.length);
    check("both callers got that row", pair.every((p) => p?.id === m2s[0]?.id), pair);
    check("exactly one caller created it", pair.filter((p) => p?.created).length === 1, pair);
    const six = await Promise.all(Array.from({ length: 6 }, () => ensureModule2(db, asM1(m1b), linear, { module1Percentage: g.percentage })));
    m2s = await module2Rows(m1b.session_id!);
    check("6 more concurrent handoffs → still one Module 2", m2s.length === 1 && six.every((p) => p?.id === m2s[0]?.id && !p?.created));

    // 4. adaptive, handoffs that disagree on the track (only possible if
    // two callers saw different Module 1 scores; covered by the
    // post-insert check, airtight once migration 0030 is applied).
    const m1c = await insertModule1(S1, adaptive.id, adaptiveFull!.module_1_id, 5);
    await grade(m1c, adaptive);
    const mixed = await Promise.all([0, 100, 0, 100].map((p) => ensureModule2(db, asM1(m1c), adaptive, { module1Percentage: p })));
    m2s = await module2Rows(m1c.session_id!);
    check("adaptive: easy+hard racing → one Module 2", m2s.length === 1, m2s.map((r) => r.adaptive_track));
    check("adaptive: every caller got that row", mixed.every((p) => p?.id === m2s[0]?.id), mixed);

    // 5. recovery path
    const m1d = await insertModule1(S2, adaptive.id, adaptiveFull!.module_1_id, 5);
    const gd = await grade(m1d, adaptive);
    const handoffTest = { ...adaptive, status: "Published" } as unknown as RecoveryTest;
    const wrongSession = await recoverModule2(db, adaptive.id, S2, handoffTest, { onlySessionId: globalThis.crypto.randomUUID() });
    check("recovery for a session that isn't the latest → nothing, no insert",
      wrongSession === null && (await module2Rows(m1d.session_id!)).length === 0);
    const unpublished = await recoverModule2(db, adaptive.id, S2, { ...handoffTest, status: "Draft" });
    check("recovery on an unpublished test → blocked, no insert",
      !!unpublished && "blocked" in unpublished && unpublished.blocked === "not_published" && (await module2Rows(m1d.session_id!)).length === 0);
    const rec = await recoverModule2(db, adaptive.id, S2, handoffTest, { onlySessionId: m1d.session_id! });
    m2s = await module2Rows(m1d.session_id!);
    const wantTrack = gd.percentage >= (adaptive.adaptive_threshold ?? 60) ? "module_2_hard" : "module_2_easy";
    check("recovery creates the missing Module 2", !!rec && "id" in rec && rec.created && m2s.length === 1 && m2s[0].id === rec.id);
    check(`recovery routes by the Module 1 score (${gd.percentage}% → ${wantTrack})`, m2s[0]?.adaptive_track === wantTrack, m2s[0]?.adaptive_track);
    const rec2 = await recoverModule2(db, adaptive.id, S2, handoffTest);
    check("recovery again → hands back the open Module 2, no insert",
      !!rec && "id" in rec && !!rec2 && "id" in rec2 && rec2.id === rec.id && rec2.created === false &&
      (await module2Rows(m1d.session_id!)).length === 1, rec2);
    // An existing open Module 2 is handed back even > 24 h past due (the
    // block only gates creating one).
    await db.from("submissions").update({ submitted_at: new Date(Date.now() - 30 * 3_600_000).toISOString() }).eq("id", m1d.id);
    const recLate = await recoverModule2(db, adaptive.id, S2, { ...handoffTest, due_date: new Date(Date.now() - 48 * 3_600_000).toISOString() });
    check("recovery > 24 h past due with Module 2 open → hands it back, not blocked",
      !!rec && "id" in rec && !!recLate && "id" in recLate && recLate.id === rec.id && recLate.created === false &&
      (await module2Rows(m1d.session_id!)).length === 1, recLate);
    // A finished Module 2: nothing to recover.
    if (rec && "id" in rec) await db.from("submissions").update({ status: "Submitted" }).eq("id", rec.id);
    const recDone = await recoverModule2(db, adaptive.id, S2, handoffTest);
    check("recovery after Module 2 is Submitted → nothing, no insert",
      recDone === null && (await module2Rows(m1d.session_id!)).length === 1, recDone);

    // 6. the per-track unique index the handoff relies on
    const { error: dupErr } = await db.from("submissions").insert({
      test_id: linear.id, student_id: S2, answers: {}, status: "In Progress", started_at: new Date().toISOString(),
      attempt_number: m1b.attempt_number, metadata: {}, session_id: m1b.session_id, module_id: linear.module_id,
      adaptive_track: "module_2",
    });
    check("uniq_submissions_attempt_adaptive present (duplicate insert → 23505)", dupErr?.code === "23505", dupErr?.code ?? "inserted!");

    // 0030 applied? (informational: a different-track second Module 2)
    const { error: e0030, data: d0030 } = await db.from("submissions").insert({
      test_id: adaptive.id, student_id: S2, answers: {}, status: "In Progress", started_at: new Date().toISOString(),
      attempt_number: m1d.attempt_number, metadata: {}, session_id: m1d.session_id, module_id: adaptive.module_2_easy_id,
      adaptive_track: m2s[0]?.adaptive_track === "module_2_easy" ? "module_2_hard" : "module_2_easy",
    }).select("id");
    console.log(`INFO  migration 0030 index ${e0030?.code === "23505" ? "is applied" : `not applied yet (second-track insert ${d0030 ? "succeeded" : e0030?.code})`}`);

    // Handoff column lists stay in sync with what the routes select.
    check("HANDOFF/RECOVERY_TEST_COLUMNS selectable",
      !(await db.from("tests").select(HANDOFF_TEST_COLUMNS).eq("id", linear.id).single()).error &&
      !(await db.from("tests").select(RECOVERY_TEST_COLUMNS).eq("id", linear.id).single()).error);

    // 7. due-date window (pure rule + one DB case)
    const H = 3_600_000, now = Date.now();
    const pub = (due: number | null) => ({ status: "Published", due_date: due == null ? null : new Date(due).toISOString() });
    check("rule: no due date → allowed", module2RecoveryBlock(pub(null), new Date(now - 100 * H).toISOString()) === null);
    check("rule: due in the future → allowed", module2RecoveryBlock(pub(now + H), new Date(now - 100 * H).toISOString()) === null);
    check("rule: past due, Module 1 graded 2 h ago → allowed", module2RecoveryBlock(pub(now - H), new Date(now - 2 * H).toISOString()) === null);
    check("rule: past due, Module 1 graded 30 h ago → past_due", module2RecoveryBlock(pub(now - H), new Date(now - 30 * H).toISOString()) === "past_due");
    check("rule: past due, no submitted_at → past_due", module2RecoveryBlock(pub(now - H), null) === "past_due");
    check("rule: not Published → not_published", module2RecoveryBlock({ status: "Closed", due_date: null }, new Date().toISOString()) === "not_published");
    await clear(S1, linear.id);
    const m1old = await insertModule1(S1, linear.id, linear.module_id!, 40 * 60);
    await grade(m1old, linear);
    await db.from("submissions").update({ submitted_at: new Date(now - 30 * H).toISOString() }).eq("id", m1old.id);
    const pastDue = await recoverModule2(db, linear.id, S1, { ...(linear as unknown as RecoveryTest), status: "Published", due_date: new Date(now - 2 * H).toISOString() });
    check("recovery past due, Module 1 graded 30 h ago → blocked, no insert",
      !!pastDue && "blocked" in pastDue && pastDue.blocked === "past_due" && (await module2Rows(m1old.session_id!)).length === 0, pastDue);

    // 8. the duplicate clean-up's delete filter (same filter as ensureModule2)
    const guardDelete = (id: string) =>
      db.from("submissions").delete().eq("id", id).eq("status", "In Progress").eq("answers", "{}")
        .is("metadata->module_2_started_at", null).select("id");
    const mkM2 = async (answers: Record<string, string>, metadata: Record<string, unknown>) =>
      (await db.from("submissions").insert({
        test_id: linear.id, student_id: S1, answers, status: "In Progress", started_at: new Date().toISOString(),
        attempt_number: 1, metadata, session_id: m1old.session_id, module_id: linear.module_id, adaptive_track: "module_2",
      }).select("id").single()).data!.id as string;
    const opened = await mkM2({}, { module_2_started_at: new Date().toISOString() });
    check("clean-up never deletes an opened Module 2", ((await guardDelete(opened)).data ?? []).length === 0);
    await db.from("submissions").delete().eq("id", opened);
    const answered = await mkM2({ q: "A" }, {});
    check("clean-up never deletes an answered Module 2", ((await guardDelete(answered)).data ?? []).length === 0);
    await db.from("submissions").delete().eq("id", answered);
    const fresh = await mkM2({}, { device: { platform: "Mac" } });
    check("clean-up deletes an untouched duplicate", ((await guardDelete(fresh)).data ?? []).length === 1);

    // 9. cron auto-closes an unopened Module 2 after 24 h
    const stale = await mkM2({}, {});
    await db.from("submissions").update({ started_at: new Date(now - 25 * H).toISOString() }).eq("id", stale);
    const { data: staleRow } = await db.from("submissions").select(STALE_SUBMISSION_COLUMNS).eq("id", stale).single();
    const r9 = await finalizeStaleSubmission(db, staleRow as unknown as StaleSubmission, linear);
    const { data: closed9 } = await db.from("submissions").select("status, time_spent_seconds, metadata").eq("id", stale).single();
    check("unopened Module 2 closed after 24 h", r9.action === "finalized" && closed9?.status !== "In Progress", r9);
    check("…with 0 s spent and auto_closed_unopened", closed9?.time_spent_seconds === 0 && (closed9?.metadata as Record<string, unknown>)?.auto_closed_unopened === true, closed9);
    const { data: ar9 } = await db.from("answer_records").select("time_spent_seconds").eq("submission_id", stale);
    check("…and its answer records carry 0 s", (ar9 ?? []).every((r) => r.time_spent_seconds === 0), (ar9 ?? []).length);
    const { data: seen9 } = await db.from("submissions").select("id").eq("student_id", S1).eq("test_id", linear.id)
      .in("status", ["Submitted", "Late"])
      .or("metadata->auto_closed_unopened.is.null,metadata->auto_closed_unopened.neq.true");
    const seenIds = (seen9 ?? []).map((r) => r.id);
    check("analytics filter skips it but keeps the real Module 1", !seenIds.includes(stale) && seenIds.includes(m1old.id), seenIds.length);

    // 10. Late rules for Module 2 (Barry: started on time isn't Late)
    const finalizeM2 = async (id: string, dueIso: string) => {
      const { data: row } = await db.from("submissions").select(STALE_SUBMISSION_COLUMNS).eq("id", id).single();
      const sub = row as unknown as StaleSubmission;
      const r = await finalizeSubmission({
        submissionId: sub.id, submission: { ...sub, answers: {} },
        test: { ...linear, due_date: dueIso, question_ids: null }, db,
      });
      return r?.status;
    };
    // (a) M1 straddles the due date, normal handoff, M2 opened 1 min after M1.
    await clear(S2, linear.id);
    const dueA = new Date(now - 10 * 60_000).toISOString(); // due passed during M1
    const m1a = await insertModule1(S2, linear.id, linear.module_id!, 30);
    await grade(m1a, linear);
    const handA = await ensureModule2(db, asM1(m1a), linear, { module1Percentage: 0 });
    await db.from("submissions").update({ metadata: { module_2_started_at: new Date(now - 60_000).toISOString() } }).eq("id", handA!.id);
    check("M1 straddles the due date, M2 opened 1 min after → Submitted (not Late)", (await finalizeM2(handA!.id, dueA)) === "Submitted");
    // (b) Recovery after the due date (inside the 24 h window) → flagged, Late.
    await clear(S2, linear.id);
    const dueB = new Date(now - 2 * H).toISOString();
    const m1b2 = await insertModule1(S2, linear.id, linear.module_id!, 4 * 60);
    await grade(m1b2, linear);
    await db.from("submissions").update({ submitted_at: new Date(now - 3 * H).toISOString() }).eq("id", m1b2.id);
    const recB = await recoverModule2(db, linear.id, S2, { ...(linear as unknown as RecoveryTest), status: "Published", due_date: dueB });
    const recBId = recB && "id" in recB ? recB.id : null;
    const { data: recBRow } = recBId ? await db.from("submissions").select("metadata").eq("id", recBId).single() : { data: null };
    check("past-due recovery (within 24 h) creates Module 2 flagged created_after_due",
      !!recBId && (recBRow?.metadata as Record<string, unknown>)?.created_after_due === true, recB);
    check("…and that Module 2 is graded Late", recBId ? (await finalizeM2(recBId, dueB)) === "Late" : false);
    // (c) A normal (non-recovery) handoff after the due date isn't flagged.
    await clear(S2, linear.id);
    const m1c2 = await insertModule1(S2, linear.id, linear.module_id!, 30);
    await grade(m1c2, linear);
    const handC = await ensureModule2(db, asM1(m1c2), linear, { module1Percentage: 0 });
    const { data: cRow } = await db.from("submissions").select("metadata").eq("id", handC!.id).single();
    check("normal handoff never sets created_after_due", !(cRow?.metadata as Record<string, unknown>)?.created_after_due);
  } finally {
    for (const [s, t] of [[S1, TESTS.mathLinear], [S1, TESTS.adaptive], [S2, TESTS.mathLinear], [S2, TESTS.adaptive]]) await clear(s, t);
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
