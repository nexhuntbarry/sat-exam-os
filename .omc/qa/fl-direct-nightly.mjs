// .omc/qa/fl-direct-nightly.mjs — DRAFT, not installed.
// Nightly check for ticket fb38d638: Create Test → Full-length SAT with its
// four modules picked directly (no source section tests). Production, hidden
// QA accounts only. To install: copy to .omc/qa/harness/nightly/fl-direct-checks.mjs
// and in nightly/run.mjs, right after runFullLengthChecks(...), add
//
//   import { runFlDirectChecks } from "./fl-direct-checks.mjs";
//   await runFlDirectChecks({
//     check, fail, skip, TESTS, C, STUDENT1_CLERK, ADMIN_CLERK, studentByN, moduleQs, correctPick,
//   });
//
// Post-deploy alone: ONLY=FL-DIRECT-CREATE,FL-DIRECT-TAKE node nightly/run.mjs
//
//   FL-DIRECT-CREATE  QA admin: /admin/tests/new shows the three type cards;
//                     POST /api/admin/tests {kind:"full_length", sections}
//                     with the four modules of the flFullLength fixture
//                     (adaptive R&W + adaptive Math, approved) → 201; stored
//                     shape = full_length parent (break 10 = the default,
//                     Draft, QA-owned) + two fl_section children with exactly
//                     those modules, no source test, SAT time limits, Desmos on
//                     Math only. Negative: a Math module in the R&W block → 400.
//                     Assign student 100, publish → 200.
//   FL-DIRECT-TAKE    student 100 (borrowed onto the STUDENT1 login, given
//                     back in finally): full-length start → R&W M1/M2 → state
//                     "break" → start-math (Resume testing) → Math M1/M2 →
//                     state "done"; results API total = R&W + Math in
//                     400–1600; student result page 200.
// Cleanup (finally, even after a crash): the test it made (QA admin owned,
// name "TEST qa-admin FL direct …"): attempts, submissions + answer_records,
// then the parent (children cascade). The fixture is only read.
import { chromium } from "playwright";
import { login, db, BASE, borrowLogin } from "../lib.mjs";

const DONE = (s) => s === "Submitted" || s === "Late";
const NAME_PREFIX = "TEST qa-admin FL direct ";
const STUDENT_N = 100; // 081–100 are free in the nightly suite (loadtest only)

