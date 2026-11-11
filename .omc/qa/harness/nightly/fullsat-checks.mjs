// harness/nightly/fullsat-checks.mjs — full-length SAT (R&W → break → Math,
// one 400–1600 result) on production, with hidden QA accounts only.
// Plan: .omc/plans/full-length-sat.md §7. Called from run.mjs:
//   await runFullLengthChecks({ check, fail, skip, ... })
// Post-deploy smoke only:  ONLY=FL-SMOKE node nightly/run.mjs
//
// Fixtures: .omc/qa/harness/fullsat-fixtures.mjs (idempotent) writes the
// QA full-length tests into .omc/qa/tests.json (flFullLength, flShort,
// flPause, flWindow + the R&W / Math sources). Every FL check except
// FL-SMOKE reports SKIP (with the reason) while migration 0031 or those
// fixtures are missing.
//
// Students (TEST Student NNN, borrowed onto the STUDENT1 login like the
// edge checks): 082 smoke · 083-085 API paths · 086 browser · 087 break
// leave · 088 resume early · 089 pause · 090-093 time-outs · 094 window
// close · 095 extended · 096 Math-only teacher (class A) · 097 no-leak ·
// 098 consistency · 099 retake. Each check deletes its own attempt rows
// (attempt, submissions + answer_records, grants, accommodations) before
// and after. The fixtures stay (QA-owned, invisible to real users).
//
// Time budget ≤ 25 min: the four time-outs and the window close are set up
// first (≈3 min, sequential logins), then wait for the 5-minute production
// cron in the background (one shared wait, capped at 7 min) while the rest
// runs; their results are recorded at the end.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { login, db, BASE, borrowLogin } from "../lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_ROOT = new URL("../../../../", import.meta.url).pathname;
const HERE = new URL("./", import.meta.url).pathname;
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const wants = (id) => !ONLY || ONLY.includes(id);
const DONE = (s) => s === "Submitted" || s === "Late";
const isM2 = (t) => String(t ?? "").startsWith("module_2");
/** Text with "22 / 27" → "22/27" and runs of whitespace collapsed. */
const norm = (s) => String(s ?? "").replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
const CRON_WAIT_MS = 7 * 60 * 1000;

export async function runFullLengthChecks(h) {
  const state = {};
  try {
    return await runAll(h, state);
  } finally {
    await safetyNet(h, state);
  }
}

/**
 * Whatever happened above (a crash, the check timeout racing a setup):
 * the window fixture never keeps a past due date, and the background
 * students 090–094 keep no attempt. Only fixtures that passed the
 * ownership check (fixture()) are in the cache, so nothing else is touched.
 */
async function safetyNet(h, state) {
  const { TESTS, studentByN } = h;
  const ctxOf = (k) => (TESTS[k] ? state.ctxCache?.get(TESTS[k]) : undefined);
  const w = ctxOf("flWindow");
  if (w) {
    const { data } = await db.from("tests").select("due_date, created_by").eq("id", w.id).maybeSingle();
    if (data?.created_by === w.parent.created_by && data.due_date && Date.parse(data.due_date) < Date.now()) {
      await db.from("tests").update({ due_date: null }).eq("id", w.id).eq("created_by", w.parent.created_by);
    }
  }
  const short = ctxOf("flShort");
  for (const [n, c] of [[90, short], [91, short], [92, short], [93, short], [94, w]]) {
    const s = studentByN(n);
    if (c && s && state.cleanFl) await state.cleanFl(s.id, [c]).catch(() => {});
  }
}

