// harness/nightly/edge-checks.mjs — unusual-situation checks for the exam flow.
// Each check uses its own QA student (060–071) through the STUDENT1 login
// rotation, cleans its submissions before and after, and fails only on
// behaviour a student would be hurt by. Called from run.mjs:
//   await runEdgeChecks({ check, fail, ... })
import { chromium } from "playwright";
import { login, db, BASE, borrowLogin, clerk } from "../lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runEdgeChecks(h) {
  const { check, fail, TESTS, C, STUDENT1_CLERK, ADMIN_CLERK, studentByN, subs, deleteSubs, moduleQs, waitTake, startTestBrowser, apiTakeTest } = h;

  // ── helpers ──────────────────────────────────────────────
  /** Borrow STUDENT1's login for QA student n, run fn in a fresh browser, always clean up. */
  async function asStudent(n, testId, fn, ctxOpts = {}) {
    const s = studentByN(n);
    if (!s) throw new Error(`student ${n} not found`);
    await deleteSubs(s.id, testId);
    const orig = C.students[0].id;
    await borrowLogin(s.id, STUDENT1_CLERK);
    const b = await chromium.launch();
    try {
      const { page, context } = await login(b, STUDENT1_CLERK, ctxOpts);
      return await fn({ s, b, page, context });
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await deleteSubs(s.id, testId).catch(() => {});
    }
  }
  const choice = (page, letter) => page.locator(`button:has(> span:text-is("${letter}"))`).first();
  const next = (page) => page.getByRole("button", { name: /^Next/ }).first();
  const onQuestion = (page, i) => page.getByText(new RegExp(`Question ${i} of \\d+`)).first().waitFor({ timeout: 30000 });
  /** Open the question grid and jump to question i (1-based). */
  async function jumpTo(page, i) {
    await page.getByRole("button", { name: /Question \d+ of \d+/ }).first().click();
    const nav = page.getByRole("dialog", { name: "Question Navigator" });
    await nav.getByRole("button", { name: String(i), exact: true }).first().click();
    await onQuestion(page, i);
  }
  /** Poll the submission row until pred(row) holds; returns the row or the last one seen. */
  async function waitRow(id, pred, ms = 30000) {
    const until = Date.now() + ms;
    let row;
    while (Date.now() < until) {
      row = (await db.from("submissions").select("*").eq("id", id).single()).data;
      if (row && pred(row)) return row;
      await sleep(1000);
    }
    return row;
  }
  async function timerSeconds(page) {
    const label = await page.getByRole("timer").first().getAttribute("aria-label", { timeout: 15000 });
    const parts = (label?.match(/(\d+(?::\d+)+)/)?.[1] ?? "").split(":").map(Number);
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  }
  /** Seconds the server says are left on M1: limit − (now − started_at). */
  function expectedLeft(row, limitMin) {
    return limitMin * 60 - (Date.now() - new Date(row.started_at).getTime()) / 1000;
  }
  async function goToSubmitModal(page, total) {
    await jumpTo(page, total);
    await page.getByRole("button", { name: /Review & Submit/ }).click();
    await page.getByRole("button", { name: /Submit Test/ }).last().waitFor({ timeout: 15000 });
  }
  const totalOf = async (page) =>
    Number((await page.getByText(/Question \d+ of \d+/).first().innerText()).match(/of (\d+)/)[1]);

  // ── EDGE-DOUBLE-SUBMIT ───────────────────────────────────
  await check("EDGE-DOUBLE-SUBMIT", [], "交卷按兩下、或交卷請求重複送出：只會有一份考卷、一個第二模組", "特殊狀況", () =>
    asStudent(60, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      await startTestBrowser(page, T);
      await choice(page, "A").click();
      const total = await totalOf(page);
      await goToSubmitModal(page, total);
      await page.getByRole("button", { name: /Submit Test/ }).last().dblclick();
      await page.getByText(/Module 2/).first().waitFor({ timeout: 45000 });
      await sleep(2000);
      let rows = await subs(s.id, T);
      const m1 = rows[0];
      // Replay M1 submit (a retry whose first response was lost) — must not create another M2.
      const replay = await page.request.post(`${BASE}/api/student/submissions/${m1.id}/submit`, { data: { answers: m1.answers, metadata: {} } });
      // Two M2 submits racing (two tabs / double click past the UI guard).
      rows = await subs(s.id, T);
      const m2 = rows.find((r) => r.id !== m1.id);
      if (!m2) fail(`no Module 2 after double-clicking Submit; rows=${rows.length}`);
      const race = await Promise.all([0, 1].map(() =>
        page.request.post(`${BASE}/api/student/submissions/${m2.id}/submit`, { data: { answers: {}, metadata: {} } })));
      await sleep(2000);
      rows = await subs(s.id, T);
      const problems = [];
      if (rows.length !== 2) problems.push(`${rows.length} submissions for one sitting (expected 2: M1 + M2)`);
      if (replay.status() < 400) problems.push(`replayed M1 submit returned ${replay.status()} (expected 400)`);
      const ok = race.filter((r) => r.status() < 400).length;
      if (ok !== 1) problems.push(`two simultaneous M2 submits: ${ok} succeeded (expected exactly 1)`);
      if (rows.some((r) => r.status === "In Progress")) problems.push("a module is still In Progress after submit");
      if (problems.length) fail(problems.join("; "));
      return `1 M1 + 1 M2; replayed submit → ${replay.status()}; racing M2 submits → ${race.map((r) => r.status()).join("/")}`;
    }));

  // ── EDGE-RAPID-CHANGE ────────────────────────────────────
  await check("EDGE-RAPID-CHANGE", [], "同一題快速換答案（A→C→B），存到的是最後選的 B", "特殊狀況", () =>
    asStudent(61, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      // Twice: no pause between clicks, then 150 ms between clicks (straddles the save debounce).
      await choice(page, "A").click();
      await choice(page, "C").click();
      await choice(page, "B").click();
      await next(page).click();
      await onQuestion(page, 2);
      for (const l of ["D", "A", "C", "B"]) { await choice(page, l).click(); await sleep(150); }
      const row = await waitRow(m1.id, (r) => r.answers?.[qs[0].id] === "B" && r.answers?.[qs[1].id] === "B", 30000);
      const got = [row?.answers?.[qs[0].id], row?.answers?.[qs[1].id]];
      if (got[0] !== "B" || got[1] !== "B") fail(`last choice was B but the server kept Q1=${got[0]} Q2=${got[1]}`);
      // And what the page shows after a reload must match.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitTake(page);
      await sleep(1500);
      const after = (await db.from("submissions").select("answers").eq("id", m1.id).single()).data.answers;
      if (after[qs[0].id] !== "B" || after[qs[1].id] !== "B") fail(`after reload the server copy changed to Q1=${after[qs[0].id]} Q2=${after[qs[1].id]}`);
      return "Q1 A→C→B and Q2 D→A→C→B both saved as B, unchanged after reload";
    }));

  // ── EDGE-BLANK ───────────────────────────────────────────
  await check("EDGE-BLANK", [], "完全沒作答就交卷：0 分不當機，第二模組分到簡單版，成績頁正常", "特殊狀況", () =>
    asStudent(62, TESTS.adaptive, async ({ s, page }) => {
      const T = TESTS.adaptive;
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 120)));
      await startTestBrowser(page, T);
      const total = await totalOf(page);
      await goToSubmitModal(page, total);
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      await page.getByText(/Module 2/).first().waitFor({ timeout: 45000 });
      await sleep(1500);
      let rows = await subs(s.id, T);
      const [m1, m2] = rows;
      const problems = [];
      if (m1?.status !== "Submitted") problems.push(`M1 status ${m1?.status}`);
      if (m1?.correct_count !== 0) problems.push(`M1 correct_count ${m1?.correct_count} (expected 0)`);
      if (m2?.adaptive_track !== "module_2_easy") problems.push(`blank M1 routed to ${m2?.adaptive_track} (expected module_2_easy)`);
      // Blank M2 too, through the page.
      const start2 = page.getByRole("link", { name: /Start Module 2/ }).or(page.getByRole("button", { name: /Start Module 2/ }));
      await start2.first().click({ timeout: 30000 });
      await waitTake(page);
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      await page.waitForURL(/\/result/, { timeout: 45000 });
      await page.waitForLoadState("networkidle").catch(() => {});
      const body = await page.locator("body").innerText();
      rows = await subs(s.id, T);
      if (rows[1]?.status !== "Submitted" || rows[1]?.correct_count !== 0) problems.push(`M2 status=${rows[1]?.status} correct=${rows[1]?.correct_count}`);
      if (/something went wrong|application error|NaN|undefined|Infinity/i.test(body)) problems.push(`result page shows: ${body.match(/something went wrong|application error|NaN|undefined|Infinity/i)[0]}`);
      if (pageErrors.length) problems.push(`page errors: ${pageErrors.join(" | ")}`);
      if (problems.length) fail(problems.join("; "));
      return `blank M1 → 0, routed to easy M2; blank M2 → 0; result page loads cleanly`;
    }));

  // ── EDGE-NAV ─────────────────────────────────────────────
  await check("EDGE-NAV", [], "跳著作答、標記稍後再看、從題號列表跳題：答案和標記都在", "特殊狀況", () =>
    asStudent(63, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      const want = { 1: "A", 5: "C", 6: "D", 3: "B", 9: "A" };
      await choice(page, "A").click();                       // Q1
      await jumpTo(page, 5); await choice(page, "C").click(); // Q5 + flag
      await page.getByRole("button", { name: /Mark for Review/ }).click();
      await next(page).click(); await onQuestion(page, 6); await choice(page, "D").click();
      await jumpTo(page, 3); await choice(page, "B").click();
      await jumpTo(page, 9); await choice(page, "A").click();
      await jumpTo(page, 5); await choice(page, "C").click(); // re-click the same choice must not clear it
      const ids = Object.fromEntries(Object.keys(want).map((k) => [k, qs[k - 1].id]));
      const row = await waitRow(m1.id, (r) => Object.entries(want).every(([k, v]) => r.answers?.[ids[k]] === v)
        && (r.metadata?.flagged ?? []).includes(ids[5]), 30000);
      const wrong = Object.entries(want).filter(([k, v]) => row?.answers?.[ids[k]] !== v).map(([k, v]) => `Q${k}=${row?.answers?.[ids[k]] ?? "none"} (picked ${v})`);
      if (wrong.length) fail(`answers lost/changed while jumping around: ${wrong.join(", ")}`);
      if (!(row.metadata?.flagged ?? []).includes(ids[5])) fail("Q5 was marked for review but the mark wasn't saved");
      const extra = Object.keys(row.answers).filter((k) => !Object.values(ids).includes(k));
      if (extra.length) fail(`${extra.length} answers appeared on questions that were never answered`);
      // After a reload the grid must still show 5 done and Q5 flagged.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitTake(page);
      const pill = await page.getByRole("button", { name: /Question \d+ of \d+/ }).first().innerText();
      if (!/\(5 done\)/.test(pill)) fail(`after reload the page shows "${pill.replace(/\s+/g, " ")}" (expected 5 done)`);
      await page.getByRole("button", { name: /Question \d+ of \d+/ }).first().click();
      const q5 = page.getByRole("dialog", { name: "Question Navigator" }).getByRole("button", { name: "5", exact: true });
      // The flag badge sits next to the number (the current question's own styling overrides the colour).
      if (!(await q5.locator("xpath=..").locator("span.bg-status-warning").count())) fail("after reload Q5 is no longer shown as marked for review");
      return "5 answers in jumbled order + 1 review mark kept, also after reload";
    }));

  // ── EDGE-BACK ────────────────────────────────────────────
  await check("EDGE-BACK", [], "考到一半按瀏覽器「上一頁」再回來：答案和剩餘時間都對", "特殊狀況", () =>
    asStudent(64, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      const limit = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data.time_limit_minutes;
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      await choice(page, "A").click();
      await next(page).click(); await onQuestion(page, 2);
      await choice(page, "D").click();
      await sleep(3000);
      await page.goBack({ waitUntil: "domcontentloaded" });
      await sleep(4000);
      const away = page.url();
      // Coming back: the browser's Forward button, or Resume on the test page.
      await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
      if (!/\/take/.test(page.url())) {
        await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: /Resume Test|Start Test/ }).click();
      }
      await waitTake(page);
      await sleep(1500);
      const row = (await db.from("submissions").select("*").eq("id", m1.id).single()).data;
      const shown = await timerSeconds(page);
      const exp = expectedLeft(row, limit);
      const rows = await subs(s.id, T);
      const problems = [];
      if (row.answers?.[qs[0].id] !== "A" || row.answers?.[qs[1].id] !== "D") problems.push(`answers after Back: Q1=${row.answers?.[qs[0].id]} Q2=${row.answers?.[qs[1].id]}`);
      if (Math.abs(shown - exp) > 15) problems.push(`timer shows ${shown}s left, server says ${Math.round(exp)}s`);
      if (rows.length !== 1) problems.push(`${rows.length} submissions (Back/Resume started a new attempt)`);
      if (row.status !== "In Progress") problems.push(`status ${row.status} after Back`);
      if (problems.length) fail(problems.join("; "));
      return `Back went to ${away.replace(BASE, "")}; on return answers intact, timer ${shown}s vs server ${Math.round(exp)}s`;
    }));

  // ── EDGE-AFTER-SUBMIT ────────────────────────────────────
  await check("EDGE-AFTER-SUBMIT", [], "交卷後再打開考試網址、或重送存檔：不能重考，答案不會被改", "特殊狀況", () =>
    asStudent(65, TESTS.engLinear, async ({ s, page, context }) => {
      const T = TESTS.engLinear;
      const r = await apiTakeTest(context.request, s.id, T);
      const before = await subs(s.id, T);
      const problems = [];
      // 1. Reopen the take page (bookmark / browser history).
      await page.goto(`${BASE}/student/tests/${T}/take`, { waitUntil: "networkidle" });
      const onTake = await page.getByText(/Question \d+ of \d+/).first().isVisible().catch(() => false);
      if (onTake) problems.push(`take page reopened the exam (${page.url().replace(BASE, "")})`);
      // 2. ...also with ?start=1, and the Start button on the test page if one shows.
      await page.goto(`${BASE}/student/tests/${T}/take?start=1`, { waitUntil: "networkidle" });
      if (await page.getByText(/Question \d+ of \d+/).first().isVisible().catch(() => false)) problems.push("take?start=1 reopened the exam");
      await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
      const startBtn = page.getByRole("button", { name: /^(Start Test|Resume Test)/ });
      if (await startBtn.count()) problems.push(`test page still offers "${await startBtn.first().innerText()}" after submitting`);
      // 3. API: new attempt, late PATCH, re-submit.
      const start = await context.request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      if (start.status() < 400) problems.push(`starting again returned ${start.status()}`);
      const q = Object.keys(r.answers1)[0];
      const patch = await context.request.patch(`${BASE}/api/student/submissions/${r.m1Id}`, { data: { answers: { ...r.answers1, [q]: r.answers1[q] === "A" ? "B" : "A" }, metadata: {} } });
      if (patch.status() < 400) problems.push(`PATCH on a submitted module returned ${patch.status()}`);
      const resub = await context.request.post(`${BASE}/api/student/submissions/${r.m2Id}/submit`, { data: { answers: {}, metadata: {} } });
      if (resub.status() < 400) problems.push(`re-submitting M2 with blank answers returned ${resub.status()}`);
      await sleep(1500);
      const after = await subs(s.id, T);
      if (after.length !== before.length) problems.push(`${after.length - before.length} new submission(s) created`);
      for (const b of before) {
        const a = after.find((x) => x.id === b.id);
        if (JSON.stringify(a?.answers) !== JSON.stringify(b.answers) || a?.correct_count !== b.correct_count) problems.push(`submitted module ${b.id.slice(0, 8)} changed (score ${b.correct_count}→${a?.correct_count})`);
      }
      if (problems.length) fail(problems.join("; "));
      return `take URL → ${page.url().replace(BASE, "")}; restart ${start.status()}, PATCH ${patch.status()}, resubmit ${resub.status()}; scores unchanged`;
    }));

  // ── EDGE-CLOCK ───────────────────────────────────────────
  await check("EDGE-CLOCK", [], "學生電腦時鐘快 2 小時、時區在台灣：倒數時間正確、不會提早交卷", "特殊狀況", () =>
    asStudent(66, TESTS.engLinear, async ({ s, page, context }) => {
      const T = TESTS.engLinear;
      const limit = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data.time_limit_minutes;
      // Skew the page's clock +2h, ticking normally from there.
      await page.clock.install({ time: new Date(Date.now() + 2 * 3600e3) });
      await startTestBrowser(page, T);
      const skew = (await page.evaluate(() => Date.now())) - Date.now();
      const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      await choice(page, "C").click();
      const shown = await timerSeconds(page);
      const exp = expectedLeft(m1, limit);
      await sleep(75000); // well past any "deadline already passed" misfire
      const row = (await db.from("submissions").select("*").eq("id", m1.id).single()).data;
      const shown2 = await timerSeconds(page);
      const exp2 = expectedLeft(row, limit);
      const problems = [];
      if (Math.abs(skew - 7200e3) > 120e3) problems.push(`clock skew not applied (${Math.round(skew / 60000)} min)`);
      if (tz !== "Asia/Taipei") problems.push(`timezone was ${tz}`);
      if (Math.abs(shown - exp) > 20) problems.push(`timer showed ${shown}s left, server says ${Math.round(exp)}s`);
      if (Math.abs(shown2 - exp2) > 20) problems.push(`75 s later the timer showed ${shown2}s, server says ${Math.round(exp2)}s`);
      if (row.status !== "In Progress") problems.push(`exam was ${row.status} after 75 s (submitted early)`);
      if (row.answers?.[qs[0].id] !== "C") problems.push(`answer not saved (Q1=${row.answers?.[qs[0].id]})`);
      if (problems.length) fail(problems.join("; "));
      return `clock +${Math.round(skew / 60000)} min, ${tz}: timer ${shown}s vs server ${Math.round(exp)}s; still In Progress after 75 s; answer saved`;
    }, { timezoneId: "Asia/Taipei", locale: "zh-TW" }), 5 * 60 * 1000);

  // ── EDGE-SLOW-NET ────────────────────────────────────────
  await check("EDGE-SLOW-NET", [], "網路很慢（模擬 3G）：還是開得了考試、答案存得進去", "特殊狀況", () =>
    asStudent(67, TESTS.engLinear, async ({ s, page, context }) => {
      const T = TESTS.engLinear;
      const cdp = await context.newCDPSession(page);
      // Chrome DevTools "Slow 3G": 2 s latency, ~400 kbit/s each way.
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 });
      const t0 = Date.now();
      await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await page.getByRole("button", { name: /Start Test|Resume Test/ }).click({ timeout: 180000 });
      await page.getByText(/Question \d+ of \d+/).first().waitFor({ timeout: 180000 });
      await page.getByText("Loading…").waitFor({ state: "hidden", timeout: 180000 }).catch(() => {});
      const openSec = Math.round((Date.now() - t0) / 1000);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      for (let i = 0; i < 3; i++) {
        await onQuestion(page, i + 1);
        await choice(page, "ABCD"[i]).click({ timeout: 30000 });
        await next(page).click({ timeout: 30000 });
      }
      const row = await waitRow(m1.id, (r) => qs.slice(0, 3).every((q, i) => r.answers?.[q.id] === "ABC"[i]), 90000);
      const saved = qs.slice(0, 3).filter((q, i) => row?.answers?.[q.id] === "ABC"[i]).length;
      if (saved < 3) fail(`on slow 3G only ${saved}/3 answers reached the server within 90 s (exam took ${openSec}s to open)`);
      return `exam opened in ${openSec}s on slow 3G; 3/3 answers saved`;
    }), 8 * 60 * 1000);

  // ── EDGE-SAVE-RETRY ──────────────────────────────────────
  await check("EDGE-SAVE-RETRY", [], "存檔時伺服器出錯（連續 3 次）：自動重試，答案不會掉", "特殊狀況", () =>
    asStudent(68, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      let failed = 0;
      await page.route(/\/api\/student\/submissions\/[^/]+$/, async (route) => {
        if (route.request().method() === "PATCH" && failed < 3) {
          failed++;
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated server error" }) });
        }
        return route.continue();
      });
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      await choice(page, "D").click();
      const row = await waitRow(m1.id, (r) => r.answers?.[qs[0].id] === "D", 60000);
      if (failed < 3) fail(`only ${failed} save attempts were made before the answer stopped retrying`);
      if (row?.answers?.[qs[0].id] !== "D") fail(`after 3 failed saves the answer never reached the server (Q1=${row?.answers?.[qs[0].id] ?? "none"})`);
      const status = await page.getByText(/Saved|Not saved/).first().innerText().catch(() => "");
      return `3 saves got a 500, the page retried and the answer was saved${status ? ` (status "${status}")` : ""}`;
    }));

  // ── EDGE-RELOGIN ─────────────────────────────────────────
  await check("EDGE-RELOGIN", [], "考到一半被登出、再重新登入：回到原本的題目，登出時選的答案也補存", "特殊狀況", () =>
    asStudent(69, TESTS.engLinear, async ({ s, page, context }) => {
      const T = TESTS.engLinear;
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      for (let i = 0; i < 3; i++) { await onQuestion(page, i + 1); await choice(page, "B").click(); await next(page).click(); }
      await onQuestion(page, 4);
      await waitRow(m1.id, (r) => qs.slice(0, 3).every((q) => r.answers?.[q.id] === "B"), 20000);
      // Session gone (signed out in another tab / cookies cleared) — then the student answers Q4.
      await context.clearCookies();
      await choice(page, "A").click();
      await sleep(5000);
      const banner = await page.getByText(/sign in|signed out|session/i).first().innerText().catch(() => "");
      // Sign in again in the same browser and come back.
      const { token } = await clerk("/sign_in_tokens", { method: "POST", body: JSON.stringify({ user_id: STUDENT1_CLERK, expires_in_seconds: 600 }) });
      await page.goto(`${BASE}/sign-in?__clerk_ticket=${token}`, { waitUntil: "domcontentloaded" });
      await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 45000 });
      await page.goto(`${BASE}/student/tests/${T}/take`, { waitUntil: "domcontentloaded" });
      await waitTake(page);
      const row = await waitRow(m1.id, (r) => r.answers?.[qs[3].id] === "A", 30000);
      const at = await page.getByText(/Question \d+ of \d+/).first().innerText();
      const problems = [];
      if (qs.slice(0, 3).some((q) => row.answers?.[q.id] !== "B")) problems.push("answers from before the sign-out were lost");
      if (row.answers?.[qs[3].id] !== "A") problems.push("the answer chosen while signed out was not saved after signing back in");
      if (!/Question 4 of/.test(at)) problems.push(`resumed at "${at.replace(/\s+/g, " ")}" instead of question 4`);
      if (row.status !== "In Progress") problems.push(`status ${row.status}`);
      if (problems.length) fail(problems.join("; "));
      return `signed out at Q4, answered it, signed back in → back on Q4, 4/4 answers saved${banner ? `; page told the student "${banner.slice(0, 60)}"` : ""}`;
    }));

  // ── EDGE-SMALL-SCREEN ────────────────────────────────────
  await check("EDGE-SMALL-SCREEN", [], "小筆電螢幕（1280×720）和放大 200%：題目、選項、下一題、交卷按鈕都看得到、按得到", "特殊狀況", () =>
    asStudent(70, TESTS.engLinear, async ({ s, b, page, context }) => {
      const T = TESTS.engLinear;
      const problems = [];
      const inView = async (pg, loc, what, size) => {
        const el = loc.first();
        if (!(await el.isVisible().catch(() => false))) { problems.push(`${size}: ${what} not visible`); return; }
        await el.scrollIntoViewIfNeeded().catch(() => {});
        const box = await el.boundingBox();
        const vp = pg.viewportSize();
        if (!box || box.x < 0 || box.y < 0 || box.x + box.width > vp.width + 1 || box.y + box.height > vp.height + 1)
          problems.push(`${size}: ${what} sticks out of the screen (${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}` : "no box"})`);
      };
      const walk = async (pg, size, submit) => {
        await waitTake(pg);
        await pg.getByText("Loading…").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
        // The second screen resumes where the first left off (the last question); start from Q1.
        await jumpTo(pg, 1);
        await inView(pg, pg.getByRole("timer"), "timer", size);
        for (const l of ["A", "B", "C", "D"]) await inView(pg, choice(pg, l), `choice ${l}`, size);
        await inView(pg, next(pg), "Next", size);
        await inView(pg, pg.getByRole("button", { name: /Mark for Review|Marked for Review/ }), "Mark for Review", size);
        const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) problems.push(`${size}: page scrolls sideways by ${overflow}px`);
        await choice(pg, "B").click();
        await next(pg).click();
        await onQuestion(pg, 2);
        const total = await totalOf(pg);
        await jumpTo(pg, total);
        await inView(pg, pg.getByRole("button", { name: /Review & Submit/ }), "Review & Submit", size);
        await pg.getByRole("button", { name: /Review & Submit/ }).click();
        await inView(pg, pg.getByRole("button", { name: /Submit Test/ }).last(), "Submit Test (in the review page)", size);
        if (submit) {
          await pg.getByRole("button", { name: /Submit Test/ }).last().click();
          await pg.getByText(/Module 2/).first().waitFor({ timeout: 45000 }).catch(() => problems.push(`${size}: Submit Test didn't submit`));
        }
      };
      // 1280×720 laptop.
      await page.setViewportSize({ width: 1280, height: 720 });
      await startTestBrowser(page, T);
      await walk(page, "1280×720", false);
      // Same screen at 200% zoom = 640×360 CSS px at 2× pixels.
      const zoom = await b.newContext({ storageState: await context.storageState(), viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 });
      const zp = await zoom.newPage();
      await zp.goto(`${BASE}/student/tests/${T}/take`, { waitUntil: "domcontentloaded" });
      await walk(zp, "200% zoom", true);
      const rows = await subs(s.id, T);
      if (rows[0]?.status !== "Submitted") problems.push(`after Submit at 200% zoom M1 is ${rows[0]?.status}`);
      if (problems.length) fail(problems.join("; "));
      return "1280×720 and 200% zoom: timer, 4 choices, Next, Mark for Review, Review & Submit, Submit Test all on screen and clickable; no sideways scroll";
    }));

  // ── EDGE-TEACHER-EDIT ────────────────────────────────────
  // Records what happens when the test is changed under a student mid-exam.
  // FAIL when renaming hurts the student, or when closing the test mid-exam
  // marks an on-time student Late (Barry 2026-10-28: not Late). Unassigning is recorded.
  await check("EDGE-TEACHER-EDIT", [], "考試中管理員改測驗名稱、關閉或取消指派：考到一半的學生不受影響，準時考完不算遲交", "特殊狀況", () =>
    asStudent(71, TESTS.engLinear, async ({ s, b, page }) => {
      const T = TESTS.engLinear;
      const orig = (await db.from("tests").select("test_name,due_date").eq("id", T).single()).data;
      const origAssign = (await db.from("test_assignments").select("class_group_ids,student_ids").eq("test_id", T).single()).data;
      const myClasses = ((await db.from("class_group_members").select("class_group_id").eq("student_id", s.id)).data ?? []).map((m) => m.class_group_id);
      const admin = await login(b, ADMIN_CLERK);
      const adminPatch = (body) => admin.context.request.patch(`${BASE}/api/admin/tests/${T}`, { data: body });
      const notes = [];
      let renameHurt = null;
      try {
        await startTestBrowser(page, T);
        const [m1] = await subs(s.id, T);
        const qs = await moduleQs(m1.module_id);
        const answerAndCheck = async (i, letter) => {
          await page.bringToFront();
          await onQuestion(page, i);
          await choice(page, letter).click();
          await next(page).click();
          const r = await waitRow(m1.id, (x) => x.answers?.[qs[i - 1].id] === letter, 20000);
          return r?.answers?.[qs[i - 1].id] === letter;
        };
        if (!(await answerAndCheck(1, "A"))) fail("the first answer didn't save (before any edit)");

        const ren = await adminPatch({ testName: `${orig.test_name} (edited)` });
        const ok2 = await answerAndCheck(2, "B");
        notes.push(`rename (${ren.status()}): save ${ok2 ? "OK" : "FAILED"}`);
        if (!ok2) renameHurt = "after the admin renamed the test, the student's next answer was not saved";

        // Close the test just after the student started: they are mid-exam and on time.
        const dueAt = new Date(m1.started_at).getTime() + 1000;
        if (Date.now() < dueAt + 1000) await sleep(dueAt + 1000 - Date.now());
        const close = await adminPatch({ dueDate: new Date(dueAt).toISOString() });
        const ok3 = await answerAndCheck(3, "C");
        notes.push(`due date moved to the past (${close.status()}): save ${ok3 ? "OK" : "blocked"}`);

        const unassign = await adminPatch({ classGroupIds: origAssign.class_group_ids.filter((c) => !myClasses.includes(c)) });
        const ok4 = await answerAndCheck(4, "D");
        notes.push(`class unassigned (${unassign.status()}): save ${ok4 ? "OK" : "blocked"}`);

        // Submit through the page: does the student lose the module?
        await goToSubmitModal(page, await totalOf(page));
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        await sleep(6000);
        const row = (await db.from("submissions").select("status,answers,correct_count").eq("id", m1.id).single()).data;
        const msg = await page.getByText(/couldn't|not allowed|forbidden|closed|error/i).first().innerText().catch(() => "");
        notes.push(`submit after closing+unassigning: M1 ${row.status}, ${Object.keys(row.answers ?? {}).length} answers kept${msg ? `, page said "${msg.slice(0, 80)}"` : ""}`);
        // Barry 2026-10-28: an admin moving the due date earlier mid-exam must not make an on-time student Late.
        if (row.status !== "Submitted") renameHurt = `student started on time but was marked ${row.status} after the admin moved the due date earlier`;
      } finally {
        await db.from("tests").update({ test_name: orig.test_name, due_date: orig.due_date }).eq("id", T);
        await db.from("test_assignments").update({ class_group_ids: origAssign.class_group_ids, student_ids: origAssign.student_ids }).eq("test_id", T);
        await admin.context.close().catch(() => {});
      }
      if (renameHurt) fail(`${renameHurt}. ${notes.join("; ")}`);
      return notes.join("; ");
    }));

  // ── EDGE-CRON-HANDOFF ────────────────────────────────────
  // Module 1 time runs out with the page left open (student 081): the
  // 5-minute cron grades Module 1 and must create Module 2 (exactly one,
  // clock not started). Pressing Submit on the stale Module 1 page then
  // gets 400 "already submitted" and must continue to "Start Module 2".
  await check("EDGE-CRON-HANDOFF", [], "第一模組時間到由系統自動交卷：第二模組自動建立（只有一份、計時還沒開始），學生再按交卷會直接進第二模組", "特殊狀況", () =>
    asStudent(81, TESTS.mathLinear, async ({ s, page }) => {
      const T = TESTS.mathLinear;
      await startTestBrowser(page, T);
      await choice(page, "A").click();
      const [m1] = await subs(s.id, T);
      await waitRow(m1.id, (r) => Object.keys(r.answers ?? {}).length > 0, 20000);
      const { data: t } = await db.from("tests").select("time_limit_minutes").eq("id", T).single();
      // Backdate the QA row past limit + the cron's 5-min grace; the open
      // page keeps its own clock, so only the cron can close Module 1.
      await db.from("submissions")
        .update({ started_at: new Date(Date.now() - ((t.time_limit_minutes ?? 35) + 7) * 60000).toISOString() })
        .eq("id", m1.id);
      const closed = await waitRow(m1.id, (r) => r.status !== "In Progress", 7 * 60000);
      if (closed?.status === "In Progress") fail("cron did not finalize the overdue Module 1 within 7 min");
      await sleep(3000);
      const m2 = (await subs(s.id, T)).filter((r) => String(r.adaptive_track).startsWith("module_2"));
      if (m2.length !== 1) fail(`cron finalized Module 1 (${closed.status}) but there are ${m2.length} Module 2 rows (expected exactly 1)`);
      if (m2[0].status !== "In Progress") fail(`cron-created Module 2 is ${m2[0].status}, expected In Progress`);
      if (m2[0].metadata?.module_2_started_at) fail(`cron-created Module 2 clock already started (${m2[0].metadata.module_2_started_at})`);
      // Student, unaware, presses Submit on the stale Module 1 page.
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      try {
        await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 });
      } catch {
        fail(`after the cron closed Module 1, pressing Submit did not reach the Module 2 intro (url ${page.url().slice(-60)})`);
      }
      const after = (await subs(s.id, T)).filter((r) => String(r.adaptive_track).startsWith("module_2"));
      if (after.length !== 1) fail(`after the student's Submit there are ${after.length} Module 2 rows`);
      return `M1 ${closed.status} by cron with ${Object.keys(closed.answers ?? {}).length} answer(s); 1 unopened M2; stale Submit → Module 2 intro`;
    }), 12 * 60 * 1000);
}