export async function runFlDirectChecks(h) {
  const { check, fail, skip, TESTS, C, STUDENT1_CLERK, ADMIN_CLERK, studentByN, moduleQs, correctPick } = h;
  const AREA = "整份SAT";
  const QA_ADMIN_IDS = new Set(C.admins.map((a) => a.id));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  let made = null; // parent id
  let kids = null; // { rw, math }

  async function asUser(clerkId, fn) {
    const b = await chromium.launch();
    try {
      const { page } = await login(b, clerkId);
      return await fn({ page, req: page.request });
    } finally {
      await b.close().catch(() => {});
    }
  }
  async function json(res, what) {
    const j = await res.json().catch(() => ({}));
    if (res.status() >= 400) fail(`${what} → HTTP ${res.status()} ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }
  /** Module ids of a section test row as the create body's section. */
  const sectionBody = (t) =>
    t.is_adaptive
      ? { isAdaptive: true, module1Id: t.module_1_id, module2EasyId: t.module_2_easy_id ?? undefined, module2HardId: t.module_2_hard_id ?? undefined, adaptiveThreshold: t.adaptive_threshold ?? 60 }
      : { isAdaptive: false, moduleId: t.module_id, module2Id: t.module_2_id };
  const served = (t) =>
    (t.is_adaptive ? [t.module_1_id, t.module_2_easy_id, t.module_2_hard_id] : [t.module_id, t.module_2_id]).filter(Boolean);

  try {
    // ═══════════════════════════════════════════════════════════════
    await check("FL-DIRECT-CREATE", [], "整份 SAT 直接選四個模組建立（不需先建兩份單科測驗）：存檔形狀、只收已核准模組、科目過濾、發佈", AREA, async () => {
      const fx = TESTS.flFullLength;
      if (!fx) skip("fixture flFullLength missing from .omc/qa/tests.json — run fullsat-fixtures.mjs");
      const { data: fxKids } = await db.from("tests").select("*").eq("parent_test_id", fx);
      const fxRw = (fxKids ?? []).find((k) => k.section_order === 1);
      const fxMath = (fxKids ?? []).find((k) => k.section_order === 2);
      if (!fxRw || !fxMath) skip("flFullLength fixture lacks its sections");
      const s = studentByN(STUDENT_N);
      if (!s) skip(`TEST Student ${STUDENT_N} missing from the cast`);
      const notes = [];
      await asUser(ADMIN_CLERK, async ({ req }) => {
        // Step 1 starts with the three type cards.
        const page = await req.get(`${BASE}/admin/tests/new`);
        const html = await page.text();
        if (page.status() !== 200) fail(`/admin/tests/new → HTTP ${page.status()}`);
        for (const card of ["Section test", "Full-length SAT", "Custom test"]) if (!html.includes(card)) fail(`type card "${card}" missing on Create Test`);

        const base = { kind: "full_length", allowDuplicateName: true, studentIds: [] };
        // Section filtering is enforced server side: a Math module in the R&W block.
        const wrong = await req.post(`${BASE}/api/admin/tests`, {
          data: { ...base, testName: `${NAME_PREFIX}${stamp} wrong`, sections: { rw: { isAdaptive: false, moduleId: served(fxRw)[0], module2Id: served(fxMath)[0] }, math: sectionBody(fxMath) } },
        });
        if (wrong.status() !== 400) {
          const j = await wrong.json().catch(() => ({}));
          if (j.data?.id) made = j.data.id; // clean it up
          fail(`Math module in the R&W block → HTTP ${wrong.status()} (expected 400)`);
        }
        notes.push("mixed sections refused");

        const name = `${NAME_PREFIX}${stamp}`;
        const res = await req.post(`${BASE}/api/admin/tests`, {
          data: { ...base, testName: name, sections: { rw: sectionBody(fxRw), math: sectionBody(fxMath) } },
        });
        const rj = await json(res, "create");
        if (res.status() !== 201 || !rj.data?.id) fail(`create → HTTP ${res.status()}`);
        made = rj.data.id;

        // Stored shape: the same parent + two hidden children the source-test flow makes.
        const { data: p } = await db.from("tests").select("*").eq("id", made).single();
        if (p.test_kind !== "full_length" || p.status !== "Draft" || !QA_ADMIN_IDS.has(p.created_by)) fail(`parent wrong: ${p.test_kind}/${p.status}/${p.created_by}`);
        if (p.break_minutes !== 10 || p.allow_section_pause) fail(`break ${p.break_minutes}/${p.allow_section_pause}, expected the default 10 / no pause`);
        const { data: ks } = await db.from("tests").select("*").eq("parent_test_id", made).order("section_order");
        if ((ks ?? []).length !== 2) fail(`${ks?.length ?? 0} children (expected 2)`);
        kids = { rw: ks[0], math: ks[1] };
        const problems = [];
        for (const [k, fxK, mins] of [["rw", fxRw, 32], ["math", fxMath, 35]]) {
          const c = kids[k];
          if (c.test_kind !== "fl_section" || c.created_by !== p.created_by) problems.push(`${k}: ${c.test_kind} by ${c.created_by}`);
          if (JSON.stringify(served(c)) !== JSON.stringify(served(fxK)) || c.is_adaptive !== fxK.is_adaptive) problems.push(`${k}: modules ${served(c)} ≠ picked ${served(fxK)}`);
          if (c.source_test_id !== null) problems.push(`${k}: source_test_id ${c.source_test_id} (expected none)`);
          if (c.time_limit_minutes !== mins || c.time_limit_minutes_module_2 !== mins) problems.push(`${k}: limits ${c.time_limit_minutes}/${c.time_limit_minutes_module_2}, expected ${mins}`);
          if (Boolean(c.desmos_enabled) !== (k === "math")) problems.push(`${k}: desmos ${c.desmos_enabled}`);
        }
        if (problems.length) fail(problems.join("; "));

        const as = await req.patch(`${BASE}/api/admin/tests/${made}`, { data: { studentIds: [s.id] } });
        if (as.status() !== 200) fail(`assign → HTTP ${as.status()}`);
        const pub = await req.post(`${BASE}/api/admin/tests/${made}/publish`);
        if (pub.status() !== 200) fail(`publish → HTTP ${pub.status()} ${(await pub.text()).slice(0, 200)}`);
        const tp = await req.get(`${BASE}/admin/tests/${made}`);
        if (tp.status() !== 200) fail(`admin test page → HTTP ${tp.status()}`);
        notes.push(`created ${served(kids.rw).length}+${served(kids.math).length} modules, published`);
      });
      return notes.join("; ");
    }, 4 * 60 * 1000);

    // ═══════════════════════════════════════════════════════════════
    await check("FL-DIRECT-TAKE", ["FL-DIRECT-CREATE"], "直接建立的整份 SAT：學生英文 → 休息 → 數學，成績合併為 400–1600", AREA, async () => {
      if (!made || !kids) skip("FL-DIRECT-CREATE didn't make the test");
      const s = studentByN(STUDENT_N);
      const orig = C.students[0].id;
      await borrowLogin(s.id, STUDENT1_CLERK);
      try {
        return await asUser(STUDENT1_CLERK, async ({ req }) => {
          const state = async () => (await json(await req.get(`${BASE}/api/student/full-length/${made}/state`), "state")).data ?? {};
          /** Module 1 (all right), then the Module 2 its handoff created. */
          const section = async (m1Id) => {
            let id = m1Id;
            for (const label of ["M1", "M2"]) {
              const { data: row } = await db.from("submissions").select("module_id").eq("id", id).single();
              const qs = await moduleQs(row.module_id);
              const answers = Object.fromEntries(qs.map((q) => [q.id, correctPick(q)]));
              const r = await json(await req.post(`${BASE}/api/student/submissions/${id}/submit`, { data: { answers, metadata: {} } }), `${label} submit`);
              if (label === "M1") {
                id = r.data?.nextSubmissionId;
                if (!id) fail("Module 1 submitted but no Module 2 was handed back");
              }
            }
          };
          const st = await json(await req.post(`${BASE}/api/student/full-length/${made}/start`, { data: {} }), "full-length start");
          if (!st.data?.submissionId) fail(`start returned no submission: ${JSON.stringify(st).slice(0, 160)}`);
          await section(st.data.submissionId);
          const brk = await state();
          if (brk.state !== "break") fail(`after R&W the state is ${brk.state}, expected break`);
          const sm = await json(await req.post(`${BASE}/api/student/full-length/${made}/start-math`, { data: {} }), "start-math");
          if (!sm.data?.submissionId) fail("start-math returned no submission");
          await section(sm.data.submissionId);
          const done = await state();
          if (done.state !== "done") fail(`after Math the state is ${done.state}, expected done`);
          const { data: rows } = await db.from("submissions").select("test_id, status").in("test_id", [kids.rw.id, kids.math.id]).eq("student_id", s.id);
          if ((rows ?? []).length !== 4 || rows.some((r) => !DONE(r.status))) fail(`${rows?.length ?? 0} module rows, statuses ${rows?.map((r) => r.status)}`);
          const res = await req.get(`${BASE}/student/tests/${made}/result`);
          if (res.status() !== 200) fail(`student result → HTTP ${res.status()}`);
          const out = await asUser(ADMIN_CLERK, async ({ req: areq }) => {
            const j = await json(await areq.get(`${BASE}/api/teacher/tests/${made}/results`), "teacher results");
            const row = (j.students ?? []).find((r) => r.studentId === s.id);
            if (!row) fail("attempt missing from the results API");
            if (row.total == null || row.total !== row.rw?.sat + row.math?.sat) fail(`total ${row.total} ≠ R&W ${row.rw?.sat} + Math ${row.math?.sat}`);
            if (!(row.total >= 400 && row.total <= 1600)) fail(`total ${row.total} outside 400–1600`);
            return `R&W ${row.rw.sat} + Math ${row.math.sat} = ${row.total}`;
          });
          return `break → Math OK; ${out}`;
        });
      } finally {
        await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      }
    }, 6 * 60 * 1000);
  } finally {
    // Clean up only what this run made: QA-owned, our name prefix.
    if (made) {
      const { data: t } = await db.from("tests").select("created_by, test_name").eq("id", made).maybeSingle();
      if (t && QA_ADMIN_IDS.has(t.created_by) && t.test_name.startsWith(NAME_PREFIX)) {
        const kidIds = ((await db.from("tests").select("id").eq("parent_test_id", made)).data ?? []).map((k) => k.id);
        await db.from("full_length_attempts").delete().eq("test_id", made);
        const subs = kidIds.length ? ((await db.from("submissions").select("id").in("test_id", kidIds)).data ?? []).map((r) => r.id) : [];
        if (subs.length) {
          await db.from("answer_records").delete().in("submission_id", subs);
          await db.from("submissions").delete().in("id", subs);
        }
        await db.from("test_retake_grants").delete().eq("test_id", made);
        await db.from("test_time_accommodations").delete().eq("test_id", made);
        await db.from("test_assignments").delete().eq("test_id", made);
        await db.from("tests").delete().eq("id", made); // children cascade
      }
    }
  }
}