async function runAll(h, state) {
  const {
    check, fail, skip, TESTS, C, STUDENT1_CLERK, ADMIN_CLERK, TEACHER1_CLERK,
    studentByN, moduleQs, correctPick, wrongPick, deleteSubs, START_MS, GLOBAL_TIMEOUT_MS,
  } = h;
  const AREA = "整份SAT";
  const QA_ADMIN_IDS = new Set(C.admins.map((a) => a.id));

  // ───────────────────────── prerequisites ─────────────────────────
  let prereqP = null;
  /** Migration 0031 on prod? (null = yes, else the reason to skip) */
  function migrationMissing() {
    prereqP ??= (async () => {
      // Not a HEAD request: PostgREST reports a missing table only with a body.
      // Only "table / column doesn't exist" means not migrated; any other
      // error (network, auth) is a real ERROR, not a quiet SKIP.
      const missing = (e) => e && (e.code === "42P01" || e.code === "42703" || /^PGRST20\d$/.test(e.code ?? ""));
      const a = await db.from("full_length_attempts").select("id").limit(1);
      if (missing(a.error)) return `migration 0031 not applied (full_length_attempts: ${a.error.message})`;
      if (a.error) throw new Error(`full_length_attempts probe: ${a.error.code} ${a.error.message}`);
      const t = await db.from("tests").select("test_kind, parent_test_id").limit(1);
      if (missing(t.error)) return `migration 0031 not applied (tests.test_kind: ${t.error.message})`;
      if (t.error) throw new Error(`tests probe: ${t.error.code} ${t.error.message}`);
      return null;
    })();
    return prereqP;
  }
  const ctxCache = new Map();
  state.ctxCache = ctxCache;
  /** Parent + children of a fixture, or skip() with the reason. */
  async function fixture(key) {
    const why = await migrationMissing();
    if (why) skip(why);
    const id = TESTS[key];
    if (!id) skip(`fixture ${key} missing from .omc/qa/tests.json — run: node .omc/qa/harness/fullsat-fixtures.mjs`);
    if (ctxCache.has(id)) return ctxCache.get(id);
    const { data: parent } = await db.from("tests").select("*").eq("id", id).maybeSingle();
    if (!parent || parent.test_kind !== "full_length") skip(`fixture ${key} (${id}) is not a full-length test on prod — re-run fullsat-fixtures.mjs`);
    // Never write to (due dates, grants, attempts) a test QA doesn't own.
    if (!QA_ADMIN_IDS.has(parent.created_by)) skip(`fixture ${key} (${id}) is not created by a QA admin — refusing to use it`);
    const { data: kids } = await db.from("tests").select("*").eq("parent_test_id", id);
    if ((kids ?? []).some((k) => k.created_by !== parent.created_by)) skip(`fixture ${key} has a section child not created by the same QA admin — refusing to use it`);
    if (parent.status !== "Published") skip(`fixture ${key} is ${parent.status}, not Published — re-run fullsat-fixtures.mjs`);
    const rw = (kids ?? []).find((k) => k.section_order === 1);
    const math = (kids ?? []).find((k) => k.section_order === 2);
    // A Published full-length test without both sections is a real defect.
    if (!rw || !math) fail(`Published fixture ${key} (${id}) lacks its ${rw ? "Math" : "R&W"} section child`);
    const ctx = { key, id, parent, rw, math };
    ctxCache.set(id, ctx);
    return ctx;
  }

  // ───────────────────────── DB helpers ────────────────────────────
  const ROW_COLS = "id,test_id,student_id,status,answers,metadata,started_at,submitted_at,adaptive_track,session_id,attempt_number,correct_count,total_questions,module_id";
  async function flRows(studentId, ctx) {
    const { data } = await db.from("submissions").select(ROW_COLS)
      .in("test_id", [ctx.rw.id, ctx.math.id]).eq("student_id", studentId).order("started_at", { ascending: true });
    return data ?? [];
  }
  /** This attempt's 4 slots: { rwM1, rwM2, mathM1, mathM2 } (latest attempt number). */
  function slots(rows, ctx, attemptNumber = null) {
    const n = attemptNumber ?? Math.max(1, ...rows.map((r) => r.attempt_number ?? 1));
    const of = (testId, m2) => rows.filter((r) => r.test_id === testId && (r.attempt_number ?? 1) === n && (m2 ? isM2(r.adaptive_track) : r.adaptive_track === "module_1"));
    return {
      n,
      rwM1: of(ctx.rw.id, false), rwM2: of(ctx.rw.id, true),
      mathM1: of(ctx.math.id, false), mathM2: of(ctx.math.id, true),
    };
  }
  async function attemptsOf(studentId, ctx) {
    const { data } = await db.from("full_length_attempts").select("*").eq("test_id", ctx.id).eq("student_id", studentId).order("attempt_number");
    return data ?? [];
  }
  async function waitFor(fn, ms, every = 1000) {
    const until = Date.now() + ms;
    let v;
    while (Date.now() < until) {
      v = await fn();
      if (v) return v;
      await sleep(every);
    }
    return v;
  }
  /** Delete everything a check created for this student on these full-length tests. */
  async function cleanFl(studentId, ctxs) {
    for (const ctx of ctxs) {
      await db.from("full_length_attempts").delete().eq("test_id", ctx.id).eq("student_id", studentId);
      const { data: rows } = await db.from("submissions").select("id").in("test_id", [ctx.rw.id, ctx.math.id]).eq("student_id", studentId);
      const ids = (rows ?? []).map((r) => r.id);
      if (ids.length) {
        await db.from("answer_records").delete().in("submission_id", ids);
        await db.from("submissions").delete().in("id", ids);
      }
      await db.from("test_retake_grants").delete().eq("test_id", ctx.id).eq("student_id", studentId);
      await db.from("test_time_accommodations").delete().eq("test_id", ctx.id).eq("student_id", studentId);
    }
  }
  state.cleanFl = cleanFl;
  function student(n) {
    const s = studentByN(n);
    if (!s) throw new Error(`student ${n} not found in cast.json`);
    return s;
  }
  /** Borrow STUDENT1's login for QA student n, fresh browser, clean before and after. */
  async function asStudent(n, ctxs, fn, { keep = false, fresh = true } = {}) {
    const s = student(n);
    if (fresh) await cleanFl(s.id, ctxs);
    const orig = C.students[0].id;
    await borrowLogin(s.id, STUDENT1_CLERK);
    const b = await chromium.launch();
    try {
      const { page, context } = await login(b, STUDENT1_CLERK);
      return await fn({ s, b, page, context, req: page.request });
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      if (!keep) await cleanFl(s.id, ctxs).catch(() => {});
    }
  }
  async function asUser(clerkId, fn) {
    const b = await chromium.launch();
    try {
      const { page, context } = await login(b, clerkId);
      return await fn({ b, page, context, req: page.request });
    } finally {
      await b.close().catch(() => {});
    }
  }

  // ───────────────────────── API helpers ───────────────────────────
  async function json(res, what) {
    const j = await res.json().catch(() => ({}));
    if (res.status() >= 400) throw new Error(`${what} → HTTP ${res.status()} ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }
  function pickAnswers(qs, mode) {
    if (mode === "right") return Object.fromEntries(qs.map((q) => [q.id, correctPick(q)]));
    if (mode === "wrong") return Object.fromEntries(qs.map((q) => [q.id, wrongPick(q)]));
    if (mode === "few") return Object.fromEntries(qs.slice(0, 3).map((q) => [q.id, correctPick(q)]));
    return {};
  }
  /** Two autosaves (half, then all) and a submit, through the student API. */
  async function apiModule(req, subId, mode) {
    const { data: row } = await db.from("submissions").select(ROW_COLS).eq("id", subId).single();
    if (!row) throw new Error(`no submission ${subId}`);
    const qs = await moduleQs(row.module_id);
    if (!qs.length) throw new Error(`no approved questions in module ${row.module_id}`);
    const answers = pickAnswers(qs, mode);
    const entries = Object.entries(answers);
    for (const a of [Object.fromEntries(entries.slice(0, Math.ceil(entries.length / 2))), answers]) {
      await json(await req.patch(`${BASE}/api/student/submissions/${subId}`, { data: { answers: a, metadata: {} } }), `PATCH ${row.adaptive_track}`);
    }
    const sj = await json(await req.post(`${BASE}/api/student/submissions/${subId}/submit`, { data: { answers, metadata: {} } }), `submit ${row.adaptive_track}`);
    return { row, qs, answers, nextId: sj.data?.nextSubmissionId ?? null };
  }
  /** Module 1, then the Module 2 the handoff created. */
  async function apiSection(req, m1Id, mode) {
    const m1 = await apiModule(req, m1Id, mode);
    const m2Id = m1.nextId ?? (await waitFor(async () => {
      const { data } = await db.from("submissions").select("id,adaptive_track").eq("session_id", m1.row.session_id);
      return (data ?? []).find((r) => isM2(r.adaptive_track))?.id;
    }, 15000));
    if (!m2Id) throw new Error(`no Module 2 after submitting ${m1.row.adaptive_track} of test ${m1.row.test_id}`);
    const m2 = await apiModule(req, m2Id, mode);
    return { m1, m2 };
  }
  async function flState(req, parentId) {
    const j = await json(await req.get(`${BASE}/api/student/full-length/${parentId}/state`), "state");
    return j.data ?? {};
  }
  async function flStart(req, parentId) {
    const r = await req.post(`${BASE}/api/student/full-length/${parentId}/start`, { data: {} });
    return { status: r.status(), j: await r.json().catch(() => ({})) };
  }
  async function flStartMath(req, parentId, body = {}) {
    const r = await req.post(`${BASE}/api/student/full-length/${parentId}/start-math`, { data: body });
    return { status: r.status(), j: await r.json().catch(() => ({})) };
  }
  /**
   * A whole attempt through the API: start → R&W M1/M2 → break → start-math
   * → Math M1/M2. `until`: "rw_m1" (just started), "break", "math_m1".
   */
  async function flApiTake(req, ctx, modes, until = "done") {
    const st = await flStart(req, ctx.id);
    if (st.status !== 200 && st.status !== 201) throw new Error(`full-length start → HTTP ${st.status} ${JSON.stringify(st.j).slice(0, 200)}`);
    const out = { attemptId: st.j.data?.attemptId, rwM1Id: st.j.data?.submissionId };
    if (!out.rwM1Id) throw new Error(`start returned no submission id: ${JSON.stringify(st.j).slice(0, 200)}`);
    if (until === "rw_m1") return out;
    out.rw = await apiSection(req, out.rwM1Id, modes.rw);
    out.breakState = await flState(req, ctx.id);
    if (until === "break") return out;
    const sm = await flStartMath(req, ctx.id);
    if (sm.status !== 200) throw new Error(`start-math → HTTP ${sm.status} ${JSON.stringify(sm.j).slice(0, 200)}`);
    out.mathM1Id = sm.j.data?.submissionId;
    if (until === "math_m1") return out;
    out.math = await apiSection(req, out.mathM1Id, modes.math);
    out.doneState = await flState(req, ctx.id);
    return out;
  }
  const cell = (r) => (r && DONE(r.status) ? `${r.correct_count ?? 0}/${r.total_questions ?? 0}` : null);
  /** Teacher results API row (as admin or teacher) for one student's latest attempt. */
  async function resultsRow(req, parentId, studentId) {
    const j = await json(await req.get(`${BASE}/api/teacher/tests/${parentId}/results`), "teacher results");
    const rows = (j.students ?? []).filter((r) => r.studentId === studentId).sort((a, b) => b.attemptNumber - a.attemptNumber);
    return { j, row: rows[0] ?? null };
  }

  // ───────────────────────── browser helpers ───────────────────────
  const choice = (page, letter) => page.locator(`button:has(> span:text-is("${letter}"))`).first();
  const waitTake = (page, timeout = 45000) => page.getByText(/Question \d+ of \d+/).first().waitFor({ timeout });
  const totalOf = async (page) => Number((await page.getByText(/Question \d+ of \d+/).first().innerText()).match(/of (\d+)/)[1]);
  async function submitViaUi(page) {
    const total = await totalOf(page);
    await page.getByRole("button", { name: /Question \d+ of \d+/ }).first().click();
    const nav = page.getByRole("dialog", { name: "Question Navigator" });
    await nav.getByRole("button", { name: String(total), exact: true }).first().click();
    await page.getByText(new RegExp(`Question ${total} of \\d+`)).first().waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: /Review & Submit/ }).click();
    await page.getByRole("button", { name: /Submit Test/ }).last().click({ timeout: 15000 });
  }
  async function answerFirstIfChoice(page, letter = "A") {
    const c = choice(page, letter);
    if (await c.count()) { await c.click(); return true; }
    return false;
  }
  const startModule2 = (page) => page.getByRole("link", { name: /Start Module 2/ }).or(page.getByRole("button", { name: /Start Module 2/ })).first();
  const resumeBtn = (page) => page.getByRole("button", { name: /Resume testing/ }).first();
  const bodyText = async (page) => norm(await page.locator("body").innerText().catch(() => ""));
  const BROKEN = /something went wrong|application error|NaN|undefined|Infinity/i;

  // ═════════════════════════════════════════════════════════════════
  // FL-SMOKE — section-test exam path + lists + admin PATCH/publish.
  // Needs no full-length fixture: run it within the first hour of every
  // deploy (ONLY=FL-SMOKE). Student 082 on the engLinear baseline test.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-SMOKE", [], "部署後快速檢查：一般測驗能開始、自動存檔、交卷；學生/老師/管理員測驗列表都能載入；管理員能編輯和發佈測驗", AREA, async () => {
    const T = TESTS.engLinear;
    const s = student(82);
    const notes = [];
    await deleteSubs(s.id, T);
    const orig = C.students[0].id;
    await borrowLogin(s.id, STUDENT1_CLERK);
    const b = await chromium.launch();
    try {
      const { page } = await login(b, STUDENT1_CLERK);
      const req = page.request;
      const st = await req.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const sj = await st.json().catch(() => ({}));
      if (st.status() !== 200 && st.status() !== 201) fail(`start section test → HTTP ${st.status()} ${JSON.stringify(sj).slice(0, 160)}`);
      const m1Id = sj.data?.id ?? sj.id;
      const { data: m1 } = await db.from("submissions").select("module_id").eq("id", m1Id).single();
      const qs = (await moduleQs(m1.module_id)).slice(0, 3);
      const answers = Object.fromEntries(qs.map((q) => [q.id, correctPick(q)]));
      const p = await req.patch(`${BASE}/api/student/submissions/${m1Id}`, { data: { answers, metadata: {} } });
      if (p.status() >= 400) fail(`autosave → HTTP ${p.status()}`);
      const saved = (await db.from("submissions").select("answers").eq("id", m1Id).single()).data?.answers ?? {};
      if (qs.some((q) => saved[q.id] !== answers[q.id])) fail(`autosave returned ${p.status()} but the answers were not stored`);
      const sub = await req.post(`${BASE}/api/student/submissions/${m1Id}/submit`, { data: { answers, metadata: {} } });
      const subJ = await sub.json().catch(() => ({}));
      if (sub.status() >= 400) fail(`submit Module 1 → HTTP ${sub.status()} ${JSON.stringify(subJ).slice(0, 160)}`);
      if (!subJ.data?.nextSubmissionId) fail("Module 1 submitted but no Module 2 was handed back");
      notes.push("section start/autosave/submit OK, Module 2 created");
      for (const url of ["/api/student/tests", "/student/tests", "/student"]) {
        const r = await req.get(BASE + url);
        if (r.status() !== 200) fail(`student ${url} → HTTP ${r.status()}`);
      }
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await deleteSubs(s.id, T).catch(() => {});
    }
    await asUser(TEACHER1_CLERK, async ({ req }) => {
      for (const url of ["/api/teacher/tests", "/teacher/tests"]) {
        const r = await req.get(BASE + url);
        if (r.status() !== 200) fail(`teacher ${url} → HTTP ${r.status()}`);
      }
    });
    await asUser(ADMIN_CLERK, async ({ req }) => {
      for (const url of ["/api/admin/tests", "/api/admin/tests?list=1", "/admin/tests"]) {
        const r = await req.get(BASE + url);
        if (r.status() !== 200) fail(`admin ${url} → HTTP ${r.status()}`);
      }
      // A no-op edit (same value) on a QA section test.
      const { data: t } = await db.from("tests").select("allow_retake, status").eq("id", T).single();
      const patch = await req.patch(`${BASE}/api/admin/tests/${T}`, { data: { allowRetake: Boolean(t.allow_retake) } });
      if (patch.status() !== 200) fail(`admin PATCH section test → HTTP ${patch.status()} ${(await patch.text()).slice(0, 160)}`);
      // Publish on an already Published test: runs the approval gate, then
      // refuses the state change (409 "Only Draft…"). Anything 5xx = broken.
      // Only on an already Published test, so the call can never change its state.
      if (t.status !== "Published") {
        notes.push(`lists 200; PATCH 200; publish not tried (engLinear is ${t.status})`);
      } else {
        const pub = await req.post(`${BASE}/api/admin/tests/${T}/publish`);
        const pubJ = await pub.json().catch(() => ({}));
        if (pub.status() >= 500 || pub.status() === 404) fail(`admin publish → HTTP ${pub.status()} ${JSON.stringify(pubJ).slice(0, 160)}`);
        notes.push(`lists 200; PATCH 200; publish (already Published) → ${pub.status()} ${String(pubJ.error ?? "").slice(0, 60)}`);
      }
    });
    return notes.join("; ");
  }, 6 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // Background: the four time-outs and the window close. Set up now
  // (sequential logins), then one shared wait for the prod cron.
  // ═════════════════════════════════════════════════════════════════
  const TIMEOUT_IDS = ["FL-TIMEOUT-RW-M1", "FL-TIMEOUT-RW-M2", "FL-TIMEOUT-MATH-M1", "FL-TIMEOUT-MATH-M2"];
  let bg = null; // { targets, window, waited: Promise, timeoutSkip? }
  const nearTimeout = START_MS != null && GLOBAL_TIMEOUT_MS != null && Date.now() - START_MS > GLOBAL_TIMEOUT_MS - 20 * 60 * 1000;
  if (nearTimeout && (TIMEOUT_IDS.some(wants) || wants("FL-WINDOW-CLOSE"))) {
    const why = "less than 20 min left before the nightly global timeout — time-out / window checks not started";
    bg = { targets: {}, timeoutSkip: why, window: { skip: why }, waited: Promise.resolve() };
  } else if (TIMEOUT_IDS.some(wants) || wants("FL-WINDOW-CLOSE")) {
    bg = await (async () => {
      const out = { targets: {}, window: null };
      // Time-outs on flShort (2-minute modules): students 090-093.
      if (TIMEOUT_IDS.some(wants)) {
        let ctx;
        try { ctx = await fixture("flShort"); } catch (e) { if (e.__skip) out.timeoutSkip = e.__details; else out.timeoutError = e.message; }
        if (ctx) {
          const plan = [
            ["FL-TIMEOUT-RW-M1", 90, "rw_m1"], ["FL-TIMEOUT-RW-M2", 91, "rw_m2"],
            ["FL-TIMEOUT-MATH-M1", 92, "math_m1"], ["FL-TIMEOUT-MATH-M2", 93, "math_m2"],
          ];
          for (const [id, n, where] of plan) {
            if (!wants(id)) continue;
            out.targets[id] = await setupTimeout(ctx, n, where).catch((e) => ({ error: String(e.message ?? e).slice(0, 400), n, ctx }));
          }
        }
      }
      if (wants("FL-WINDOW-CLOSE")) {
        let ctx;
        try { ctx = await fixture("flWindow"); } catch (e) { out.window = e.__skip ? { skip: e.__details } : { error: e.message }; }
        if (ctx) out.window = await setupWindowClose(ctx).catch((e) => ({ error: String(e.message ?? e).slice(0, 400), ctx }));
      }
      out.waited = waitForCron(out).catch((e) => { out.waitError = String(e.message ?? e); });
      return out;
    })();
  }

  /** Leave one module of an attempt In Progress (with answers), backdated past limit + the cron grace. */
  async function setupTimeout(ctx, n, where) {
    const s = student(n);
    return asStudent(n, [ctx], async ({ req }) => {
      const minutes = (child, m2) => (m2 ? child.time_limit_minutes_module_2 ?? child.time_limit_minutes : child.time_limit_minutes) ?? 2;
      const ago = (min) => new Date(Date.now() - (min + 7) * 60000).toISOString();
      const keep = async (subId) => {
        const { data: row } = await db.from("submissions").select(ROW_COLS).eq("id", subId).single();
        const qs = (await moduleQs(row.module_id)).slice(0, 3);
        const answers = Object.fromEntries(qs.map((q) => [q.id, correctPick(q)]));
        await json(await req.patch(`${BASE}/api/student/submissions/${subId}`, { data: { answers, metadata: {} } }), "PATCH before time-out");
        return { row, answers };
      };
      const backdateM2 = async (id, iso) => {
        const { data } = await db.from("submissions").select("metadata").eq("id", id).single();
        await db.from("submissions").update({ metadata: { ...(data?.metadata ?? {}), module_2_started_at: iso } }).eq("id", id);
      };
      let target;
      if (where === "rw_m1") {
        const a = await flApiTake(req, ctx, {}, "rw_m1");
        target = await keep(a.rwM1Id);
        await db.from("submissions").update({ started_at: ago(minutes(ctx.rw, false)) }).eq("id", a.rwM1Id);
      } else if (where === "rw_m2") {
        const a = await flApiTake(req, ctx, {}, "rw_m1");
        const m1 = await apiModule(req, a.rwM1Id, "few");
        target = await keep(m1.nextId);
        await backdateM2(m1.nextId, ago(minutes(ctx.rw, true)));
      } else if (where === "math_m1") {
        const a = await flApiTake(req, ctx, { rw: "few" }, "math_m1");
        target = await keep(a.mathM1Id);
        await db.from("submissions").update({ started_at: ago(minutes(ctx.math, false)) }).eq("id", a.mathM1Id);
      } else {
        const a = await flApiTake(req, ctx, { rw: "few" }, "math_m1");
        const m1 = await apiModule(req, a.mathM1Id, "few");
        target = await keep(m1.nextId);
        await backdateM2(m1.nextId, ago(minutes(ctx.math, true)));
      }
      return { n, s, ctx, where, subId: target.row.id, answers: target.answers, backdatedAt: Date.now() };
    }, { keep: true });
  }

  /** On the break past due + 24 h: the cron must close the attempt ('math_not_started'). Student 094. */
  async function setupWindowClose(ctx) {
    await db.from("tests").update({ due_date: null }).eq("id", ctx.id); // a crashed run may have left it past due
    const n = 94;
    const s = student(n);
    return asStudent(n, [ctx], async ({ req }) => {
      const a = await flApiTake(req, ctx, { rw: "few" }, "break");
      if (a.breakState.state !== "break") throw new Error(`after R&W the state is ${a.breakState.state}, expected break`);
      const rwM2 = a.rw.m2.row.id;
      // Due date passed, and R&W Module 2 graded more than 24 h ago.
      await db.from("tests").update({ due_date: new Date(Date.now() - 5 * 60000).toISOString() }).eq("id", ctx.id);
      await db.from("submissions").update({ submitted_at: new Date(Date.now() - 25 * 3600000).toISOString() }).eq("id", rwM2);
      return { n, s, ctx, attemptId: a.attemptId, backdatedAt: Date.now() };
    }, { keep: true });
  }

  /** One shared wait (≤ 7 min) until every backdated module is graded and the window attempt is closed. */
  async function waitForCron(out) {
    const pending = () => {
      const subIds = Object.values(out.targets).filter((t) => t.subId).map((t) => t.subId);
      return { subIds, attemptId: out.window?.attemptId ?? null };
    };
    const { subIds, attemptId } = pending();
    if (!subIds.length && !attemptId) return;
    await waitFor(async () => {
      const { data: rows } = subIds.length ? await db.from("submissions").select("id,status").in("id", subIds) : { data: [] };
      const graded = (rows ?? []).filter((r) => r.status !== "In Progress").length === subIds.length;
      let closed = true;
      if (attemptId) closed = Boolean((await db.from("full_length_attempts").select("closed_at").eq("id", attemptId).maybeSingle()).data?.closed_at);
      return graded && closed;
    }, CRON_WAIT_MS, 10000);
    await sleep(5000); // let a handoff right after grading land
  }

  // ═════════════════════════════════════════════════════════════════
  // FL-API-HIGH / LOW / MIXED — both sections route independently.
  // ═════════════════════════════════════════════════════════════════
  const apiPaths = [
    ["FL-API-HIGH", 83, { rw: "right", math: "right" }, { rw: "module_2_hard", math: "module_2_hard" }, "高分路線：英文、數學都全對 → 兩科第二模組都是難版，總分 = 英文 + 數學"],
    ["FL-API-LOW", 84, { rw: "wrong", math: "wrong" }, { rw: "module_2_easy", math: "module_2_easy" }, "低分路線：英文、數學都全錯 → 兩科第二模組都是簡單版，總分 = 英文 + 數學"],
    ["FL-API-MIXED", 85, { rw: "right", math: "wrong" }, { rw: "module_2_hard", math: "module_2_easy" }, "混合路線：英文全對、數學全錯 → 英文難版、數學簡單版（兩科各自分流）"],
  ];
  for (const [id, n, modes, tracks, title] of apiPaths) {
    await check(id, [], `整份 SAT（API）${title}`, AREA, async () => {
      const ctx = await fixture("flFullLength");
      return asStudent(n, [ctx], async ({ s, req }) => {
        const a = await flApiTake(req, ctx, modes);
        const problems = [];
        if (a.breakState.state !== "break") problems.push(`after R&W the state is ${a.breakState.state}, expected break`);
        if (a.doneState.state !== "done") problems.push(`after Math the state is ${a.doneState.state}, expected done`);
        const sl = slots(await flRows(s.id, ctx), ctx);
        for (const k of ["rwM1", "rwM2", "mathM1", "mathM2"]) if (sl[k].length !== 1) problems.push(`${sl[k].length} ${k} rows (expected 1)`);
        if (sl.rwM2[0]?.adaptive_track !== tracks.rw) problems.push(`R&W Module 2 is ${sl.rwM2[0]?.adaptive_track}, expected ${tracks.rw}`);
        if (sl.mathM2[0]?.adaptive_track !== tracks.math) problems.push(`Math Module 2 is ${sl.mathM2[0]?.adaptive_track}, expected ${tracks.math}`);
        for (const k of ["rwM1", "rwM2", "mathM1", "mathM2"]) if (sl[k][0] && !DONE(sl[k][0].status)) problems.push(`${k} is ${sl[k][0].status}`);
        const meta = sl.mathM2[0]?.metadata ?? {};
        if (meta.fl_attempt_id !== a.attemptId) problems.push(`Math Module 2 metadata.fl_attempt_id ${meta.fl_attempt_id} ≠ attempt ${a.attemptId}`);
        const { row } = await asUser(ADMIN_CLERK, ({ req: areq }) => resultsRow(areq, ctx.id, s.id));
        if (!row) problems.push("the attempt is missing from the teacher results API");
        else {
          if (row.total == null || row.total !== (row.rw?.sat ?? NaN) + (row.math?.sat ?? NaN)) problems.push(`total ${row.total} ≠ R&W ${row.rw?.sat} + Math ${row.math?.sat}`);
          if (!(row.total >= 400 && row.total <= 1600)) problems.push(`total ${row.total} outside 400–1600`);
          const want = { rw: [cell(sl.rwM1[0]), cell(sl.rwM2[0])], math: [cell(sl.mathM1[0]), cell(sl.mathM2[0])] };
          for (const sec of ["rw", "math"]) {
            const got = [row[sec]?.module1, row[sec]?.module2];
            if (got[0] !== want[sec][0] || got[1] !== want[sec][1]) problems.push(`${sec} modules ${got.join(" / ")} on the results API, ${want[sec].join(" / ")} in the database`);
          }
        }
        if (problems.length) fail(problems.join("; "));
        return `R&W ${sl.rwM2[0].adaptive_track} ${row.rw.sat} (${row.rw.module1}, ${row.rw.module2}) + Math ${sl.mathM2[0].adaptive_track} ${row.math.sat} (${row.math.module1}, ${row.math.module2}) = ${row.total}`;
      });
    }, 5 * 60 * 1000);
  }

  // ═════════════════════════════════════════════════════════════════
  // FL-BROWSER-FULL — the real UI through all four modules (flShort).
  // ═════════════════════════════════════════════════════════════════
  await check("FL-BROWSER-FULL", [], "整份 SAT（瀏覽器）：英文模組1 → 模組2 → 休息（時間到自動開始數學）→ 數學模組1 → 模組2 → 成績頁顯示總分 400–1600、各模組 x/27、x/22", AREA, async () => {
    const ctx = await fixture("flShort");
    return asStudent(86, [ctx], async ({ s, page }) => {
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 120)));
      await page.goto(`${BASE}/student/tests/${ctx.id}`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /Start Test/ }).click({ timeout: 30000 });
      await page.waitForURL(/\/sat/, { timeout: 45000, waitUntil: "commit" });
      const steps = [];
      // R&W Module 1
      await waitTake(page);
      await answerFirstIfChoice(page, "A");
      await sleep(2500); // autosave
      await submitViaUi(page);
      await page.getByText(/Module 1 submitted/).first().waitFor({ timeout: 45000 });
      steps.push("R&W M1 → Module 2 intro");
      await startModule2(page).click();
      await waitTake(page);
      await answerFirstIfChoice(page, "A");
      await sleep(2500);
      await submitViaUi(page);
      await page.getByText(/take a break/).first().waitFor({ timeout: 45000 });
      steps.push("R&W M2 → break screen");
      // Pausing off: the open break screen starts Math by itself at 0:00.
      await waitTake(page, ((ctx.parent.break_minutes ?? 1) * 60 + 60) * 1000);
      let sl = slots(await flRows(s.id, ctx), ctx);
      const breakEnds = Date.parse(sl.rwM2[0].submitted_at) + (ctx.parent.break_minutes ?? 1) * 60000;
      const mathStart = Date.parse(sl.mathM1[0]?.started_at ?? 0);
      if (!sl.mathM1[0]) fail(`break screen moved on but there is no Math Module 1 row. ${steps.join("; ")}`);
      if (!Number.isFinite(mathStart) || !Number.isFinite(breakEnds)) fail(`can't read the break end / Math start times (${sl.rwM2[0]?.submitted_at} / ${sl.mathM1[0]?.started_at})`);
      if (mathStart < breakEnds - 3000) fail(`Math started ${Math.round((breakEnds - mathStart) / 1000)} s before the break ended`);
      steps.push(`break auto-started Math ${Math.round((mathStart - breakEnds) / 1000)} s after 0:00`);
      await answerFirstIfChoice(page, "A");
      await sleep(2500);
      await submitViaUi(page);
      await page.getByText(/Module 1 submitted/).first().waitFor({ timeout: 45000 });
      await startModule2(page).click();
      await waitTake(page);
      await answerFirstIfChoice(page, "A");
      await sleep(2500);
      await submitViaUi(page);
      await page.waitForURL((u) => !/\/sat/.test(u.pathname), { timeout: 45000 });
      steps.push("Math M1 → M2 → finished");
      await page.goto(`${BASE}/student/tests/${ctx.id}/result`, { waitUntil: "networkidle" });
      const text = await bodyText(page);
      sl = slots(await flRows(s.id, ctx), ctx);
      const problems = [];
      for (const k of ["rwM1", "rwM2", "mathM1", "mathM2"]) {
        if (sl[k].length !== 1 || !DONE(sl[k][0].status)) problems.push(`${k}: ${sl[k].map((r) => r.status).join(",") || "missing"}`);
        else if (!text.includes(cell(sl[k][0]))) problems.push(`result page doesn't show ${k} ${cell(sl[k][0])}`);
      }
      const total = Number((text.match(/(\d{3,4})\/1600/) ?? [])[1]);
      if (!(total >= 400 && total <= 1600)) problems.push(`result page total "${(text.match(/\S+\/1600/) ?? ["none"])[0]}"`);
      if (BROKEN.test(text)) problems.push(`result page shows "${text.match(BROKEN)[0]}"`);
      if (pageErrors.length) problems.push(`page errors: ${pageErrors.join(" | ")}`);
      if (problems.length) fail(`${problems.join("; ")}. ${steps.join("; ")}`);
      return `${steps.join("; ")}; result ${total}/1600, ${["rwM1", "rwM2", "mathM1", "mathM2"].map((k) => cell(sl[k][0])).join(" · ")}`;
    });
  }, 10 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-BREAK-LEAVE — leave during the break (pausing off), come back
  // mid-break (countdown not reset) and after it (no clock ran).
  // ═════════════════════════════════════════════════════════════════
  await check("FL-BREAK-LEAVE", [], "休息時離開（不允許暫停的設定）：中途回來倒數沒有重來；休息結束後才回來顯示「休息結束」，數學在按「繼續作答」前不會開始計時，按了之後有完整時間", AREA, async () => {
    const ctx = await fixture("flFullLength");
    return asStudent(87, [ctx], async ({ s, page, context, req }) => {
      const a = await flApiTake(req, ctx, { rw: "few" }, "break");
      const rwM2 = a.rw.m2.row.id;
      const submittedAt = Date.parse((await db.from("submissions").select("submitted_at").eq("id", rwM2).single()).data.submitted_at);
      const breakSec = (ctx.parent.break_minutes ?? 10) * 60;
      await context.close(); // leave
      await sleep(15000);
      const problems = [];
      // Back mid-break.
      const b2 = await chromium.launch();
      try {
        const { page: p2 } = await login(b2, STUDENT1_CLERK);
        await p2.goto(`${BASE}/student/tests/${ctx.id}/sat`, { waitUntil: "networkidle" });
        await p2.getByText(/take a break/).first().waitFor({ timeout: 30000 });
        const st = await flState(p2.request, ctx.id);
        const expected = breakSec - (Date.parse(st.now) - submittedAt) / 1000;
        if (st.state !== "break") problems.push(`mid-break state ${st.state}`);
        if (!Number.isFinite(st.breakRemainingSeconds) || !Number.isFinite(expected)) problems.push(`mid-break time unreadable (left ${st.breakRemainingSeconds}, expected ${expected})`);
        else if (Math.abs(st.breakRemainingSeconds - expected) > 5) problems.push(`mid-break ${st.breakRemainingSeconds}s left, expected ≈${Math.round(expected)}s (countdown reset?)`);
        // Gone past the end of the break.
        await p2.close();
        await db.from("submissions").update({ submitted_at: new Date(Date.now() - (breakSec + 60) * 1000).toISOString() }).eq("id", rwM2);
        const p3 = await p2.context().newPage();
        await p3.goto(`${BASE}/student/tests/${ctx.id}/sat`, { waitUntil: "networkidle" });
        await p3.getByText(/Break over/).first().waitFor({ timeout: 30000 });
        await sleep(6000);
        let sl = slots(await flRows(s.id, ctx), ctx);
        if (sl.mathM1.length) problems.push("Math Module 1 was created before Resume testing (a clock ran while the student was away)");
        const clickAt = Date.now();
        await resumeBtn(p3).click();
        await waitTake(p3);
        sl = slots(await flRows(s.id, ctx), ctx);
        const m = sl.mathM1[0];
        if (!m) problems.push("no Math Module 1 after Resume testing");
        else {
          if (!Number.isFinite(Date.parse(m.started_at))) problems.push(`Math started_at unreadable (${m.started_at})`);
          else if (Math.abs(Date.parse(m.started_at) - clickAt) > 20000) problems.push(`Math started_at is ${Math.round((Date.parse(m.started_at) - clickAt) / 1000)} s from the click`);
          const rem = (await json(await p3.request.get(`${BASE}/api/student/submissions/${m.id}?status=1`), "status")).data?.remainingSeconds;
          const full = (ctx.math.time_limit_minutes ?? 35) * 60;
          if (!Number.isFinite(rem) || !(rem > full - 45)) problems.push(`Math has ${rem}s left right after Resume, expected ≈${full}s`);
        }
        if (problems.length) fail(problems.join("; "));
        return `mid-break ${st.breakRemainingSeconds}s left (≈${Math.round(expected)}s expected); after the break: "Break over", no Math row until Resume, then full Math time`;
      } finally {
        await b2.close().catch(() => {});
      }
    });
  }, 6 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-BREAK-RESUME-EARLY — Resume at ~20 s into a 10-min break.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-BREAK-RESUME-EARLY", [], "休息 20 秒就按「繼續作答」：數學馬上開始，計時從按下那一刻起算、時間完整", AREA, async () => {
    const ctx = await fixture("flFullLength");
    return asStudent(88, [ctx], async ({ s, page, req }) => {
      await flApiTake(req, ctx, { rw: "few" }, "break");
      await page.goto(`${BASE}/student/tests/${ctx.id}/sat`, { waitUntil: "networkidle" });
      await page.getByText(/take a break/).first().waitFor({ timeout: 30000 });
      await sleep(20000);
      const st = await flState(req, ctx.id);
      const clickAt = Date.now();
      await resumeBtn(page).click();
      await waitTake(page);
      const m = slots(await flRows(s.id, ctx), ctx).mathM1[0];
      const problems = [];
      if (!m) fail("no Math Module 1 after Resume testing");
      if (!Number.isFinite(st.breakRemainingSeconds) || !(st.breakRemainingSeconds > 60)) problems.push(`break had only ${st.breakRemainingSeconds}s left at the click (test setup)`);
      if (!Number.isFinite(Date.parse(m.started_at))) problems.push(`Math started_at unreadable (${m.started_at})`);
      else if (Math.abs(Date.parse(m.started_at) - clickAt) > 20000) problems.push(`Math started_at ${Math.round((Date.parse(m.started_at) - clickAt) / 1000)} s from the click`);
      const rem = (await json(await req.get(`${BASE}/api/student/submissions/${m.id}?status=1`), "status")).data?.remainingSeconds;
      const full = (ctx.math.time_limit_minutes ?? 35) * 60;
      if (!Number.isFinite(rem) || !(rem > full - 45)) problems.push(`Math has ${rem}s left, expected ≈${full}s`);
      if (problems.length) fail(problems.join("; "));
      return `resumed with ${st.breakRemainingSeconds}s of break left; Math started at the click with ${rem}s`;
    });
  }, 4 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-BREAK-PAUSE — pausing allowed: no auto start at 0:00.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-BREAK-PAUSE", [], "允許暫停的設定：休息畫面說可以離開稍後再回來；倒數到 0 不會自動開始數學，要按「繼續作答」", AREA, async () => {
    const ctx = await fixture("flPause");
    return asStudent(89, [ctx], async ({ s, page, req }) => {
      const a = await flApiTake(req, ctx, { rw: "few" }, "break");
      await page.goto(`${BASE}/student/tests/${ctx.id}/sat`, { waitUntil: "networkidle" });
      await page.getByText(/take a break|Break over/).first().waitFor({ timeout: 30000 });
      const problems = [];
      const left = (await flState(req, ctx.id)).breakRemainingSeconds ?? 0;
      if (left > 5 && !(await bodyText(page)).includes("continue later")) problems.push(`break screen doesn't say the student may leave and continue later`);
      await sleep((left + 12) * 1000); // past 0:00 with the screen open
      if (!(await page.getByText(/Break over/).first().isVisible().catch(() => false))) problems.push(`after 0:00 the page is not on "Break over" (url ${page.url().slice(-50)})`);
      if (slots(await flRows(s.id, ctx), ctx).mathM1.length) problems.push("Math Module 1 started automatically at 0:00 although pausing is allowed");
      const auto = await flStartMath(req, ctx.id, { auto: true });
      if (auto.status !== 409) problems.push(`start-math {auto:true} with pausing on → HTTP ${auto.status} (expected 409)`);
      await resumeBtn(page).click();
      await waitTake(page);
      if (!slots(await flRows(s.id, ctx), ctx).mathM1.length) problems.push("no Math Module 1 after Resume testing");
      if (problems.length) fail(problems.join("; "));
      return `"continue later" shown; no auto start ${left + 12}s later; auto start-math → 409; Resume → Math (attempt ${a.attemptId.slice(0, 8)})`;
    });
  }, 5 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-EXTENDED — ×1.5 accommodation: 48 min server clock, autosave 409
  // only after 48 min + grace, carried into Module 2.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-EXTENDED", [], "延長時間 ×1.5：英文模組 32 分鐘變 48 分鐘（伺服器倒數、自動存檔的截止都照 48 分鐘＋寬限），第二模組也延長", AREA, async () => {
    const ctx = await fixture("flFullLength");
    const s = student(95);
    return asStudent(95, [ctx], async ({ req }) => {
      // After asStudent's clean (which also removes accommodations).
      await asUser(ADMIN_CLERK, async ({ req: areq }) => {
        await json(await areq.put(`${BASE}/api/admin/tests/${ctx.id}/accommodations`, { data: { studentId: s.id, multiplier: 1.5 } }), "set ×1.5");
      });
      const a = await flApiTake(req, ctx, {}, "rw_m1");
      const problems = [];
      const [att] = await attemptsOf(s.id, ctx);
      if (Number(att?.time_multiplier) !== 1.5) problems.push(`attempt time_multiplier ${att?.time_multiplier}`);
      const { data: m1 } = await db.from("submissions").select(ROW_COLS).eq("id", a.rwM1Id).single();
      if (Number(m1.metadata?.time_multiplier) !== 1.5) problems.push(`R&W Module 1 metadata.time_multiplier ${m1.metadata?.time_multiplier}`);
      const limit = Math.round((ctx.rw.time_limit_minutes ?? 32) * 1.5 * 60);
      const rem = (await json(await req.get(`${BASE}/api/student/submissions/${a.rwM1Id}?status=1`), "status")).data?.remainingSeconds;
      if (!Number.isFinite(rem) || Math.abs(rem - limit) > 30) problems.push(`server says ${rem}s left, expected ≈${limit}s (×1.5)`);
      const GRACE = 60;
      const save = async (elapsed) => {
        await db.from("submissions").update({ started_at: new Date(Date.now() - elapsed * 1000).toISOString() }).eq("id", a.rwM1Id);
        return (await req.patch(`${BASE}/api/student/submissions/${a.rwM1Id}`, { data: { answers: {}, metadata: {} } })).status();
      };
      const before = await save(limit + GRACE - 90);
      const after = await save(limit + GRACE + 90);
      if (before !== 200) problems.push(`autosave ${Math.round((limit + GRACE - 90) / 60)} min in → HTTP ${before} (expected 200 with ×1.5)`);
      if (after !== 409) problems.push(`autosave after ${Math.round((limit + GRACE + 90) / 60)} min → HTTP ${after} (expected 409)`);
      // Module 2 inherits the multiplier.
      await db.from("submissions").update({ started_at: new Date().toISOString() }).eq("id", a.rwM1Id);
      const m1Done = await apiModule(req, a.rwM1Id, "few");
      const { data: m2 } = await db.from("submissions").select(ROW_COLS).eq("id", m1Done.nextId).single();
      if (Number(m2?.metadata?.time_multiplier) !== 1.5) problems.push(`R&W Module 2 metadata.time_multiplier ${m2?.metadata?.time_multiplier} (not carried)`);
      const rem2 = (await json(await req.get(`${BASE}/api/student/submissions/${m1Done.nextId}?status=1`), "status")).data?.remainingSeconds;
      const limit2 = Math.round((ctx.rw.time_limit_minutes_module_2 ?? ctx.rw.time_limit_minutes ?? 32) * 1.5 * 60);
      if (!Number.isFinite(rem2) || Math.abs(rem2 - limit2) > 30) problems.push(`Module 2 shows ${rem2}s, expected ≈${limit2}s`);
      if (problems.length) fail(problems.join("; "));
      return `×1.5: ${rem}s on M1 (≈${limit}), autosave ${before} before / ${after} after ${limit / 60} min + grace, M2 ${rem2}s`;
    });
  }, 5 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-RETAKE — a grant on the parent gives attempt 2 on both sections.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-RETAKE", [], "重考：老師給重考後，第二次作答兩科都是第 2 次；重考權只用掉一次；等待重考時答案先不顯示", AREA, async () => {
    const ctx = await fixture("flFullLength");
    if (ctx.parent.allow_retake) skip("flFullLength allows retakes for everyone; the grant path can't be checked (re-create the fixture with allowRetake false)");
    return asStudent(99, [ctx], async ({ s, req }) => {
      const a1 = await flApiTake(req, ctx, { rw: "few", math: "few" });
      const problems = [];
      const visible = async () => {
        const j = await json(await req.get(`${BASE}/api/student/submissions/${a1.rwM1Id}/result`), "result");
        return Array.isArray(j.data?.answerDetails) && j.data.answerDetails.length > 0;
      };
      const shownAfter1 = await visible();
      if (ctx.parent.show_answers_after_submission && !shownAfter1) problems.push("answers hidden after a finished attempt although the test shows answers");
      const refused = await flStart(req, ctx.id);
      if (refused.status !== 403) problems.push(`second attempt without a grant → HTTP ${refused.status} (expected 403)`);
      await asUser(ADMIN_CLERK, async ({ req: areq }) => {
        await json(await areq.post(`${BASE}/api/admin/tests/${ctx.id}/grant-retake`, { data: { studentId: s.id } }), "grant retake");
      });
      if (await visible()) problems.push("answers still shown while a retake is pending");
      const [st1, st2] = [await flStart(req, ctx.id), await flStart(req, ctx.id)];
      if (st1.status !== 201) problems.push(`start with a grant → HTTP ${st1.status} (expected 201)`);
      if (st2.status !== 200 || st2.j.data?.attemptId !== st1.j.data?.attemptId) problems.push(`second click → HTTP ${st2.status}, attempt ${st2.j.data?.attemptId?.slice(0, 8)} (expected the same attempt, 200)`);
      const atts = await attemptsOf(s.id, ctx);
      if (atts.length !== 2 || atts[1].attempt_number !== 2) problems.push(`attempts: ${atts.map((x) => x.attempt_number).join(",")}`);
      const { data: grants } = await db.from("test_retake_grants").select("consumed_at").eq("test_id", ctx.id).eq("student_id", s.id);
      if ((grants ?? []).filter((g) => g.consumed_at).length !== 1) problems.push(`${(grants ?? []).filter((g) => g.consumed_at).length} grants consumed (expected 1)`);
      await apiSection(req, st1.j.data.submissionId, "few");
      const sm = await flStartMath(req, ctx.id);
      const rows = await flRows(s.id, ctx);
      const two = slots(rows, ctx, 2);
      if (two.rwM1.length !== 1 || two.rwM2.length !== 1 || two.mathM1.length !== 1) problems.push(`attempt 2 rows: R&W M1 ${two.rwM1.length}, R&W M2 ${two.rwM2.length}, Math M1 ${two.mathM1.length} (start-math ${sm.status})`);
      if (problems.length) fail(problems.join("; "));
      return `attempt 1 answers ${shownAfter1 ? "shown" : "hidden (test hides answers)"}; no-grant start 403; grant → hidden, attempt 2 on both sections, 1 grant consumed`;
    });
  }, 6 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-SUBJECT-TEACHER — Math-only teacher (TEST Teacher 01, class A).
  // ═════════════════════════════════════════════════════════════════
  await check("FL-SUBJECT-TEACHER", [], "只教數學的老師：看得到整份 SAT 和總分、數學欄位；看不到英文模組明細（英文分析、標記題目都被擋），CSV 沒有英文欄位", AREA, async () => {
    const ctx = await fixture("flFullLength");
    return asStudent(96, [ctx], async ({ s, req }) => {
      await flApiTake(req, ctx, { rw: "right", math: "wrong" });
      const rwQ = (await moduleQs(ctx.rw.module_1_id ?? ctx.rw.module_id))[0];
      return asUser(TEACHER1_CLERK, async ({ req: t }) => {
        const problems = [];
        const list = await json(await t.get(`${BASE}/api/teacher/tests`), "teacher tests");
        if (!JSON.stringify(list).includes(ctx.id)) problems.push("the full-length test is not in the Math teacher's list");
        const { j, row } = await resultsRow(t, ctx.id, s.id);
        if (!(j.scope?.math === true && j.scope?.rw === false)) problems.push(`results scope ${JSON.stringify(j.scope)} (expected Math only)`);
        if (!row) problems.push("class A student's attempt missing from the Math teacher's results");
        else {
          if (row.rw !== null) problems.push("R&W section detail sent to a Math-only teacher");
          if (!row.math || row.total == null) problems.push(`Math ${JSON.stringify(row.math)?.slice(0, 80)} / total ${row.total}`);
        }
        const rwA = (await t.get(`${BASE}/api/teacher/tests/${ctx.rw.id}/analytics`)).status();
        const mathA = (await t.get(`${BASE}/api/teacher/tests/${ctx.math.id}/analytics`)).status();
        if (rwA !== 403) problems.push(`R&W section analytics → HTTP ${rwA} (expected 403)`);
        if (mathA !== 200) problems.push(`Math section analytics → HTTP ${mathA} (expected 200)`);
        // Invalid note type: refused at the access check (403) before any write; 400 = access let through.
        const flag = (await t.post(`${BASE}/api/teacher/tests/${ctx.rw.id}/questions/${rwQ.id}/flag`, { data: { note_type: "qa-invalid" } })).status();
        if (flag !== 403) problems.push(`R&W question flag route → HTTP ${flag} (expected 403)`);
        const csvRes = await t.get(`${BASE}/api/teacher/tests/${ctx.id}/export`);
        const header = parseCsv((await csvRes.text()).replace(/^﻿/, ""))[0] ?? [];
        if (csvRes.status() !== 200) problems.push(`CSV → HTTP ${csvRes.status()}`);
        const rwCols = header.filter((h) => /^R&W|^RW /.test(h));
        if (rwCols.length) problems.push(`CSV has R&W columns: ${rwCols.slice(0, 4).join(", ")}`);
        if (!header.includes("Total (400–1600)") || !header.includes("Math M1 Correct")) problems.push(`CSV header lacks Total / Math columns: ${header.slice(0, 10).join("|")}`);
        if (problems.length) fail(problems.join("; "));
        return `Math-only scope; total ${row.total}, Math ${row.math.sat}; R&W analytics 403, flag 403; CSV ${header.length} columns, no R&W`;
      });
    });
  }, 5 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-NO-LEAK — hidden section children never listed anywhere.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-NO-LEAK", [], "整份 SAT 的隱藏分科測驗（英文／數學子測驗）不會出現在管理員、老師、學生的任何列表或指派選單裡", AREA, async () => {
    const ctx = await fixture("flFullLength");
    const all = [];
    for (const key of ["flFullLength", "flShort", "flPause", "flWindow"]) {
      try { all.push(await fixture(key)); } catch (e) { if (!e.__skip) throw e; }
    }
    const kids = all.flatMap((c) => [c.rw, c.math]);
    const s = student(97);
    const classOf = C.classes.find((k) => k.name === `TEST Class ${s.class}`);
    // Child as a list entry: its own page link, or a JSON object with its id / exact name.
    // (A child's id inside a deeper link, e.g. a section result
    // /tests/<child>/results/<sub>, is legitimate and not matched.)
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const leaks = (where, body, isApi) => {
      const found = [];
      for (const k of kids) {
        const href = new RegExp(`/(student|teacher|admin)/tests/${k.id}(?=["'?#\\\\]|$)`);
        const idKey = new RegExp(`"(id|testId)"\\s*:\\s*"${k.id}"`);
        const nameKey = new RegExp(`\\\\?"(test_name|testName)\\\\?"\\s*:\\s*\\\\?"${esc(k.test_name)}\\\\?"`);
        if (href.test(body) || nameKey.test(body) || (isApi && idKey.test(body))) found.push(`${where}: ${k.test_name}`);
      }
      return found;
    };
    return asStudent(97, [ctx], async ({ req }) => {
      await flApiTake(req, ctx, { rw: "few" }, "break"); // on the break: the remap paths are live
      const found = [];
      const scan = async (r, who, urls) => {
        for (const u of urls) {
          const res = await r.get(BASE + u);
          if (res.status() >= 400) { found.push(`${who} ${u} → HTTP ${res.status()}`); continue; }
          found.push(...leaks(`${who} ${u}`, await res.text(), u.startsWith("/api/")));
        }
      };
      await scan(req, "student", ["/api/student/tests", "/student/tests", "/student", "/student/results"]);
      await asUser(TEACHER1_CLERK, ({ req: t }) => scan(t, "teacher", ["/api/teacher/tests", "/teacher/tests", "/teacher", "/api/teacher/teaching-mode/test-review", "/api/teacher/teaching-mode/cohorts"]));
      await asUser(ADMIN_CLERK, ({ req: a }) => scan(a, "admin", [
        "/api/admin/tests", "/api/admin/tests?list=1", "/admin/tests", "/admin/tests/new",
        "/admin/analytics/class-groups", `/admin/classes/${classOf?.id}`, `/admin/students/${s.id}`,
      ]));
      if (found.length) fail(found.slice(0, 8).join("; "));
      return `${kids.length} section children checked on 16 student/teacher/admin lists and pickers: none listed`;
    });
  }, 6 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-LIVE-GUARD — the bank tools' live-question guard sees the
  // children's questions as live (through the parent). Read-only.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-LIVE-GUARD", [], "題庫保護：整份 SAT 裡的題目算「考試中」，自動工具不會在考試時把題目下架", AREA, async () => {
    const ctx = await fixture("flFullLength");
    const problems = [];
    for (const k of [ctx.rw, ctx.math]) {
      if (k.status !== ctx.parent.status) problems.push(`${k.test_name} is ${k.status}, parent ${ctx.parent.status}`);
      const { data: own } = await db.from("test_assignments").select("test_id").eq("test_id", k.id);
      if ((own ?? []).length) problems.push(`${k.test_name} has its own assignment row (should live on the parent only)`);
    }
    const modIds = [ctx.rw, ctx.math].flatMap((k) => [k.module_1_id, k.module_2_easy_id, k.module_2_hard_id, k.module_id, k.module_2_id]).filter(Boolean);
    const ids = [];
    for (const m of [...new Set(modIds)]) ids.push(...(await moduleQs(m)).slice(0, 3).map((q) => q.id));
    const out = execFileSync(`${APP_ROOT}node_modules/.bin/tsx`, [`${HERE}fl-live.ts`], {
      cwd: APP_ROOT, input: JSON.stringify({ ids }), timeout: 90000, env: process.env,
    }).toString();
    const live = new Set(JSON.parse(out));
    const notLive = ids.filter((id) => !live.has(id));
    if (notLive.length) problems.push(`${notLive.length}/${ids.length} questions of the sections are not counted as live`);
    // How many are live only through the full-length test (no other Published test serves their module).
    const { data: others } = await db.from("tests").select("id,module_id,module_2_id,module_1_id,module_2_easy_id,module_2_hard_id,parent_test_id").eq("status", "Published").is("parent_test_id", null);
    const elsewhere = new Set((others ?? []).flatMap((t) => [t.module_id, t.module_2_id, t.module_1_id, t.module_2_easy_id, t.module_2_hard_id]).filter(Boolean));
    const onlyFl = [...new Set(modIds)].filter((m) => !elsewhere.has(m)).length;
    if (problems.length) fail(problems.join("; "));
    return `${ids.length} sampled questions of ${new Set(modIds).size} modules all live; children Published with the parent, no own assignments; ${onlyFl} module(s) served only by full-length tests`;
  }, 3 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // FL-PRINT — blank test + key in exam order with the Math divider;
  // a section test's print is unchanged.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-PRINT", [], "整份 SAT 列印（空白卷、答案卷）：英文模組1、第二模組簡單版、困難版 →「Section 2: Math」分隔頁 → 數學；題數和答案都對；一般測驗列印不變", AREA, async () => {
    const ctx = await fixture("flFullLength");
    const expected = [];
    const slotsOf = (k, label) => (k.is_adaptive
      ? [[k.module_1_id, "Module 1"], [k.module_2_easy_id, "Module 2 · Easier"], [k.module_2_hard_id, "Module 2 · Harder"]]
      : [[k.module_id, "Module 1"], [k.module_2_id, "Module 2"]]).filter(([m]) => m).map(([m, l]) => ({ m, label: `${label} · ${l}` }));
    for (const x of slotsOf(ctx.rw, "Reading and Writing")) expected.push({ ...x, qs: await moduleQs(x.m) });
    expected.push({ divider: "Section 2: Math" });
    for (const x of slotsOf(ctx.math, "Math")) expected.push({ ...x, qs: await moduleQs(x.m) });
    // The key text the page must print: the app's own answerCandidates(…).join(" or ") || "—".
    const allQs = expected.flatMap((e) => e.qs ?? []);
    const keyOut = JSON.parse(execFileSync(`${APP_ROOT}node_modules/.bin/tsx`, [`${HERE}fl-key.ts`], {
      cwd: APP_ROOT, input: JSON.stringify(allQs.map((q) => q.correct_answer ?? null)), timeout: 60000,
    }).toString());
    const keyText = new Map(allQs.map((q, i) => [q.id, keyOut[i]]));
    return asUser(ADMIN_CLERK, async ({ page }) => {
      const problems = [];
      const read = async (url) => {
        await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.documentElement.dataset.printReady, null, { timeout: 120000 });
        return page.evaluate(() => [...document.querySelectorAll(".print-source section")].map((sec) => {
          if (sec.hasAttribute("data-print-divider")) return { divider: sec.querySelector("h1")?.textContent?.trim() };
          const head = sec.querySelector("p")?.textContent ?? "";
          const keyH = [...sec.querySelectorAll("h2")].find((h) => /Answer key/.test(h.textContent));
          const keys = keyH ? [...keyH.nextElementSibling.children].map((d) => d.children[1]?.textContent?.trim() ?? "") : [];
          return { head, keys };
        }));
      };
      for (const withKey of [false, true]) {
        const got = await read(`/print/tests/${ctx.id}${withKey ? "?key=1" : ""}`);
        const tag = withKey ? "key" : "blank";
        if (got.length !== expected.length) problems.push(`${tag}: ${got.length} parts printed, expected ${expected.length}`);
        expected.forEach((e, i) => {
          const g = got[i] ?? {};
          if (e.divider) { if (g.divider !== e.divider) problems.push(`${tag} part ${i + 1}: expected the "${e.divider}" divider, got ${JSON.stringify(g).slice(0, 60)}`); return; }
          if (!g.head?.startsWith(e.label)) problems.push(`${tag} part ${i + 1}: "${g.head?.slice(0, 50)}" (expected ${e.label})`);
          const n = Number((g.head?.match(/(\d+) questions/) ?? [])[1]);
          if (n !== e.qs.length) problems.push(`${tag} ${e.label}: ${n} questions printed, ${e.qs.length} approved in the database`);
          if (withKey) {
            const bad = e.qs.filter((q, qi) => (g.keys?.[qi] ?? "") !== keyText.get(q.id));
            if (bad.length) problems.push(`key ${e.label}: ${bad.length} answer(s) don't match correct_answer (Q${bad.slice(0, 3).map((q) => q.original_question_number).join(", Q")})`);
          }
        });
      }
      // Regression: an adaptive section test prints as before (3 modules, no divider).
      const sec = await read(`/print/tests/${TESTS.adaptive}`);
      if (sec.some((x) => x.divider) || sec.length !== 3 || !/^Math · Module 1|^Module 1/.test(sec[0]?.head ?? "")) problems.push(`section test print changed: ${sec.map((x) => x.divider ?? x.head?.slice(0, 30)).join(" | ")}`);
      if (problems.length) fail(problems.slice(0, 8).join("; "));
      return `blank + key: ${expected.map((e) => e.divider ?? `${e.label} (${e.qs.length})`).join(" → ")}; section test print unchanged`;
    });
  }, 6 * 60 * 1000);

  const trackLabel = (sl) => [sl.rwM2[0], sl.mathM2[0]].map((r) => String(r?.adaptive_track ?? "").replace("module_2_", "")).join("/");

  // ═════════════════════════════════════════════════════════════════
  // FL-CONSISTENCY — one attempt, the same numbers everywhere.
  // ═════════════════════════════════════════════════════════════════
  await check("FL-CONSISTENCY", [], "同一次整份 SAT 的成績在每個地方都一樣：學生成績頁、老師成績 API、管理員頁面、兩種 CSV、成績列印；分科子測驗的狀態和日期都跟主測驗一致", AREA, async () => {
    const ctx = await fixture("flFullLength");
    const problems = [];
    // Children follow the parent (sync trigger) on every fixture.
    for (const key of ["flFullLength", "flShort", "flPause", "flWindow"]) {
      let c;
      try { c = await fixture(key); } catch (e) { if (e.__skip) continue; throw e; }
      const { data: p } = await db.from("tests").select("*").eq("id", c.id).single();
      const { data: ks } = await db.from("tests").select("*").eq("parent_test_id", c.id);
      for (const k of ks ?? []) for (const f of ["status", "open_date", "due_date", "allow_retake", "show_answers_after_submission", "show_explanations_after_submission", "review_unlocked"]) {
        if (String(k[f]) !== String(p[f])) problems.push(`${key} ${k.section_order === 1 ? "R&W" : "Math"} child ${f}=${k[f]}, parent ${p[f]}`);
      }
    }
    return asStudent(98, [ctx], async ({ s, page, req }) => {
      await flApiTake(req, ctx, { rw: "right", math: "few" });
      const sl = slots(await flRows(s.id, ctx), ctx);
      const truth = { rwM1: cell(sl.rwM1[0]), rwM2: cell(sl.rwM2[0]), mathM1: cell(sl.mathM1[0]), mathM2: cell(sl.mathM2[0]) };
      // Student result page.
      await page.goto(`${BASE}/student/tests/${ctx.id}/result`, { waitUntil: "networkidle" });
      const studentText = await bodyText(page);
      return asUser(ADMIN_CLERK, async ({ page: ap, req: a }) => {
        const { row } = await resultsRow(a, ctx.id, s.id);
        if (!row) fail("attempt missing from the teacher results API");
        const want = { total: row.total, rw: row.rw.sat, math: row.math.sat, ...truth };
        const apiCells = { rwM1: row.rw.module1, rwM2: row.rw.module2, mathM1: row.math.module1, mathM2: row.math.module2 };
        for (const k of Object.keys(apiCells)) if (apiCells[k] !== truth[k]) problems.push(`results API ${k} ${apiCells[k]}, database ${truth[k]}`);
        if (want.total !== want.rw + want.math) problems.push(`API total ${want.total} ≠ ${want.rw} + ${want.math}`);
        const hasAll = (where, text, keys = ["total", "rw", "math", "rwM1", "rwM2", "mathM1", "mathM2"]) => {
          const t = norm(text);
          const miss = keys.filter((k) => !new RegExp(`(^|[^\\d])${String(want[k]).replace("/", "\\/")}($|[^\\d])`).test(t));
          if (miss.length) problems.push(`${where} lacks ${miss.map((k) => `${k}=${want[k]}`).join(", ")}`);
        };
        hasAll("student result page", studentText);
        // Admin pages.
        await ap.goto(`${BASE}/admin/tests/${ctx.id}/submissions`, { waitUntil: "networkidle" });
        hasAll("admin submissions page", await ap.locator("tr", { hasText: s.name }).first().innerText().catch(() => ""), ["total", "rwM1", "rwM2", "mathM1", "mathM2"]);
        await ap.goto(`${BASE}/admin/students/${s.id}`, { waitUntil: "networkidle" });
        hasAll("admin student page", await ap.locator("body").innerText(), ["total"]);
        // Results CSV: top-level columns + per-question blocks.
        const csv = parseCsv((await (await a.get(`${BASE}/api/teacher/tests/${ctx.id}/export`)).text()).replace(/^﻿/, ""));
        const [hdr, ...data] = csv;
        const r = data.find((x) => x[0] === s.name && Number(x[hdr.indexOf("Attempt")]) === sl.n);
        if (!r) problems.push("student missing from the results CSV");
        else {
          const col = (name) => norm(r[hdr.indexOf(name)] ?? "");
          const csvWant = { "Total (400–1600)": want.total, "R&W (200–800)": want.rw, "Math (200–800)": want.math, "R&W M1 Correct": truth.rwM1, "R&W M2 Correct": truth.rwM2, "Math M1 Correct": truth.mathM1, "Math M2 Correct": truth.mathM2 };
          for (const [k, v] of Object.entries(csvWant)) if (col(k) !== String(v)) problems.push(`CSV ${k} "${col(k)}", expected ${v}`);
          const trackWord = (t) => (t === "module_2_hard" ? "Hard" : t === "module_2_easy" ? "Easy" : "");
          if (col("R&W M2 Track") !== trackWord(sl.rwM2[0].adaptive_track)) problems.push(`CSV R&W M2 Track "${col("R&W M2 Track")}"`);
          // Per-question columns: separate "M2 Easy" / "M2 Hard" blocks
          // headed by original question number. The served block holds the
          // answers; the other block stays empty.
          for (const [sec, pre, m2] of [["rw", "RW", sl.rwM2[0]], ["math", "Math", sl.mathM2[0]]]) {
            const served = trackWord(m2.adaptive_track);
            if (!served) continue;
            const other = served === "Hard" ? "Easy" : "Hard";
            const qs = await moduleQs(m2.module_id);
            const wrongCells = qs.filter((q) => m2.answers?.[q.id] && hdr.filter((h) => h === `${pre} M2 ${served} Q${q.original_question_number}`).length === 1
              && r[hdr.indexOf(`${pre} M2 ${served} Q${q.original_question_number}`)] !== m2.answers[q.id]);
            const noHeader = qs.filter((q) => m2.answers?.[q.id] && !hdr.includes(`${pre} M2 ${served} Q${q.original_question_number}`));
            if (noHeader.length) problems.push(`CSV has no "${pre} M2 ${served} Q<n>" column for ${noHeader.length} answered question(s) (Q${noHeader.slice(0, 3).map((q) => q.original_question_number).join(", Q")})`);
            if (wrongCells.length) problems.push(`CSV ${pre} M2 ${served}: ${wrongCells.length} answer cell(s) differ from the submission (Q${wrongCells.slice(0, 3).map((q) => q.original_question_number).join(", Q")})`);
            const filled = hdr.map((h, i) => (h.startsWith(`${pre} M2 ${other} Q`) && r[i] ? h : null)).filter(Boolean);
            if (filled.length) problems.push(`CSV ${pre} M2 ${other} block (not served) has answers: ${filled.slice(0, 3).join(", ")}`);
          }
        }
        // Summary CSV + printout (print students API gives the submission id).
        const ps = await json(await a.get(`${BASE}/api/print/results/${ctx.id}/students`), "print students");
        const me = (ps.students ?? []).find((x) => x.studentName === s.name);
        if (!me) problems.push("student missing from the print students list");
        else {
          const sum = parseCsv((await (await a.get(`${BASE}/api/print/results/${ctx.id}/summary?subs=${me.submissionId}`)).text()).replace(/^﻿/, ""));
          const [sh, ...sd] = sum;
          const sr = sd.find((x) => x[0] === s.name);
          const sumWant = { "Total (400–1600)": want.total, "R&W (200–800)": want.rw, "R&W M1": truth.rwM1, "R&W M2": truth.rwM2, "Math (200–800)": want.math, "Math M1": truth.mathM1, "Math M2": truth.mathM2 };
          if (!sr) problems.push("student missing from the summary CSV");
          else for (const [k, v] of Object.entries(sumWant)) if (norm(sr[sh.indexOf(k)] ?? "") !== String(v)) problems.push(`summary CSV ${k} "${sr[sh.indexOf(k)]}", expected ${v}`);
          await ap.goto(`${BASE}/print/results/${ctx.id}?subs=${me.submissionId}`, { waitUntil: "domcontentloaded" });
          await ap.waitForFunction(() => document.documentElement.dataset.printReady, null, { timeout: 120000 });
          hasAll("result printout", await ap.locator(".print-preview-pages").innerText().catch(() => ""));
        }
        if (problems.length) fail(problems.slice(0, 10).join("; "));
        return `total ${want.total} = R&W ${want.rw} + Math ${want.math}; ${truth.rwM1}, ${truth.rwM2}, ${truth.mathM1}, ${truth.mathM2} equal on student page, results API, admin pages, results CSV (+ per-question M2 ${trackLabel(sl)} blocks), summary CSV and printout; children in sync`;
      });
    });
  }, 8 * 60 * 1000);

  // ═════════════════════════════════════════════════════════════════
  // Background results: FL-TIMEOUT-×4 and FL-WINDOW-CLOSE.
  // ═════════════════════════════════════════════════════════════════
  const timeoutTitles = {
    "FL-TIMEOUT-RW-M1": "英文模組1 時間到（學生離開）：系統自動交卷、答案保留，建立英文模組2（還沒開始計時）",
    "FL-TIMEOUT-RW-M2": "英文模組2 時間到：系統自動交卷、答案保留，進入休息（數學還沒建立）",
    "FL-TIMEOUT-MATH-M1": "數學模組1 時間到：系統自動交卷、答案保留，建立數學模組2（還沒開始計時）",
    "FL-TIMEOUT-MATH-M2": "數學模組2 時間到：系統自動交卷、答案保留，整份完成、有總分",
  };
  if (bg) await bg.waited;
  for (const id of TIMEOUT_IDS) {
    await check(id, [], `整份 SAT ${timeoutTitles[id]}`, AREA, async () => {
      if (bg?.timeoutSkip) skip(bg.timeoutSkip);
      if (bg?.timeoutError) throw new Error(bg.timeoutError);
      const t = bg?.targets?.[id];
      if (!t) throw new Error("time-out setup did not run");
      try {
        if (t.error) throw new Error(`setup: ${t.error}`);
        const rows = await flRows(t.s.id, t.ctx);
        const sl = slots(rows, t.ctx);
        const target = rows.find((r) => r.id === t.subId);
        const problems = [];
        if (!target || target.status === "In Progress") fail(`the backdated module (${t.where}) is still ${target?.status ?? "missing"} ${Math.round((Date.now() - t.backdatedAt) / 60000)} min later — the cron did not finalize it`);
        const kept = Object.keys(t.answers).filter((q) => target.answers?.[q] === t.answers[q]).length;
        if (kept < Object.keys(t.answers).length) problems.push(`only ${kept}/${Object.keys(t.answers).length} answers kept`);
        for (const k of ["rwM1", "rwM2", "mathM1", "mathM2"]) if (sl[k].length > 1) problems.push(`${sl[k].length} ${k} rows`);
        const next = { rw_m1: sl.rwM2[0], math_m1: sl.mathM2[0] }[t.where];
        if (t.where === "rw_m1" || t.where === "math_m1") {
          if (!next) problems.push("no Module 2 was created after the time-out");
          else {
            if (next.status !== "In Progress") problems.push(`next Module 2 is ${next.status}`);
            if (next.metadata?.module_2_started_at) problems.push("next Module 2's clock already started");
            if (!next.metadata?.fl_attempt_id) problems.push("next Module 2 lost the full-length metadata");
          }
        }
        if (t.where === "rw_m2" && sl.mathM1.length) problems.push("a Math row exists although the student never resumed");
        if (t.where === "math_m2" && !sl.mathM2.every((r) => DONE(r.status))) problems.push("attempt not finished");
        const [att] = await attemptsOf(t.s.id, t.ctx);
        if (att?.closed_at) problems.push(`attempt closed (${att.closed_reason})`);
        if (problems.length) fail(problems.join("; "));
        return `${t.where} ${target.status} by the cron, ${kept}/${Object.keys(t.answers).length} answers kept; next step ${t.where === "rw_m2" ? "break" : t.where === "math_m2" ? "done" : "Module 2 (unopened)"}`;
      } finally {
        await cleanFl(t.s?.id ?? student(t.n).id, [t.ctx]).catch(() => {});
      }
    }, 3 * 60 * 1000);
  }

  await check("FL-WINDOW-CLOSE", [], "休息後一直沒回來（過了截止日 + 24 小時）：系統關閉這次作答（數學未作答），學生不能再開始數學，成績頁顯示英文、沒有總分", AREA, async () => {
    const w = bg?.window;
    if (!w) throw new Error("window-close setup did not run");
    if (w.skip) skip(w.skip);
    try {
      if (w.error) throw new Error(`setup: ${w.error}`);
      const [att] = await attemptsOf(w.s.id, w.ctx);
      if (!att?.closed_at) fail(`attempt not closed ${Math.round((Date.now() - w.backdatedAt) / 60000)} min after the break passed due + 24 h — the cron close pass didn't run`);
      if (att.closed_reason !== "math_not_started") fail(`closed_reason ${att.closed_reason} (expected math_not_started)`);
      // What the student sees.
      return await asStudent(w.n, [w.ctx], async ({ page, req }) => {
        const problems = [];
        const st = await flState(req, w.ctx.id);
        if (st.state !== "closed") problems.push(`state ${st.state} (expected closed)`);
        const sm = await flStartMath(req, w.ctx.id);
        if (sm.status !== 403) problems.push(`start-math → HTTP ${sm.status} (expected 403)`);
        await page.goto(`${BASE}/student/tests/${w.ctx.id}/result`, { waitUntil: "networkidle" });
        const text = await bodyText(page);
        if (!/Math wasn.t taken|closed/i.test(text)) problems.push("result page doesn't say Math wasn't taken");
        if (!/—\/1600|— \/1600/.test(text)) problems.push(`result page total isn't "—" (${(text.match(/\S+\/1600/) ?? ["none"])[0]})`);
        if (problems.length) fail(problems.join("; "));
        return `closed by the cron (math_not_started); state closed; start-math 403; result shows R&W, total —`;
      }, { keep: true, fresh: false });
    } finally {
      if (w.ctx) {
        await db.from("tests").update({ due_date: null }).eq("id", w.ctx.id);
        await cleanFl(w.s?.id ?? student(94).id, [w.ctx]).catch(() => {});
      }
    }
  }, 4 * 60 * 1000);
}

/** Minimal RFC 4180 CSV parser (quotes, doubled quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  // Spreadsheet-injection guard prefixes ' — compare the value.
  return rows.map((r) => r.map((v) => v.replace(/^'(?=[=+\-@])/, "")));
}
