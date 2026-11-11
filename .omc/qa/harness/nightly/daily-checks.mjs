// harness/nightly/daily-checks.mjs — NEW checks invented each evening by the
// 21:00 "new tests" job (nightly/new-tests.sh). Every check added here is also
// registered in added-tests.json (id, date added, plain-Chinese description)
// so the report/PDF can describe it and list "today's new tests".
// Same helper bag as edge-checks.mjs. Uses QA students 072–080 only.
// Called from run.mjs: await runDailyChecks({ check, fail, ... })
import { chromium, webkit } from "playwright";
import { login, db, BASE, borrowLogin, clerk, cast } from "../lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runDailyChecks(h) {
  const { check, fail, TESTS, C, STUDENT1_CLERK, ADMIN_CLERK, studentByN, subs, deleteSubs, moduleQs, waitTake, startTestBrowser, apiTakeTest } = h;
  void chromium; void webkit; void login; void db; void BASE; void borrowLogin; void clerk; void sleep;

  // ── shared helpers (same shapes as edge-checks.mjs) ──────
  /** Borrow STUDENT1's login for QA student n in browser b; returns { s, page, context }. Caller restores. */
  async function borrowAs(b, n) {
    const s = studentByN(n);
    if (!s) throw new Error(`student ${n} not found`);
    await borrowLogin(s.id, STUDENT1_CLERK);
    const { page, context } = await login(b, STUDENT1_CLERK);
    return { s, page, context };
  }
  /** Borrow STUDENT1's login for QA student n, run fn in a fresh browser, always clean up testIds. */
  async function asStudent(n, testIds, fn, launcher = chromium) {
    const ids = [].concat(testIds);
    const s = studentByN(n);
    if (!s) throw new Error(`student ${n} not found`);
    for (const t of ids) await deleteSubs(s.id, t);
    const orig = C.students[0].id;
    const b = await launcher.launch();
    try {
      const { page, context } = await borrowAs(b, n);
      return await fn({ s, b, page, context });
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      for (const t of ids) await deleteSubs(s.id, t).catch(() => {});
    }
  }
  const choice = (page, letter) => page.locator(`button:has(> span:text-is("${letter}"))`).first();
  const onQuestion = (page, i) => page.getByText(new RegExp(`Question ${i} of \\d+`)).first().waitFor({ timeout: 30000 });
  async function jumpTo(page, i) {
    await page.getByRole("button", { name: /Question \d+ of \d+/ }).first().click();
    const nav = page.getByRole("dialog", { name: "Question Navigator" });
    await nav.getByRole("button", { name: String(i), exact: true }).first().click();
    await onQuestion(page, i);
  }
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
  const totalOf = async (page) =>
    Number((await page.getByText(/Question \d+ of \d+/).first().innerText()).match(/of (\d+)/)[1]);
  async function goToSubmitModal(page, total) {
    await jumpTo(page, total);
    await page.getByRole("button", { name: /Review & Submit/ }).click();
    await page.getByRole("button", { name: /Submit Test/ }).last().waitFor({ timeout: 15000 });
  }

  // ── new checks go below, newest last ──

  // ── D-20261029-1 ─────────────────────────────────────────
  // Another student's submission id (shared screenshot / URL) must not let a
  // student read, change, submit or see the result of someone else's exam; and
  // a student's own in-exam data must never carry the answer key.
  await check("D-20261029-1", [], "學生拿到別人的考卷編號：看不到、改不了、交不了別人的考卷；自己考試中也拿不到正確答案", "安全", async () => {
    const TE = TESTS.engLinear, TU = TESTS.untimedEng;
    const victim = studentByN(75), me = studentByN(74);
    if (!victim || !me) throw new Error("students 074/075 not found");
    const orig = C.students[0].id;
    const clean = async () => { for (const st of [victim, me]) for (const t of [TE, TU]) await deleteSubs(st.id, t).catch(() => {}); };
    await clean();
    const b = await chromium.launch();
    try {
      // Victim (075): one exam in progress with an answer, one finished exam.
      const v = await borrowAs(b, 75);
      const vStart = await v.context.request.post(`${BASE}/api/student/submissions`, { data: { testId: TE } });
      const vInProg = (await vStart.json().catch(() => ({}))).data?.id;
      if (!vInProg) throw new Error(`victim start failed ${vStart.status()}`);
      const vRow0 = (await db.from("submissions").select("module_id").eq("id", vInProg).single()).data;
      const vQs = await moduleQs(vRow0.module_id);
      await v.context.request.patch(`${BASE}/api/student/submissions/${vInProg}`, { data: { answers: { [vQs[0].id]: "A" }, metadata: {} } });
      const vDone = await apiTakeTest(v.context.request, victim.id, TU);
      await v.context.close();
      const before = (await db.from("submissions").select("status,answers,correct_count").eq("id", vInProg).single()).data;
      const beforeDone = (await db.from("submissions").select("status,answers,correct_count").eq("id", vDone.m1Id).single()).data;
      if (before?.answers?.[vQs[0].id] !== "A") throw new Error("victim's answer didn't save (setup)");

      // Attacker (074) signs in and tries the victim's ids.
      const a = await borrowAs(b, 74);
      const R = a.context.request;
      const problems = [];
      const get = await R.get(`${BASE}/api/student/submissions/${vInProg}`);
      const getBody = await get.text();
      if (get.status() < 400 || getBody.includes(vQs[0].id)) problems.push(`reading another student's exam returned ${get.status()}`);
      const patch = await R.patch(`${BASE}/api/student/submissions/${vInProg}`, { data: { answers: { [vQs[0].id]: "D" }, answersMode: "merge", metadata: {} } });
      if (patch.status() < 400) problems.push(`changing another student's answers returned ${patch.status()}`);
      const submit = await R.post(`${BASE}/api/student/submissions/${vInProg}/submit`, { data: { answers: {}, metadata: {} } });
      if (submit.status() < 400) problems.push(`submitting another student's exam returned ${submit.status()}`);
      const result = await R.get(`${BASE}/api/student/submissions/${vDone.m1Id}/result`);
      if (result.status() < 400) problems.push(`reading another student's result returned ${result.status()}`);
      const resultPage = await a.page.goto(`${BASE}/student/tests/${TU}/result?submission=${vDone.m1Id}`, { waitUntil: "domcontentloaded" });
      const rpBody = await a.page.locator("body").innerText().catch(() => "");
      if (resultPage.status() < 400 && /\d+\s*\/\s*\d+|score|correct/i.test(rpBody) && !/not found|404/i.test(rpBody))
        problems.push(`result page with another student's submission id showed a result (HTTP ${resultPage.status()})`);
      await sleep(1500);
      const after = (await db.from("submissions").select("status,answers,correct_count").eq("id", vInProg).single()).data;
      const afterDone = (await db.from("submissions").select("status,answers,correct_count").eq("id", vDone.m1Id).single()).data;
      if (JSON.stringify(after) !== JSON.stringify(before)) problems.push(`victim's in-progress exam changed: ${JSON.stringify(before).slice(0, 80)} → ${JSON.stringify(after).slice(0, 80)}`);
      if (JSON.stringify(afterDone) !== JSON.stringify(beforeDone)) problems.push("victim's finished exam changed");

      // Attacker's own exam: the resume API and the take page must not carry the key.
      const mine = await R.post(`${BASE}/api/student/submissions`, { data: { testId: TE } });
      const mineId = (await mine.json().catch(() => ({}))).data?.id;
      if (!mineId) throw new Error(`own start failed ${mine.status()}`);
      const own = await (await R.get(`${BASE}/api/student/submissions/${mineId}`)).json().catch(() => ({}));
      const ownQs = own.data?.questions ?? [];
      if (!ownQs.length) throw new Error("own resume API returned no questions");
      const leakKeys = [...new Set(ownQs.flatMap((q) => Object.keys(q).filter((k) => /correct|answer_key|explanation/i.test(k))))];
      if (leakKeys.length) problems.push(`in-exam resume API includes ${leakKeys.join(", ")}`);
      // The page HTML holds UI labels like "explanation":"解析", so look for the
      // real thing: the correct_answer field, or any question's explanation text.
      const takeHtml = await (await R.get(`${BASE}/student/tests/${TE}/take`)).text();
      if (/\\?"correct_answer\\?"\s*:/.test(takeHtml)) problems.push(`take page HTML carries "correct_answer"`);
      const ownModule = (await db.from("submissions").select("module_id").eq("id", mineId).single()).data.module_id;
      const { data: expl } = await db.from("questions").select("original_question_number,explanation,question_text").eq("module_id", ownModule).eq("parsing_status", "Approved");
      const snippets = (expl ?? []).map((q) => ({ n: q.original_question_number, s: String(q.explanation ?? "").match(/[A-Za-z0-9 ]{30,}/)?.[0]?.slice(0, 30) })).filter((x) => x.s);
      const leakedExpl = snippets.filter((x) => takeHtml.includes(x.s));
      if (leakedExpl.length) problems.push(`take page HTML contains the explanation text of ${leakedExpl.length} question(s) (e.g. Q${leakedExpl[0].n})`);
      if (snippets.length < 5) throw new Error(`only ${snippets.length} explanations usable for the leak scan`);
      // Control: the same scan must find the question texts the page does show.
      const stems = (expl ?? []).map((q) => String(q.question_text ?? "").match(/[A-Za-z0-9 ]{30,}/)?.[0]?.slice(0, 30)).filter(Boolean);
      const stemsSeen = stems.filter((x) => takeHtml.includes(x)).length;
      if (stemsSeen < stems.length / 2) throw new Error(`leak scan can't see question texts in the take page HTML (${stemsSeen}/${stems.length}) — scan not valid`);
      await a.context.close();
      if (problems.length) fail(problems.join("; "));
      return `other student's exam: GET ${get.status()}, PATCH ${patch.status()}, submit ${submit.status()}, result API ${result.status()}, result page ${resultPage.status()}; both victim exams unchanged; own exam data (${ownQs.length} qs; take page scanned for ${snippets.length} explanations, control saw ${stemsSeen}/${stems.length} stems) has no answer key`;
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await clean();
    }
  }, 4 * 60 * 1000);

  // ── D-20261029-2 ─────────────────────────────────────────
  // Commit 47cfe13: on a slow connection the Start Test button must say
  // "Loading..." (disabled) until the page is ready, then work on one click —
  // and an impatient double-click must still give exactly one exam.
  await check("D-20261029-2", [], "網路慢、網頁還沒準備好時：開始按鈕顯示 Loading 不能按；準備好後按一下（或連按兩下）只開一份考卷", "考試流程", () =>
    asStudent(73, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      const DELAY = 8000;
      let delayed = 0;
      const slowJs = async (route) => { delayed++; await sleep(DELAY); await route.continue().catch(() => {}); };
      await page.route(/\/_next\/static\/(immutable\/)?chunks\/.*\.js/, slowJs);
      const t0 = Date.now();
      await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      const btn = page.locator("button").filter({ hasText: /Start Test|Resume Test|Loading\.\.\./ }).first();
      await btn.waitFor({ timeout: 30000 });
      const early = { text: (await btn.innerText()).trim(), disabled: await btn.isDisabled(), at: Date.now() - t0 };
      const problems = [];
      if (early.at < DELAY - 1000) {
        if (!/Loading/.test(early.text) || !early.disabled)
          problems.push(`before the page was ready the button showed "${early.text}" (${early.disabled ? "disabled" : "clickable"}) — a click there does nothing`);
        // Impatient clicks while it says Loading must not start anything.
        await btn.click({ force: true, timeout: 2000 }).catch(() => {});
        await btn.click({ force: true, timeout: 2000 }).catch(() => {});
      } else {
        problems.push(`test setup: the slow-JS window had already passed (${early.at} ms) — not measured`);
      }
      // Ready: the button must turn into Start Test by itself.
      const ready = page.getByRole("button", { name: /^\s*Start Test/ });
      await ready.waitFor({ timeout: 60000 }).catch(() => {});
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /Start Test/.test(b.textContent) && !b.disabled), null, { timeout: 60000 })
        .catch(() => problems.push("the button never turned into a clickable Start Test after the page loaded"));
      const readyMs = Date.now() - t0;
      await page.unroute(/\/_next\/static\/(immutable\/)?chunks\/.*\.js/, slowJs);
      const preRows = await subs(s.id, T);
      if (preRows.length) problems.push(`${preRows.length} exam(s) started by clicks made while the button said Loading`);
      if (!problems.some((p) => p.startsWith("the button never"))) {
        await ready.first().dblclick();
        await page.waitForURL(/\/take/, { timeout: 45000, waitUntil: "commit" }).catch(() => problems.push("double-clicking Start Test did not open the exam"));
        await waitTake(page).catch(() => problems.push("exam page never showed question 1"));
        await sleep(3000);
      }
      const rows = await subs(s.id, T);
      if (rows.length !== 1) problems.push(`${rows.length} submissions after double-clicking Start Test (expected 1)`);
      if (rows[0] && rows[0].status !== "In Progress") problems.push(`exam status ${rows[0].status}`);
      if (problems.length) fail(problems.join("; "));
      return `${delayed} scripts slowed by ${DELAY / 1000}s: button showed "${early.text}" (disabled) at ${early.at} ms, became Start Test at ${readyMs} ms; double-click → 1 exam In Progress`;
    }), 3 * 60 * 1000);

  // ── D-20261029-3 ─────────────────────────────────────────
  // Typed (grid-in) math answers entered through the real page in the forms the
  // page itself says are accepted: fraction for a whole/decimal key, trailing
  // zero, spaces — and full-width digits from a Chinese IME (looks identical).
  await check("D-20261029-3", [], "數學填答題用不同寫法輸入（分數、多一個 0、前後空白、中文輸入法的全形數字）：看起來對的答案都算對，錯的算錯", "計分", () =>
    asStudent(72, TESTS.mathLinear, async ({ s, page }) => {
      const T = TESTS.mathLinear;
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      const full = (str) => str.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d))).replace(/\./g, "．").replace(/\//g, "／");
      const keyOf = (q) => String(q.correct_answer ?? "").split(/\s*(?:\bor\b|[\n;|])\s*|,\s+/)[0].trim();
      const spr = qs.map((q, i) => ({ q, idx: i + 1, key: keyOf(q) }))
        .filter((x) => x.q.question_type !== "Multiple Choice" && /^-?\d+(\.\d+)?$/.test(x.key));
      if (spr.length < 3) throw new Error(`only ${spr.length} numeric typed-answer questions in Math M1`);
      const forms = [
        ["fraction", (k) => `${Math.round(Number(k) * 2)}/2`, true],
        ["full-width digits", (k) => full(k), true],
        ["wrong number", (k) => String(Number(k) + 1), false],
        ["trailing zero", (k) => (k.includes(".") ? `${k}0` : `${k}.0`), true],
        ["spaces", (k) => `  ${k} `, true],
        ["full-width fraction", (k) => full(`${Math.round(Number(k) * 2)}/2`), true],
      ];
      // The box normalizes input as typed (lib/answer-key.ts sanitizeSprInput,
      // Bluebook-style since 2026-11-07): NFKC (full-width → ASCII), keep only
      // digits . / and a leading minus, max 5 chars (6 with minus). What's
      // saved and shown is that normalized form.
      const norm = (raw) => {
        const s0 = String(raw).normalize("NFKC").replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, "-");
        let out = "";
        for (const ch of s0) { if (/[0-9./]/.test(ch)) out += ch; else if (ch === "-" && out.length === 0) out += ch; }
        return out.slice(0, out.startsWith("-") ? 6 : 5);
      };
      const plan = spr.slice(0, forms.length).map((x, i) => {
        const typed = forms[i][1](x.key);
        return { ...x, label: forms[i][0], typed, stored: norm(typed), expect: forms[i][2] };
      });
      for (const p of plan) {
        await jumpTo(page, p.idx);
        const input = page.locator(`[id="spr-${p.q.id}"]`);
        if (!(await input.isVisible().catch(() => false))) throw new Error(`Q${p.idx} has no typed-answer box (question order mismatch)`);
        await input.fill(p.typed);
      }
      const problems = [];
      const row = await waitRow(m1.id, (r) => plan.every((p) => r.answers?.[p.q.id] === p.stored), 30000);
      const unsaved = plan.filter((p) => row?.answers?.[p.q.id] !== p.stored);
      if (unsaved.length) problems.push(`typed answers not saved (normalized): ${unsaved.map((p) => `Q${p.idx} typed "${p.typed}" expected "${p.stored}" → "${row?.answers?.[p.q.id]}"`).join(", ")}`);
      // After a reload each box must still show what was typed.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitTake(page);
      for (const p of plan) {
        await jumpTo(page, p.idx);
        const shown = await page.locator(`[id="spr-${p.q.id}"]`).inputValue().catch(() => null);
        if (shown !== p.stored) problems.push(`after reload Q${p.idx} box shows "${shown}" (typed "${p.typed}", expected "${p.stored}")`);
      }
      // Submit through the page and read how each one was graded.
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      await page.getByText(/Module 2/).first().waitFor({ timeout: 45000 }).catch(() => {});
      const done = await waitRow(m1.id, (r) => r.status !== "In Progress", 30000);
      if (done?.status === "In Progress") fail(`Module 1 still In Progress after Submit; ${problems.join("; ")}`);
      const { data: recs } = await db.from("answer_records").select("question_id,is_correct,student_answer").eq("submission_id", m1.id);
      const recOf = (id) => (recs ?? []).find((r) => r.question_id === id);
      const graded = plan.map((p) => `Q${p.idx} key ${p.key} typed "${p.typed.trim()}" (${p.label}) → ${recOf(p.q.id)?.is_correct ? "right" : "wrong"}`);
      for (const p of plan) {
        const r = recOf(p.q.id);
        if (!r) { problems.push(`no grading record for Q${p.idx}`); continue; }
        if (r.is_correct !== p.expect) problems.push(`Q${p.idx}: key ${p.key}, student typed "${p.typed}" (${p.label}) → graded ${r.is_correct ? "RIGHT" : "WRONG"}, should be ${p.expect ? "right" : "wrong"}`);
      }
      const nRight = (recs ?? []).filter((r) => r.is_correct).length;
      if (done.correct_count !== nRight) problems.push(`score ${done.correct_count} ≠ ${nRight} questions graded right`);
      if (problems.length) fail(problems.join("; "));
      return graded.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261029-4 ─────────────────────────────────────────
  // Commit 6cb96f2: the admin moves the due date into the past while the
  // student sits on the Module 1 → Module 2 break. The student must still
  // get back in (Resume from the test page), finish Module 2, and neither
  // module may be marked Late — Module 2 inherits Module 1's on-time start.
  await check("D-20261029-4", [], "第一模組交完、還沒開始第二模組時，管理員把截止時間提前到過去：學生還能繼續考完第二模組，兩個模組都不算遲交", "老師/管理員動作", () =>
    asStudent(76, TESTS.adaptive, async ({ s, b, page }) => {
      const T = TESTS.adaptive;
      const orig = (await db.from("tests").select("due_date").eq("id", T).single()).data;
      const admin = await login(b, ADMIN_CLERK);
      const problems = [];
      const notes = [];
      try {
        await startTestBrowser(page, T);
        const [m1] = await subs(s.id, T);
        const q1 = await moduleQs(m1.module_id);
        const mc1 = q1.findIndex((q) => q.question_type === "Multiple Choice");
        if (mc1 < 0) throw new Error("adaptive M1 has no multiple-choice question");
        await jumpTo(page, mc1 + 1);
        await choice(page, "A").click();
        if ((await waitRow(m1.id, (r) => r.answers?.[q1[mc1].id] === "A", 20000))?.answers?.[q1[mc1].id] !== "A")
          throw new Error("M1 answer didn't save (setup)");
        await goToSubmitModal(page, await totalOf(page));
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 });

        // On the break screen: the admin closes the test (due date 1 s after this student's start).
        const dueAt = new Date(m1.started_at).getTime() + 1000;
        const patch = await admin.context.request.patch(`${BASE}/api/admin/tests/${T}`, { data: { dueDate: new Date(dueAt).toISOString() } });
        const due = (await db.from("tests").select("due_date").eq("id", T).single()).data?.due_date;
        if (patch.status() >= 400 || !due || new Date(due).getTime() > Date.now())
          throw new Error(`setup: admin due-date move failed (${patch.status()}, due ${due})`);
        notes.push(`admin moved due date into the past (${patch.status()})`);

        // The student leaves the break screen and comes back through the test page.
        await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
        const landing = (await page.locator("body").innerText()).replace(/\s+/g, " ");
        const resume = page.getByRole("button", { name: /Resume Test|Continue to Module 2/ });
        if (!(await resume.first().isVisible().catch(() => false))) {
          fail(`after the due date moved, the test page offers no way back to Module 2: "${landing.slice(0, 200)}"`);
        }
        await resume.first().click();
        await page.waitForURL(/\/take/, { timeout: 45000, waitUntil: "commit" });
        await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 });
        await waitTake(page);
        const rows = await subs(s.id, T);
        const m2 = rows.find((r) => String(r.adaptive_track).startsWith("module_2"));
        if (!m2) fail("no Module 2 row after pressing Start Module 2");
        const q2 = await moduleQs(m2.module_id);
        const mc2 = q2.findIndex((q) => q.question_type === "Multiple Choice");
        if (mc2 < 0) throw new Error("adaptive M2 has no multiple-choice question");
        await jumpTo(page, mc2 + 1);
        await choice(page, "B").click();
        const saved = await waitRow(m2.id, (r) => r.answers?.[q2[mc2].id] === "B", 20000);
        if (saved?.answers?.[q2[mc2].id] !== "B") problems.push(`Module 2 answer not saved after the due date moved (status ${saved?.status})`);
        await goToSubmitModal(page, await totalOf(page));
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        await page.waitForURL(/\/result/, { timeout: 45000 }).catch(() => problems.push("Module 2 submit did not reach the result page"));
        const done = await waitRow(m2.id, (r) => r.status !== "In Progress", 30000);
        const m1Row = (await db.from("submissions").select("status,submitted_at").eq("id", m1.id).single()).data;
        // Control: both modules were handed in after the (moved) due date, so a plain due-date rule would say Late.
        if (!(new Date(done.submitted_at).getTime() > dueAt && new Date(m1Row.submitted_at).getTime() > dueAt))
          throw new Error("setup: a module was submitted before the moved due date — scenario not exercised");
        if (m1Row.status !== "Submitted") problems.push(`Module 1 is ${m1Row.status} (started on time)`);
        if (done.status !== "Submitted") problems.push(`Module 2 is ${done.status} although the exam started on time`);
        const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
        if (/something went wrong|application error|not found/i.test(body)) problems.push(`result page shows an error: "${body.slice(0, 120)}"`);
        const list = await (await page.context().request.get(`${BASE}/api/student/tests`)).json().catch(() => ({}));
        const mine = (list.data ?? []).find((t) => t.id === T);
        if (!mine) notes.push("closed test no longer in My Tests list");
        else {
          notes.push(`My Tests: ${mine.testStatus}/${mine.attempt?.status}`);
          if (mine.attempt?.status === "Late") problems.push("My Tests shows the attempt as Late");
        }
        notes.push(`M1 ${m1Row.status}, M2 ${done.status} (${m2.adaptive_track})`);
      } finally {
        await db.from("tests").update({ due_date: orig.due_date }).eq("id", T);
        await admin.context.close().catch(() => {});
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261029-5 ─────────────────────────────────────────
  // R&W highlighter: a highlight with a note, and a highlight made right
  // before a refresh, must both come back after the reload on the same
  // words. The offline case (highlight while the Wi-Fi is down, then the
  // tab closes) is recorded, not failed: highlights aren't in the device backup.
  await check("D-20261029-5", [], "英文題劃螢光筆、加筆記，或劃完馬上重新整理：重新整理後螢光筆和筆記都還在原本的字上", "考試流程", () =>
    asStudent(77, TESTS.engLinear, async ({ s, context, page }) => {
      const T = TESTS.engLinear;
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      const NOTE = "qa note: check line 3";
      // Select 20 chars inside the first long text node of a highlightable block, then release the mouse.
      async function highlight() {
        const picked = await page.evaluate(() => {
          for (const root of document.querySelectorAll("[data-anchor]")) {
            if (!root.offsetParent) continue;
            const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n; n = w.nextNode()) {
              const t = n.textContent ?? "";
              if (t.trim().length < 40) continue;
              const r = document.createRange();
              r.setStart(n, 10); r.setEnd(n, 30);
              const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
              document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
              return { anchor: root.dataset.anchor, text: t.slice(10, 30) };
            }
          }
          return null;
        });
        if (!picked) throw new Error("no highlightable text on this question");
        await page.getByRole("button", { name: "Highlight", exact: true }).click({ timeout: 10000 });
        await page.locator("mark.satos-highlight").first().waitFor({ timeout: 10000 });
        return picked;
      }
      const markText = async () => (await page.locator("mark.satos-highlight").allInnerTexts().catch(() => [])).join("|");
      const annoOf = (r, i) => r?.metadata?.annotations?.[qs[i - 1].id];
      const problems = [];
      const notes = [];

      // Q1: highlight + note, wait for the autosave.
      await onQuestion(page, 1);
      const h1 = await highlight();
      await page.locator("mark.satos-highlight").first().click();
      await page.getByPlaceholder(/Add a note for this highlight/).fill(NOTE);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const r1 = await waitRow(m1.id, (r) => (annoOf(r, 1)?.[h1.anchor] ?? []).some((a) => a.note === NOTE), 20000);
      if (!(annoOf(r1, 1)?.[h1.anchor] ?? []).some((a) => a.note === NOTE)) problems.push("Q1 highlight + note never reached the server");

      // Q2: highlight, then refresh straight away (the page-leave save must carry it).
      await jumpTo(page, 2);
      const h2 = await highlight();
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitTake(page);

      await jumpTo(page, 1);
      const back1 = await markText();
      if (back1 !== h1.text) problems.push(`after reload Q1 highlight covers "${back1}" (was "${h1.text}")`);
      else {
        await page.locator("mark.satos-highlight").first().click();
        const noteShown = await page.getByText(NOTE).first().isVisible({ timeout: 5000 }).catch(() => false);
        if (!noteShown) problems.push("after reload the Q1 highlight's note is gone");
        await page.getByRole("button", { name: "Close", exact: true }).first().click().catch(() => {});
      }
      await jumpTo(page, 2);
      const back2 = await markText();
      if (back2 !== h2.text) problems.push(`after reload Q2 highlight covers "${back2}" (was "${h2.text}")`);
      // The reloaded page has been open a while (its own autosaves have run): the server must still hold both.
      await sleep(5000);
      const r2 = (await db.from("submissions").select("metadata").eq("id", m1.id).single()).data;
      if (!(annoOf(r2, 1)?.[h1.anchor] ?? []).some((a) => a.note === NOTE)) problems.push("server copy lost the Q1 highlight + note");
      if (!(annoOf(r2, 2)?.[h2.anchor] ?? []).length) problems.push("server copy lost the Q2 highlight made just before the refresh");
      notes.push(`Q1 "${h1.text}" + note ${back1 === h1.text ? "kept" : "lost"}, Q2 "${h2.text}" (refreshed at once) ${back2 === h2.text ? "kept" : "lost"} after reload`);

      // Recorded only: Wi-Fi drops, student highlights + flags Q3, tab closes; reopen online.
      await jumpTo(page, 3);
      await context.setOffline(true);
      const h3 = await highlight();
      await page.getByRole("button", { name: /Mark for Review/ }).click();
      await sleep(2000);
      await page.close();
      await context.setOffline(false);
      const p2 = await context.newPage();
      await p2.goto(`${BASE}/student/tests/${T}/take`, { waitUntil: "domcontentloaded" });
      await p2.getByText(/Question \d+ of \d+/).first().waitFor({ timeout: 45000 });
      await sleep(3000);
      const r3 = await waitRow(m1.id, (r) => (r.metadata?.flagged ?? []).includes(qs[2].id), 15000);
      const flagKept = (r3?.metadata?.flagged ?? []).includes(qs[2].id);
      const hiKept = (annoOf(r3, 3)?.[h3.anchor] ?? []).length > 0;
      notes.push(`offline + tab closed: flag ${flagKept ? "kept" : "lost"}, highlight ${hiKept ? "kept" : "lost"} (recorded)`);
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261029-6 ─────────────────────────────────────────
  // The admin force-submits Module 1 while the student still has it open.
  // Answers saved before are graded; the stale tab must not claim later
  // answers are "Saved"; the graded module stays frozen; and pressing
  // Submit must lead the student on to Module 2 (exactly one), not a dead end.
  await check("D-20261029-6", [], "學生考試中、管理員按「強制交卷」：已存的答案照算分；學生畫面不能假裝還在存檔；按交卷後能接著考第二模組（只有一份）", "老師/管理員動作", () =>
    asStudent(79, TESTS.mathLinear, async ({ s, b, page }) => {
      const T = TESTS.mathLinear;
      const admin = await login(b, ADMIN_CLERK);
      const problems = [];
      const notes = [];
      try {
        await startTestBrowser(page, T);
        const [m1] = await subs(s.id, T);
        const qs = await moduleQs(m1.module_id);
        const mc = qs.map((q, i) => ({ q, idx: i + 1, key: String(q.correct_answer ?? "").trim().toUpperCase() }))
          .filter((x) => x.q.question_type === "Multiple Choice" && /^[A-D]$/.test(x.key));
        if (mc.length < 3) throw new Error(`only ${mc.length} MC questions in Math M1`);
        const [right, wrong, late] = mc;
        const wrongPick = ["A", "B", "C", "D"].find((l) => l !== wrong.key);
        await jumpTo(page, right.idx); await choice(page, right.key).click();
        await jumpTo(page, wrong.idx); await choice(page, wrongPick).click();
        const pre = await waitRow(m1.id, (r) => r.answers?.[right.q.id] === right.key && r.answers?.[wrong.q.id] === wrongPick, 20000);
        if (pre?.answers?.[wrong.q.id] !== wrongPick) throw new Error("answers didn't save before force-submit (setup)");

        const fs = await admin.context.request.post(`${BASE}/api/admin/submissions/${m1.id}/force-submit`, {});
        const fsJ = await fs.json().catch(() => ({}));
        if (fs.status() >= 400) fail(`admin force-submit → ${fs.status()} ${JSON.stringify(fsJ).slice(0, 120)}`);
        const graded = (await db.from("submissions").select("status,answers,correct_count").eq("id", m1.id).single()).data;
        if (graded.status === "In Progress") fail("force-submit returned OK but Module 1 is still In Progress");
        const { data: recs } = await db.from("answer_records").select("question_id,is_correct").eq("submission_id", m1.id);
        const isRight = (id) => (recs ?? []).find((r) => r.question_id === id)?.is_correct;
        if (isRight(right.q.id) !== true || isRight(wrong.q.id) !== false || graded.correct_count !== 1)
          problems.push(`force-submit grading: Q${right.idx} ${isRight(right.q.id)}, Q${wrong.idx} ${isRight(wrong.q.id)}, score ${graded.correct_count} (expected 1)`);
        notes.push(`force-submit ${fs.status()} → ${graded.status}, score ${graded.correct_count}`);

        // The student, still on the old page, answers one more question.
        await jumpTo(page, late.idx); await choice(page, "A").click();
        const status = page.locator('[role="status"]').filter({ hasText: /Saved|Saving|Not saved/ }).first();
        await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((e) => /Not saved/.test(e.textContent)), null, { timeout: 15000 }).catch(() => {});
        const shown = (await status.innerText().catch(() => "?")).trim();
        notes.push(`stale tab after a new pick shows "${shown}"`);
        if (/^Saved$/.test(shown)) problems.push(`after force-submit the student's page still says "Saved" for an answer that wasn't saved`);
        const frozen = (await db.from("submissions").select("status,answers,correct_count").eq("id", m1.id).single()).data;
        if (JSON.stringify(frozen) !== JSON.stringify(graded)) problems.push("the force-submitted Module 1 changed after the student kept clicking");

        // Student presses Submit on the stale page: must land on Module 2 (or a clear Continue button).
        await goToSubmitModal(page, await totalOf(page));
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        const landed = await Promise.race([
          page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => "intro"),
          page.getByRole("button", { name: /Continue to Module 2/ }).first().waitFor({ timeout: 45000 }).then(() => "continue"),
          page.getByText(/Question \d+ of \d+/).first().waitFor({ timeout: 45000 }).then(async () => { await sleep(2000); return page.url().includes("/take") ? "take" : "other"; }),
        ]).catch(() => "nowhere");
        notes.push(`submit on stale page → ${landed} (${new URL(page.url()).pathname.split("/").pop()})`);
        if (landed === "continue") {
          await page.getByRole("button", { name: /Continue to Module 2/ }).first().click();
          await page.waitForURL(/\/take/, { timeout: 45000, waitUntil: "commit" });
          await page.getByText("Module 1 submitted").first().waitFor({ timeout: 30000 }).catch(() => problems.push("Continue to Module 2 did not open the Module 2 start screen"));
        } else if (landed === "nowhere" || landed === "other") {
          const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
          problems.push(`after pressing Submit the student is stuck: ${page.url().replace(BASE, "")} "${body.slice(0, 150)}"`);
        }
        await sleep(2000);
        const rows = await subs(s.id, T);
        const m2s = rows.filter((r) => String(r.adaptive_track).startsWith("module_2"));
        if (m2s.length !== 1) problems.push(`${m2s.length} Module 2 rows (expected 1)`);
        else if (m2s[0].status !== "In Progress" || m2s[0].session_id !== m1.session_id) problems.push(`Module 2 row ${m2s[0].status}, same session ${m2s[0].session_id === m1.session_id}`);
        if (rows.filter((r) => r.adaptive_track === "module_1").length !== 1) problems.push("a second Module 1 attempt was created");
      } finally {
        await admin.context.close().catch(() => {});
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261031-1 ─────────────────────────────────────────
  // Commit c91c19c (submit watchdog). (A) Module 1: the submit reaches the
  // server but its reply never comes back — the page must notice by polling
  // and open Module 2 well before its own 20 s timeout would. (B) Module 2:
  // the submit never reaches the server — after ~15 s a "Still submitting"
  // banner with a Continue button must appear, and Continue must get the
  // exam submitted and open the result page with the answer kept.
  await check("D-20261031-1", [], "交卷時網路卡住（伺服器其實收到了、或根本沒收到）：不會一直卡在「Submitting…」，會自動進第二模組，或出現「繼續」按鈕、按了就交卷成功", "考試流程", () =>
    asStudent(73, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      const SUBMIT = /\/api\/student\/submissions\/[^/?]+\/submit(\?|$)/;
      const problems = [];
      const notes = [];
      try {
        await startTestBrowser(page, T);
        const [m1] = await subs(s.id, T);
        const q1 = await moduleQs(m1.module_id);
        await onQuestion(page, 1);
        await choice(page, "A").click();
        if ((await waitRow(m1.id, (r) => r.answers?.[q1[0].id] === "A", 20000))?.answers?.[q1[0].id] !== "A")
          throw new Error("M1 answer didn't save (setup)");

        // (A) First submit is delivered to the server; its reply is swallowed.
        let aCalls = 0;
        let aServer = null;
        await page.route(SUBMIT, async (route) => {
          aCalls++;
          if (aCalls === 1) {
            try { aServer = (await route.fetch({ timeout: 30000 })).status(); } catch (e) { aServer = `error ${String(e.message).slice(0, 40)}`; }
            return; // never fulfilled: the reply is "lost"
          }
          await route.continue().catch(() => {});
        });
        await goToSubmitModal(page, await totalOf(page));
        const tA = Date.now();
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        const movedOn = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
        const aMs = Date.now() - tA;
        await page.unrouteAll({ behavior: "ignoreErrors" });
        if (aServer !== 200) throw new Error(`setup: the held Module 1 submit got ${aServer} from the server`);
        if (!movedOn) {
          const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
          fail(`Module 1 submit landed on the server but the reply was lost: after 45 s the student is still not on Module 2 (${page.url().replace(BASE, "")} "${body.slice(0, 150)}")`);
        }
        if (aMs >= 19000) problems.push(`Module 1 submit landed but the page only moved on after ${(aMs / 1000).toFixed(1)} s (its own 20 s timeout, not the status check)`);
        notes.push(`A: M1 reply lost → Module 2 screen after ${(aMs / 1000).toFixed(1)} s (${aCalls} submit request(s))`);
        const afterA = await subs(s.id, T);
        const m1Row = afterA.find((r) => r.id === m1.id);
        const m2s = afterA.filter((r) => String(r.adaptive_track).startsWith("module_2"));
        if (m1Row?.status !== "Submitted") problems.push(`Module 1 is ${m1Row?.status}`);
        if (m1Row?.answers?.[q1[0].id] !== "A") problems.push("Module 1 answer lost");
        if (m2s.length !== 1) fail(`${m2s.length} Module 2 rows after the lost reply (expected 1). ${problems.join("; ")}`);

        // (B) Module 2: the first submit never reaches the server.
        await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 });
        await waitTake(page);
        const m2 = m2s[0];
        const q2 = await moduleQs(m2.module_id);
        await onQuestion(page, 1);
        await choice(page, "B").click();
        if ((await waitRow(m2.id, (r) => r.answers?.[q2[0].id] === "B", 20000))?.answers?.[q2[0].id] !== "B")
          throw new Error("M2 answer didn't save (setup)");
        let bCalls = 0;
        const bTimes = [];
        await page.route(SUBMIT, async (route) => {
          bCalls++;
          bTimes.push(Date.now());
          if (bCalls === 1) return; // swallowed: never reaches the server
          await route.continue().catch(() => {});
        });
        await goToSubmitModal(page, await totalOf(page));
        const tB = Date.now();
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        const banner = page.locator('[role="alert"]').filter({ hasText: /Still submitting|longer than usual/ }).first();
        const sawBanner = await banner.waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
        const bannerMs = Date.now() - tB;
        if (!sawBanner) {
          problems.push("no 'Still submitting' banner with a Continue button within 25 s of a stuck submit");
        } else {
          notes.push(`B: banner after ${(bannerMs / 1000).toFixed(1)} s`);
          await banner.getByRole("button", { name: /^Continue/ }).click({ timeout: 5000 }).catch(() => problems.push("banner's Continue button could not be pressed"));
        }
        const toResult = await page.waitForURL(/\/result/, { timeout: 45000 }).then(() => true).catch(() => false);
        const bMs = Date.now() - tB;
        await page.unrouteAll({ behavior: "ignoreErrors" });
        if (!toResult) {
          const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
          problems.push(`Module 2 submit never reached the result page (${page.url().replace(BASE, "")} "${body.slice(0, 150)}")`);
        }
        const retryAt = bTimes[1] ? ((bTimes[1] - tB) / 1000).toFixed(1) : "none";
        notes.push(`B: result page after ${(bMs / 1000).toFixed(1)} s, retry sent at ${retryAt} s (${bCalls} submit request(s))`);
        const done = await waitRow(m2.id, (r) => r.status !== "In Progress", 20000);
        if (done?.status !== "Submitted") problems.push(`Module 2 is ${done?.status} after Continue`);
        if (done?.answers?.[q2[0].id] !== "B") problems.push("Module 2 answer lost");
        const rows = await subs(s.id, T);
        if (rows.length !== 2) problems.push(`${rows.length} submission rows (expected M1 + M2)`);
        if (toResult) {
          const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
          if (/something went wrong|application error|not found/i.test(body)) problems.push(`result page shows an error: "${body.slice(0, 120)}"`);
        }
      } finally {
        await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261031-2 ─────────────────────────────────────────
  // Commit 2fb4f73 (per-student answer visibility). On a test that shows
  // answers after submission: an admin's per-student Hide must hide them
  // (only for that student), Show-without-explanations must strip every
  // explanation, a retake in progress must hide the old attempt's answers,
  // and a student still taking the exam must not get the answer key from
  // the class-review page when the teacher has unlocked it.
  await check("D-20261031-2", [], "管理員對個別學生隱藏答案、或只給答案不給解析；學生重考中；學生還在考時老師開了全班檢討：學生在成績頁、成績資料、檢討頁都只看得到被允許的內容", "安全", async () => {
    const T = TESTS.mathLinear;
    const main = studentByN(77), other = studentByN(79), taker = studentByN(76);
    if (!main || !other || !taker) throw new Error("students 076/077/079 not found");
    const orig = C.students[0].id;
    const studs = [main, other, taker];
    const t0 = (await db.from("tests").select("module_id,module_2_id,review_unlocked,show_answers_after_submission,show_explanations_after_submission,allow_retake").eq("id", T).single()).data;
    if (!t0.show_answers_after_submission || t0.show_explanations_after_submission === false || !t0.allow_retake || t0.review_unlocked)
      throw new Error(`setup: mathLinear flags changed (${JSON.stringify(t0)})`);
    const clean = async () => {
      for (const st of studs) {
        await deleteSubs(st.id, T).catch(() => {});
        await db.from("student_answer_visibility").delete().eq("test_id", T).eq("student_id", st.id);
        await db.from("student_answer_visibility_log").delete().eq("test_id", T).eq("student_id", st.id);
      }
    };
    // Text that only appears when explanations / the question review are on the page.
    const { data: qrows } = await db.from("questions").select("module_id,explanation,question_text").in("module_id", [t0.module_id, t0.module_2_id]).eq("parsing_status", "Approved");
    const run = (x) => String(x ?? "").match(/[A-Za-z][A-Za-z0-9 ,]{24,}/)?.[0]?.slice(0, 24);
    const expl = [...new Set((qrows ?? []).map((q) => run(q.explanation)).filter(Boolean))];
    const stems = [...new Set((qrows ?? []).map((q) => run(q.question_text)).filter(Boolean))];
    if (expl.length < 5 || stems.length < 5) throw new Error(`only ${expl.length} explanation / ${stems.length} question snippets usable`);
    const seen = (html, list) => list.filter((x) => html.includes(x)).length;
    const problems = [];
    const notes = [];
    await clean();
    const b = await chromium.launch();
    let admin;
    try {
      admin = await login(b, ADMIN_CLERK);
      const setMode = async (st, mode, showExplanations = true) => {
        const r = await admin.context.request.post(`${BASE}/api/teacher/tests/${T}/student-answer-visibility`, { data: { studentId: st.id, mode, showExplanations } });
        if (r.status() !== 200) throw new Error(`setup: admin set ${mode} → ${r.status()} ${(await r.text()).slice(0, 120)}`);
      };
      // What a student can read: result API (M1) + result page (whole attempt).
      const look = async (R, a) => {
        const api = await R.get(`${BASE}/api/student/submissions/${a.m1Id}/result`);
        const j = await api.json().catch(() => ({}));
        const d = j.data?.answerDetails ?? null;
        const html = await (await R.get(`${BASE}/student/tests/${T}/result?submission=${a.m2Id ?? a.m1Id}`)).text();
        return {
          api: api.status(),
          answers: Array.isArray(d) ? d.length : 0,
          keys: Array.isArray(d) ? d.filter((r) => r.correct_answer != null).length : 0,
          apiExpl: Array.isArray(d) ? d.filter((r) => r.questions?.explanation).length : 0,
          pageExpl: seen(html, expl),
          pageStems: seen(html, stems),
        };
      };
      const fmt = (v) => `API ${v.answers} answers/${v.apiExpl} expl, page ${v.pageStems} questions/${v.pageExpl} expl`;

      // 079 finishes an attempt (no override).
      let x = await borrowAs(b, 79);
      const aOther = await apiTakeTest(x.context.request, other.id, T);
      await x.context.close();

      // 077 finishes an attempt; control: answers + explanations visible.
      x = await borrowAs(b, 77);
      let R = x.context.request;
      const a1 = await apiTakeTest(R, main.id, T);
      if (!a1.m2Id) throw new Error("setup: mathLinear attempt has no Module 2");
      const ctl = await look(R, a1);
      if (!(ctl.keys > 0 && ctl.apiExpl > 0 && ctl.pageExpl > 0 && ctl.pageStems > 0))
        throw new Error(`setup: with the test showing answers, 077 can't see them (${fmt(ctl)}) — scan not valid`);
      notes.push(`follow: ${fmt(ctl)}`);

      // Hide → nothing.
      await setMode(main, "hide");
      const hid = await look(R, a1);
      if (hid.answers || hid.pageExpl || hid.pageStems) problems.push(`admin set Hide, student still sees: ${fmt(hid)}`);
      notes.push(`hide: ${fmt(hid)}`);

      // Show, no explanations → answers yes, explanations nowhere.
      await setMode(main, "show", false);
      const noEx = await look(R, a1);
      if (!noEx.keys) problems.push(`Show (answers only): the answers aren't shown (${fmt(noEx)})`);
      if (noEx.apiExpl || noEx.pageExpl) problems.push(`Show without explanations, student still gets explanations: ${fmt(noEx)}`);
      notes.push(`show/no-expl: ${fmt(noEx)}`);

      // Retake in progress → the first attempt's answers are hidden, even with Show.
      await setMode(main, "show", true);
      const st2 = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const retakeId = (await st2.json().catch(() => ({}))).data?.id;
      const retake = retakeId && (await db.from("submissions").select("attempt_number,status").eq("id", retakeId).single()).data;
      if (!retake || retake.attempt_number !== 2) throw new Error(`setup: retake start ${st2.status()} → ${JSON.stringify(retake)}`);
      const mid = await look(R, a1);
      if (mid.answers || mid.pageExpl || mid.pageStems) problems.push(`during a retake the old attempt's answers are visible: ${fmt(mid)}`);
      notes.push(`retake in progress: ${fmt(mid)}`);
      // Teacher unlocks class review (admin toggle) while the retake is running.
      const rv = await admin.context.request.post(`${BASE}/api/teacher/tests/${T}/review-mode`, { data: { unlocked: true } });
      if (rv.status() !== 200) throw new Error(`setup: review unlock → ${rv.status()}`);
      const rvMid = await (await R.get(`${BASE}/student/tests/${T}/review`)).text();
      if (seen(rvMid, expl) || seen(rvMid, stems)) problems.push(`during a retake the class-review page shows the answer key (${seen(rvMid, stems)} questions, ${seen(rvMid, expl)} explanations)`);
      // Retake finished → visible again (Show restores).
      const a2 = await apiTakeTest(R, main.id, T);
      const after = await look(R, a2);
      if (!after.keys) problems.push(`after the retake was submitted the answers did not come back (${fmt(after)})`);
      notes.push(`retake done: ${fmt(after)}`);
      // Hide also closes class review for this student.
      await setMode(main, "hide");
      const rvHide = await (await R.get(`${BASE}/student/tests/${T}/review`)).text();
      if (seen(rvHide, expl) || seen(rvHide, stems)) problems.push(`Hide set, but the class-review page still shows the answer key (${seen(rvHide, stems)} questions)`);
      await x.context.close();

      // 079 (no override) is unaffected by 077's Hide; class review open for them.
      x = await borrowAs(b, 79);
      R = x.context.request;
      const oth = await look(R, aOther);
      if (!oth.keys || !oth.pageExpl) problems.push(`077's Hide also hid answers from 079: ${fmt(oth)}`);
      const rvOther = await (await R.get(`${BASE}/student/tests/${T}/review`)).text();
      const rvOtherSeen = seen(rvOther, stems);
      if (!rvOtherSeen) throw new Error("setup: class review unlocked but 079 sees no questions on it — scan not valid");
      notes.push(`079 unaffected: ${fmt(oth)}; review ${rvOtherSeen} questions`);
      await x.context.close();

      // 076 is taking the exam right now (first attempt, In Progress).
      x = await borrowAs(b, 76);
      R = x.context.request;
      const st3 = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const inProg = (await st3.json().catch(() => ({}))).data?.id;
      if (!inProg) throw new Error(`setup: 076 start ${st3.status()}`);
      const rvLive = await (await R.get(`${BASE}/student/tests/${T}/review`)).text();
      const liveS = seen(rvLive, stems), liveE = seen(rvLive, expl);
      if (liveS || liveE) problems.push(`a student still taking the exam (In Progress) opens the class-review page and gets the answer key of the exam they're taking: ${liveS} questions, ${liveE} explanations`);
      const landing = await (await R.get(`${BASE}/student/tests/${T}`)).text();
      if (landing.includes(`/student/tests/${T}/review`)) notes.push("test page offers the review link mid-exam");
      notes.push(`in-progress student, review unlocked: ${liveS} questions/${liveE} explanations`);
      await x.context.close();
    } finally {
      await db.from("tests").update({ review_unlocked: t0.review_unlocked }).eq("id", T);
      await admin?.context.close().catch(() => {});
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await clean();
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 4 * 60 * 1000);

  // ── D-20261031-3 ─────────────────────────────────────────
  // iPad (Safari engine, touch) in portrait, turned to landscape mid-exam and
  // back: the question, the picked answer and the timer must survive each
  // turn, every control must stay on screen and tappable, and submitting by
  // touch must work. (H-14-15 covers phones; EDGE-SMALL-SCREEN laptops.)
  await check("D-20261031-3", [], "用 iPad 考試、中途把 iPad 轉橫再轉直：題目、選好的答案、倒數時間都不會跑掉，按鈕都點得到，用手指點交卷也能交", "裝置/瀏覽器", async () => {
    const T = TESTS.engLinear;
    const s = studentByN(72);
    if (!s) throw new Error("student 072 not found");
    const orig = C.students[0].id;
    const { devices } = await import("playwright");
    const ipad = devices["iPad (gen 7)"];
    await deleteSubs(s.id, T);
    const b = await webkit.launch();
    const problems = [];
    const notes = [];
    try {
      await borrowLogin(s.id, STUDENT1_CLERK);
      const { page } = await login(b, STUDENT1_CLERK, { ...ipad });
      const next = page.getByRole("button", { name: /^Next/ }).first();
      const inView = async (loc, what, tag) => {
        const el = loc.first();
        if (!(await el.isVisible().catch(() => false))) { problems.push(`${tag}: ${what} not visible`); return; }
        await el.scrollIntoViewIfNeeded().catch(() => {});
        const box = await el.boundingBox();
        const vp = page.viewportSize();
        if (!box || box.x < 0 || box.y < 0 || box.x + box.width > vp.width + 1 || box.y + box.height > vp.height + 1)
          problems.push(`${tag}: ${what} sticks out of the screen (${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}` : "no box"})`);
      };
      const timerSecs = async () => {
        const m = (await page.getByRole("timer").first().innerText().catch(() => "")).match(/(\d+):(\d{2})/);
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
      };
      const picked = async (l) => (await choice(page, l).getAttribute("aria-checked").catch(() => null)) === "true";
      const screen = async (tag) => {
        await inView(page.getByRole("timer"), "timer", tag);
        for (const l of ["A", "B", "C", "D"]) await inView(choice(page, l), `choice ${l}`, tag);
        await inView(next, "Next", tag);
        await inView(page.getByRole("button", { name: /Mark for Review|Marked for Review/ }), "Mark for Review", tag);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) problems.push(`${tag}: page scrolls sideways by ${overflow}px`);
      };
      const turn = async (w, h) => {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate(() => window.dispatchEvent(new Event("orientationchange"))).catch(() => {});
        await sleep(1500);
      };

      // Safari's post-sign-in redirect to /student can cut the first navigation short.
      await page.waitForURL(/\/student/, { timeout: 30000 }).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await startTestBrowser(page, T).catch(async () => { await sleep(2000); await startTestBrowser(page, T); });
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      await onQuestion(page, 1);
      const passageShown = await page.locator("[data-anchor]").first().isVisible().catch(() => false);
      if (!passageShown) problems.push("portrait: the passage / question text is not shown");
      await screen("portrait");
      await choice(page, "A").tap();
      if ((await waitRow(m1.id, (r) => r.answers?.[qs[0].id] === "A", 20000))?.answers?.[qs[0].id] !== "A") problems.push("portrait: tapped answer A was not saved");
      const t1 = await timerSecs();
      if (t1 == null) throw new Error("can't read the timer");

      // Turn to landscape.
      await turn(ipad.viewport.height, ipad.viewport.width);
      if (!(await page.getByText(/Question 1 of \d+/).first().isVisible().catch(() => false))) problems.push("landscape: no longer on Question 1 after turning the iPad");
      if (!(await picked("A"))) problems.push("landscape: answer A no longer shown as picked after turning the iPad");
      const t2 = await timerSecs();
      if (t2 == null || t2 > t1 || t1 - t2 > 15) problems.push(`landscape: timer jumped from ${t1}s to ${t2}s after turning the iPad`);
      await screen("landscape");
      await next.tap();
      await onQuestion(page, 2);
      await choice(page, "C").tap();
      if ((await waitRow(m1.id, (r) => r.answers?.[qs[1].id] === "C", 20000))?.answers?.[qs[1].id] !== "C") problems.push("landscape: tapped answer C on Q2 was not saved");

      // Back to portrait.
      await turn(ipad.viewport.width, ipad.viewport.height);
      if (!(await page.getByText(/Question 2 of \d+/).first().isVisible().catch(() => false))) problems.push("portrait again: no longer on Question 2");
      if (!(await picked("C"))) problems.push("portrait again: answer C no longer shown as picked");
      const t3 = await timerSecs();
      if (t3 == null || t3 > t2 || t2 - t3 > 30) problems.push(`portrait again: timer jumped from ${t2}s to ${t3}s`);
      await screen("portrait again");
      await jumpTo(page, 1);
      if (!(await picked("A"))) problems.push("portrait again: Q1 answer A no longer shown as picked");
      notes.push(`timer ${t1}s → ${t2}s → ${t3}s across two turns`);

      // Submit by touch.
      await jumpTo(page, await totalOf(page));
      const rs = page.getByRole("button", { name: /Review & Submit/ });
      await inView(rs, "Review & Submit", "portrait again");
      await rs.tap();
      const sub = page.getByRole("button", { name: /Submit Test/ }).last();
      await sub.waitFor({ timeout: 15000 });
      await inView(sub, "Submit Test", "portrait again");
      await sub.tap();
      const moved = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
      if (!moved) problems.push("tapping Submit Test did not lead to the Module 2 screen");
      const done = await waitRow(m1.id, (r) => r.status !== "In Progress", 20000);
      if (done?.status !== "Submitted") problems.push(`after tapping Submit Test Module 1 is ${done?.status}`);
      const kept = [qs[0].id, qs[1].id].filter((id, i) => done?.answers?.[id] === ["A", "C"][i]).length;
      if (kept !== 2) problems.push(`${kept}/2 answers kept after submit`);
      notes.push(`submitted by touch: ${done?.status}, ${kept}/2 answers kept; all controls on screen in portrait and landscape`);
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await deleteSubs(s.id, T).catch(() => {});
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 3 * 60 * 1000);

  // ── D-20261031-4 ─────────────────────────────────────────
  // Commit 001319e (support b1cf70bf). The Desmos panel is desmos.com in an
  // iframe; with a graph on it, Desmos asks "leave this graph?" on unload,
  // which made the browser show "Leave site?" and hold the student on the
  // page after a submit that had landed. Use Desmos in both modules, submit
  // each: Module 2 / the result must open with no prompt. Also lists real
  // Math students whose Module 2 started > 5 min after Module 1 landed in the
  // last 24 h (may include time on the intro screen — a lead, not a failure).
  await check("D-20261031-4", [], "數學考試用過 Desmos 計算機（畫了圖）再交卷：不會跳出「Leave site?」，直接進第二模組、再直接到成績頁", "考試流程", () =>
    asStudent(74, TESTS.mathLinear, async ({ s, page }) => {
      const T = TESTS.mathLinear;
      const dialogs = [];
      page.on("dialog", async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss().catch(() => {}); });
      async function useDesmos(label) {
        await page.locator('button[title="Desmos calculator"]').click();
        const ifr = page.locator('iframe[title="Desmos calculator"]');
        await ifr.waitFor({ timeout: 20000 });
        await sleep(7000);
        const frame = page.frames().find((f) => f.url().includes("desmos"));
        const bb = await ifr.boundingBox();
        await page.mouse.click(bb.x + 120, bb.y + 90);
        await page.keyboard.type("y=2x+1");
        const n = await frame.evaluate(() => { window.Calc?.setExpression({ id: "qa", latex: "y=x^2" }); return window.Calc?.getExpressions?.().length ?? 0; });
        if (!n) throw new Error(`setup: no Desmos graph in ${label}`);
      }
      const notes = [];
      await startTestBrowser(page, T);
      await onQuestion(page, 1);
      await choice(page, "A").click();
      await useDesmos("Module 1");
      await goToSubmitModal(page, await totalOf(page));
      let t0 = Date.now();
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      const m2 = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
      if (!m2) fail(`after using Desmos, Module 1 submit did not open Module 2 within 45 s (dialogs: ${dialogs.join(" | ") || "none"})`);
      notes.push(`M1→M2 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      await page.locator('a:has-text("Start Module 2")').click();
      await waitTake(page);
      await onQuestion(page, 1);
      await choice(page, "A").click();
      await useDesmos("Module 2");
      await goToSubmitModal(page, await totalOf(page));
      t0 = Date.now();
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      const res = await page.waitForURL(/\/result/, { timeout: 45000 }).then(() => true).catch(() => false);
      if (!res) fail(`after using Desmos, Module 2 submit did not open the result page within 45 s (dialogs: ${dialogs.join(" | ") || "none"})`);
      notes.push(`M2→result ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (dialogs.length) fail(`"Leave site?"-type prompt shown: ${dialogs.join(" | ")}`);
      const rows = await subs(s.id, T);
      if (rows.filter((r) => r.status !== "In Progress").length !== 2) fail(`expected 2 submitted modules, got ${JSON.stringify(rows.map((r) => r.status))}`);

      // Real students, last 24 h: slow Module 1 → Module 2 on Math tests.
      const since = new Date(Date.now() - 864e5).toISOString();
      const { data: m2rows } = await db.from("submissions").select("student_id,session_id,metadata,section:modules(section)").eq("adaptive_track", "module_2").gte("started_at", since);
      const slow = [];
      for (const r of m2rows ?? []) {
        if (r.section?.section !== "Math" || !r.metadata?.module_2_started_at || !r.session_id) continue;
        const { data: m1 } = await db.from("submissions").select("submitted_at").eq("session_id", r.session_id).eq("adaptive_track", "module_1").maybeSingle();
        const gap = m1?.submitted_at ? (Date.parse(r.metadata.module_2_started_at) - Date.parse(m1.submitted_at)) / 60000 : null;
        if (gap != null && gap > 5) slow.push(`${r.student_id.slice(0, 8)} ${gap.toFixed(1)} min`);
      }
      notes.push(slow.length ? `real Math M1→M2 > 5 min (check): ${slow.join(", ")}` : "no real Math M1→M2 > 5 min in 24 h");
      return notes.join("; ");
    }), 4 * 60 * 1000);
  // ── D-20261101-1 ─────────────────────────────────────────
  // Commits b58588d / ab051a5 / a3d3133 (one score display everywhere). One
  // two-module Math attempt with a known number right in each module. While
  // Module 2 is still open, no page may show an SAT score (per-module SAT is
  // gone). Once both are in, every page — the student's My Tests, Results and
  // result page, the teacher's results + test detail, the admin test detail
  // and the CSV export — must show the same SAT, equal to the curve applied
  // by hand to (right in M1 + M2) / (questions in M1 + M2), and the same
  // "M1 a/b · M2 c/d". M1 alone is chosen to give a different SAT, so a page
  // that scores only one module is caught.
  await check("D-20261101-1", [], "考完兩個模組後，學生、老師、管理員各頁面和匯出檔顯示的 SAT 分數和每個模組答對數都一樣而且算對；第二模組還沒考完時不能顯示 SAT 分數", "計分", () =>
    asStudent(76, TESTS.mathLinear, async ({ s, b, page, context }) => {
      const T = TESTS.mathLinear;
      const R = context.request;
      // Independent copy of the estimator curve (lib/scoring.ts ANCHORS) and
      // grading's 1-decimal percent.
      const A = [[0, 200], [25, 340], [40, 420], [55, 510], [65, 570], [75, 630], [85, 690], [92, 740], [96, 770], [100, 800]];
      const curve = (p) => { for (let i = 1; i < A.length; i++) if (p <= A[i][0]) { const t = (p - A[i - 1][0]) / (A[i][0] - A[i - 1][0]); return Math.round((A[i - 1][1] + t * (A[i][1] - A[i - 1][1])) / 10) * 10; } return 800; };
      const satOf = (k, n) => curve(Math.round((k / n) * 1000) / 10);
      const testName = (await db.from("tests").select("test_name").eq("id", T).single()).data.test_name;
      const mcOf = (qs) => qs.map((q) => ({ q, key: String(q.correct_answer ?? "").trim().toUpperCase() })).filter((x) => x.q.question_type === "Multiple Choice" && /^[A-D]$/.test(x.key));
      // right = how many MC to get right; the remaining MC are answered wrong; SPR left blank.
      const plan = (qs, right) => Object.fromEntries(mcOf(qs).map((x, i) => [x.q.id, i < right ? x.key : ["A", "B", "C", "D"].find((l) => l !== x.key)]));

      const st = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const m1Id = (await st.json().catch(() => ({}))).data?.id;
      if (!m1Id) throw new Error(`setup: start ${st.status()}`);
      const m1Row = (await db.from("submissions").select("module_id").eq("id", m1Id).single()).data;
      const q1 = await moduleQs(m1Row.module_id);
      const k1Plan = Math.min(mcOf(q1).length, 12);
      if (k1Plan < 8) throw new Error(`setup: only ${mcOf(q1).length} MC questions in M1`);
      const ans1 = plan(q1, k1Plan);
      if ((await R.patch(`${BASE}/api/student/submissions/${m1Id}`, { data: { answers: ans1, metadata: {} } })).status() >= 400) throw new Error("setup: M1 save failed");
      const sub1 = await R.post(`${BASE}/api/student/submissions/${m1Id}/submit`, { data: { answers: ans1, metadata: {} } });
      const m2Id = (await sub1.json().catch(() => ({}))).data?.nextSubmissionId;
      if (!m2Id) throw new Error(`setup: M1 submit ${sub1.status()} gave no Module 2`);
      const g1 = (await db.from("submissions").select("correct_count,total_questions,status").eq("id", m1Id).single()).data;
      const problems = [], notes = [];
      if (g1.correct_count !== k1Plan) problems.push(`Module 1 graded ${g1.correct_count} right, expected ${k1Plan}`);
      const n1 = g1.total_questions;
      if (n1 !== q1.length) problems.push(`Module 1 total_questions ${n1} ≠ ${q1.length} approved questions`);

      const admin = await login(b, ADMIN_CLERK);
      // The Math teacher of the student's own class (teachers only see their classes).
      const { data: mem } = await db.from("class_group_members").select("class_group_id").eq("student_id", s.id);
      const { data: cgt } = await db.from("class_group_teachers").select("teacher_id,subject").in("class_group_id", (mem ?? []).map((m) => m.class_group_id)).eq("subject", "Math");
      // (Student 076 is in TEST Class A, whose Math teacher, Teacher 01, has a login.)
      const tq = C.teachers.find((t) => t.clerkId && (cgt ?? []).some((x) => x.teacher_id === t.id));
      if (!tq) throw new Error("setup: no QA Math teacher with a login for this student's class");
      const teacher = await login(b, tq.clerkId);
      const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
      const MODS = /M1 (\d+\/\d+|—) · M2 (\d+\/\d+|—)/;
      // A table row: module counts + the big SAT number (ScoreCell's bold div).
      const rowOf = async (pg, url, hasText) => {
        await pg.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
        const row = pg.locator("tbody tr", { hasText }).first();
        if (!(await row.count())) return { missing: true };
        const txt = norm(await row.innerText());
        const sat = await row.locator("div.font-bold").evaluateAll((ds) => ds.map((d) => d.textContent.trim()).find((x) => /^\d{3}$/.test(x)) ?? null);
        return { mods: txt.match(MODS)?.[0] ?? null, sat: sat ? Number(sat) : null, txt: txt.slice(0, 140) };
      };
      const resultPage = async () => {
        await page.goto(`${BASE}/student/tests/${T}/result`, { waitUntil: "networkidle" });
        const txt = norm(await page.locator("main").innerText().catch(() => ""));
        const sat = txt.match(/Estimated SAT score[^\d]*?(\d{3})\s*\/800/)?.[1] ?? txt.match(/\b(\d{3})\s*\/800\b/)?.[1] ?? null;
        return { mods: txt.match(MODS)?.[0] ?? null, sat: sat ? Number(sat) : null, txt: txt.slice(0, 140) };
      };
      const csvRow = async () => {
        const r = await teacher.context.request.get(`${BASE}/api/teacher/tests/${T}/export`);
        const lines = (await r.text()).trim().split(/\r?\n/);
        const parse = (l) => { const out = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
        const H = parse(lines[0]);
        const c = lines.slice(1).map(parse).map((x) => Object.fromEntries(H.map((h, i) => [h, x[i]]))).filter((x) => x.Student === s.name).at(-1);
        if (!c) return { missing: true, status: r.status() };
        const m = (v) => (v && v.trim() ? v.replace(/ /g, "") : "—");
        return { mods: `M1 ${m(c["M1 Correct"])} · M2 ${m(c["M2 Correct"])}`, sat: c["SAT Score"] ? Number(c["SAT Score"]) : null, txt: JSON.stringify(c).slice(0, 140) };
      };
      const surfaces = async () => ({
        "student My Tests": await rowOf(page, "/student/tests", testName),
        "student Results": await rowOf(page, "/student/results", testName),
        "student result page": await resultPage(),
        "teacher results": await rowOf(teacher.page, `/teacher/tests/${T}/results`, s.name),
        "teacher test detail": await rowOf(teacher.page, `/teacher/tests/${T}`, s.name),
        "admin test detail": await rowOf(admin.page, `/admin/tests/${T}`, s.name),
        "teacher CSV": await csvRow(),
      });
      try {
        // ── Module 2 still open ──
        const midMods = `M1 ${k1Plan}/${n1} · M2 —`;
        const mid = await surfaces();
        for (const [where, v] of Object.entries(mid)) {
          if (v.missing) { if (where !== "student Results") problems.push(`mid-exam: ${where} has no row for this attempt`); continue; }
          if (v.sat != null) problems.push(`mid-exam (Module 2 not done): ${where} shows SAT ${v.sat} — "${v.txt}"`);
          if (v.mods !== midMods) problems.push(`mid-exam: ${where} shows "${v.mods}", expected "${midMods}"`);
        }
        notes.push(`mid-exam: ${Object.entries(mid).map(([w, v]) => `${w} ${v.missing ? "no row" : `${v.sat ?? "no SAT"}/${v.mods}`}`).join(", ")}`);

        // ── Module 2 submitted ──
        const m2Row = (await db.from("submissions").select("module_id").eq("id", m2Id).single()).data;
        const q2 = await moduleQs(m2Row.module_id);
        const k2Plan = Math.min(3, mcOf(q2).length);
        const ans2 = plan(q2, k2Plan);
        if ((await R.patch(`${BASE}/api/student/submissions/${m2Id}`, { data: { answers: ans2, metadata: {} } })).status() >= 400) throw new Error("setup: M2 save failed");
        const sub2 = await R.post(`${BASE}/api/student/submissions/${m2Id}/submit`, { data: { answers: ans2, metadata: {} } });
        if (sub2.status() >= 400) throw new Error(`setup: M2 submit ${sub2.status()}`);
        const g2 = (await db.from("submissions").select("correct_count,total_questions").eq("id", m2Id).single()).data;
        if (g2.correct_count !== k2Plan) problems.push(`Module 2 graded ${g2.correct_count} right, expected ${k2Plan}`);
        const n2 = g2.total_questions;
        const want = satOf(k1Plan + k2Plan, n1 + n2);
        const m1Only = satOf(k1Plan, n1);
        if (want === m1Only) throw new Error(`setup: M1-only SAT equals the full SAT (${want}) — pick other counts`);
        const wantMods = `M1 ${k1Plan}/${n1} · M2 ${k2Plan}/${n2}`;
        const fin = await surfaces();
        for (const [where, v] of Object.entries(fin)) {
          if (v.missing) { problems.push(`finished: ${where} has no row for this attempt`); continue; }
          if (v.sat !== want) problems.push(`finished: ${where} shows SAT ${v.sat ?? "none"}, expected ${want}${v.sat === m1Only ? " (= Module 1 alone)" : ""} — "${v.txt}"`);
          if (v.mods !== wantMods) problems.push(`finished: ${where} shows "${v.mods}", expected "${wantMods}"`);
        }
        notes.push(`finished: expected SAT ${want} (${k1Plan + k2Plan}/${n1 + n2}; M1 alone would be ${m1Only}), "${wantMods}"; ${Object.entries(fin).map(([w, v]) => `${w} ${v.missing ? "no row" : v.sat}`).join(", ")}`);
      } finally {
        await admin.context.close().catch(() => {});
        await teacher.context.close().catch(() => {});
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261101-2 ─────────────────────────────────────────
  // Follow-up to e7b3b98 (class review closed while the exam is being taken)
  // and f278f8d (Module 1 before Module 2). The teacher has class review
  // unlocked on mathLinear (shows the key of BOTH modules).
  //  (A) 076 has submitted Module 1 and is on Module 2 (In Progress): the
  //      review page and the test page's review link must stay closed.
  //  (B) 077's Module 1 was force-submitted by the admin, so no Module 2 row
  //      exists yet, but the test page offers "Continue to Module 2": the
  //      review page must also stay closed — otherwise the student reads the
  //      Module 2 key and then takes Module 2.
  //  (C) Once 076 has finished, the review opens (positive control) and lists
  //      Module 1's questions before Module 2's.
  await check("D-20261101-2", [], "老師開了全班檢討時，學生第一模組交了（或被管理員強制交卷）、第二模組還沒考：檢討頁不能打開、看不到第二模組的答案；考完後檢討頁才打開，而且第一模組排在第二模組前面", "安全", async () => {
    const T = TESTS.mathLinear;
    const onM2 = studentByN(76), forced = studentByN(77);
    if (!onM2 || !forced) throw new Error("students 076/077 not found");
    const orig = C.students[0].id;
    const t0 = (await db.from("tests").select("module_id,module_2_id,review_unlocked,is_adaptive").eq("id", T).single()).data;
    if (t0.review_unlocked || t0.is_adaptive || !t0.module_2_id) throw new Error(`setup: mathLinear flags changed (${JSON.stringify(t0)})`);
    const clean = async () => { for (const st of [onM2, forced]) await deleteSubs(st.id, T).catch(() => {}); };
    const run = (x) => String(x ?? "").match(/[A-Za-z][A-Za-z0-9 ,]{24,}/)?.[0]?.slice(0, 24);
    const snip = async (mod) => {
      const { data } = await db.from("questions").select("question_text,explanation,original_question_number").eq("module_id", mod).eq("parsing_status", "Approved").order("original_question_number");
      return { stems: [...new Set((data ?? []).map((q) => run(q.question_text)).filter(Boolean))], expl: [...new Set((data ?? []).map((q) => run(q.explanation)).filter(Boolean))] };
    };
    const S1 = await snip(t0.module_id), S2 = await snip(t0.module_2_id);
    if (S1.stems.length < 5 || S2.stems.length < 5 || S2.expl.length < 5) throw new Error(`setup: too few usable snippets (M1 ${S1.stems.length}, M2 ${S2.stems.length}/${S2.expl.length})`);
    const seen = (html, list) => list.filter((x) => html.includes(x)).length;
    const leak = (html) => ({ m1: seen(html, S1.stems), m2: seen(html, S2.stems), m2e: seen(html, S2.expl) });
    const problems = [], notes = [];
    await clean();
    const b = await chromium.launch();
    let admin;
    try {
      admin = await login(b, ADMIN_CLERK);
      const rv = await admin.context.request.post(`${BASE}/api/teacher/tests/${T}/review-mode`, { data: { unlocked: true } });
      if (rv.status() !== 200) throw new Error(`setup: review unlock → ${rv.status()}`);

      // (A) 076: Module 1 submitted, Module 2 In Progress.
      let x = await borrowAs(b, 76);
      let R = x.context.request;
      const st = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const m1 = (await st.json().catch(() => ({}))).data?.id;
      if (!m1) throw new Error(`setup: 076 start ${st.status()}`);
      const sub1 = await R.post(`${BASE}/api/student/submissions/${m1}/submit`, { data: { answers: {}, metadata: {} } });
      const m2 = (await sub1.json().catch(() => ({}))).data?.nextSubmissionId;
      if (!m2) throw new Error(`setup: 076 M1 submit ${sub1.status()} gave no Module 2`);
      const a = leak(await (await R.get(`${BASE}/student/tests/${T}/review`)).text());
      if (a.m1 || a.m2 || a.m2e) problems.push(`(A) on Module 2, the class-review page shows the key: M1 ${a.m1} q, M2 ${a.m2} q / ${a.m2e} explanations`);
      const landA = await (await R.get(`${BASE}/student/tests/${T}`)).text();
      if (landA.includes(`/student/tests/${T}/review`)) problems.push("(A) on Module 2, the test page links to class review");
      notes.push(`A (on M2): review M1 ${a.m1}/M2 ${a.m2} q`);
      await x.context.close();

      // (B) 077: Module 1 force-submitted by the admin, no Module 2 row yet.
      x = await borrowAs(b, 77);
      R = x.context.request;
      const st2 = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const f1 = (await st2.json().catch(() => ({}))).data?.id;
      if (!f1) throw new Error(`setup: 077 start ${st2.status()}`);
      const fs = await admin.context.request.post(`${BASE}/api/admin/submissions/${f1}/force-submit`, {});
      if (fs.status() >= 400) throw new Error(`setup: force-submit → ${fs.status()}`);
      // Since 3927107 force-submit also creates Module 2 (unopened, In
      // Progress) through the shared handoff; before that no Module 2 row
      // existed until the student pressed Continue. Accept either.
      const rowsB = await subs(forced.id, T);
      const m1B = rowsB.filter((r) => !String(r.adaptive_track ?? "").startsWith("module_2"));
      const m2B = rowsB.filter((r) => String(r.adaptive_track ?? "").startsWith("module_2"));
      if (m1B.length !== 1 || m1B[0].status === "In Progress" || m2B.length > 1 || (m2B[0] && m2B[0].status !== "In Progress"))
        throw new Error(`setup: after force-submit rows = ${JSON.stringify(rowsB.map((r) => [r.adaptive_track, r.status]))}`);
      notes.push(`B: force-submit ${m2B.length ? "created an unopened Module 2" : "left no Module 2 row"}`);
      const landB = await (await R.get(`${BASE}/student/tests/${T}`)).text();
      const offersContinue = /Continue to Module 2/.test(landB);
      notes.push(`B (M1 force-submitted): test page ${offersContinue ? "offers" : "does not offer"} Continue to Module 2`);
      const bb = leak(await (await R.get(`${BASE}/student/tests/${T}/review`)).text());
      if (bb.m2 || bb.m2e) problems.push(`(B) Module 1 force-submitted, Module 2 not taken yet${offersContinue ? " (test page offers Continue to Module 2)" : ""}: the class-review page shows the Module 2 key — ${bb.m2} questions, ${bb.m2e} explanations`);
      if (landB.includes(`/student/tests/${T}/review`)) problems.push("(B) the test page links to class review while Module 2 is still to be taken");
      notes.push(`B review: M1 ${bb.m1}/M2 ${bb.m2} q, ${bb.m2e} M2 expl`);
      if (offersContinue) {
        // The student continues: a Module 2 row appears and review closes.
        const cont = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
        const rowsC = await subs(forced.id, T);
        const m2c = rowsC.filter((r) => String(r.adaptive_track).startsWith("module_2"));
        notes.push(`continue → ${cont.status()}, ${m2c.length} M2 row(s) ${m2c.map((r) => r.status).join(",")}`);
        if (m2c.length === 1 && m2c[0].status === "In Progress") {
          const c = leak(await (await R.get(`${BASE}/student/tests/${T}/review`)).text());
          if (c.m2 || c.m2e) problems.push(`(B) taking Module 2 after the force-submit, the review page shows the Module 2 key (${c.m2} q)`);
        } else problems.push(`(B) Continue to Module 2 did not create one In Progress Module 2 (${cont.status()}, ${JSON.stringify(rowsC.map((r) => [r.adaptive_track, r.status]))})`);
      }
      await x.context.close();

      // (C) 076 finishes Module 2: review opens, Module 1 first.
      x = await borrowAs(b, 76);
      const done = await x.context.request.post(`${BASE}/api/student/submissions/${m2}/submit`, { data: { answers: {}, metadata: {} } });
      if (done.status() >= 400) throw new Error(`setup: 076 M2 submit ${done.status()}`);
      await x.page.goto(`${BASE}/student/tests/${T}/review`, { waitUntil: "networkidle" });
      const text = norm2(await x.page.locator("main").innerText().catch(() => ""));
      const c = leak(text);
      if (!c.m1 || !c.m2) throw new Error(`setup: after finishing, review shows M1 ${c.m1} / M2 ${c.m2} questions — positive control failed, scan not valid`);
      const firstOf = (list) => Math.min(...list.map((x) => text.indexOf(x)).filter((i) => i >= 0));
      const lastOf = (list) => Math.max(...list.map((x) => text.indexOf(x)));
      if (lastOf(S1.stems) > firstOf(S2.stems)) problems.push(`(C) the class-review page mixes the modules: a Module 1 question comes after a Module 2 question`);
      const h1 = text.indexOf("Module 1"), h2 = text.indexOf("Module 2");
      if (h1 < 0 || h2 < 0 || h1 > h2) problems.push(`(C) section headings: "Module 1" at ${h1}, "Module 2" at ${h2}`);
      notes.push(`C (finished): review M1 ${c.m1}/M2 ${c.m2} q, Module 1 first ${lastOf(S1.stems) < firstOf(S2.stems)}`);
      await x.context.close();
    } finally {
      await db.from("tests").update({ review_unlocked: t0.review_unlocked }).eq("id", T);
      await admin?.context.close().catch(() => {});
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await clean();
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 3 * 60 * 1000);
  function norm2(t) { return String(t ?? "").replace(/\s+/g, " "); }

  // ── D-20261101-3 ─────────────────────────────────────────
  // A student takes a break on the "Module 1 submitted" screen (restroom,
  // reload). Module 2's clock must start when they press Start Module 2,
  // not when Module 1 was submitted: full Module 2 time on screen, the
  // server's start stamp after the click, and the same time after a reload.
  await check("D-20261101-3", [], "第一模組交卷後學生在休息畫面停了一分多鐘（中間還重新整理），再按開始第二模組：第二模組的倒數要從完整時間開始，休息時間不能被扣掉，重新整理後時間也一樣", "計時", () =>
    asStudent(80, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      const tl = (await db.from("tests").select("time_limit_minutes,time_limit_minutes_module_2").eq("id", T).single()).data;
      const full = (tl.time_limit_minutes_module_2 ?? tl.time_limit_minutes) * 60;
      const timerSecs = async () => {
        await page.getByRole("timer").first().waitFor({ timeout: 20000 });
        const m = (await page.getByRole("timer").first().innerText().catch(() => "")).match(/(\d+):(\d{2})/);
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
      };
      const problems = [], notes = [];
      await startTestBrowser(page, T);
      await onQuestion(page, 1);
      await choice(page, "B").click();
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 });
      const tSubmit = Date.now();
      // Break: 40 s, reload the break screen, 35 s more.
      await sleep(40000);
      await page.reload({ waitUntil: "networkidle" });
      const still = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
      if (!still) problems.push(`reloading the break screen did not show "Module 1 submitted" again (${page.url().replace(BASE, "")})`);
      const m2pre = (await subs(s.id, T)).find((r) => String(r.adaptive_track).startsWith("module_2"));
      if (!m2pre) throw new Error("setup: no Module 2 row during the break");
      if (m2pre.status !== "In Progress") problems.push(`during the break Module 2 is already ${m2pre.status}`);
      await sleep(35000);
      const brk = Math.round((Date.now() - tSubmit) / 1000);
      const tClick = Date.now();
      await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 });
      await waitTake(page);
      const t1 = await timerSecs();
      if (t1 == null) throw new Error("can't read the Module 2 timer");
      const loadS = Math.round((Date.now() - tClick) / 1000);
      if (t1 < full - loadS - 15) problems.push(`Module 2 timer shows ${t1}s after a ${brk}s break (full time ${full}s): the break was taken off the clock`);
      if (t1 > full) problems.push(`Module 2 timer shows ${t1}s, more than the full ${full}s`);
      const m2 = await waitRow(m2pre.id, (r) => r.metadata?.module_2_started_at, 15000);
      const stamp = m2?.metadata?.module_2_started_at;
      if (!stamp) problems.push("Module 2 has no start stamp after Start Module 2");
      else if (Date.parse(stamp) < tClick - 5000) problems.push(`Module 2's server start (${stamp}) is ${Math.round((tClick - Date.parse(stamp)) / 1000)}s before the student pressed Start Module 2`);
      await onQuestion(page, 1);
      await choice(page, "C").click();
      await sleep(3000);
      await page.reload({ waitUntil: "networkidle" });
      await waitTake(page);
      const t2 = await timerSecs();
      const elapsed = Math.round((Date.now() - tClick) / 1000);
      if (t2 == null || Math.abs(t2 - (full - elapsed)) > 15) problems.push(`after a reload the Module 2 timer shows ${t2}s, expected about ${full - elapsed}s`);
      notes.push(`break ${brk}s (with a reload); Module 2 timer ${t1}s of ${full}s; after reload ${t2}s (expected ≈${full - elapsed}s); server start ${stamp ? `${Math.round((Date.parse(stamp) - tClick) / 1000)}s after the click` : "missing"}`);
      // Finish: the Module 2 answer is kept and the attempt is on time.
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      await page.waitForURL(/\/result/, { timeout: 45000 }).catch(() => problems.push("Module 2 submit did not open the result page"));
      const rows = await subs(s.id, T);
      const fin = rows.find((r) => r.id === m2pre.id);
      if (fin?.status !== "Submitted") problems.push(`Module 2 ended ${fin?.status}, expected Submitted`);
      if (!Object.values(fin?.answers ?? {}).includes("C")) problems.push("Module 2 answer C not saved");
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261102-1 ─────────────────────────────────────────
  // Classroom device switch: the laptop's Wi-Fi drops mid-exam (one answer
  // stuck "Not saved"), the student moves to a spare computer, resumes and
  // changes an earlier answer. Later the laptop, still open, reconnects and
  // flushes its old copy. The student's latest choice (made on the new
  // computer) must survive: in the saved row, after a reload on the new
  // computer, and in the graded Module 1. The timer must carry on, not reset.
  await check("D-20261102-1", [], "考到一半筆電斷網、學生換到另一台電腦繼續考並改了答案，之後舊筆電又連上網：新電腦上改的答案不能被舊筆電蓋回去，倒數時間接續不重來", "考試流程", () =>
    asStudent(73, TESTS.engLinear, async ({ s, b, page }) => {
      const T = TESTS.engLinear;
      const problems = [], notes = [];
      const tl = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data;
      const full = tl.time_limit_minutes * 60;
      const timerSecs = async (p) => {
        await p.getByRole("timer").first().waitFor({ timeout: 20000 });
        const m = (await p.getByRole("timer").first().innerText().catch(() => "")).match(/(\d+):(\d{2})/);
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
      };
      const picked = async (p, l) => (await choice(p, l).getAttribute("aria-checked").catch(() => null)) === "true";
      // Laptop (A)
      const ctxA = page.context();
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      if (qs.length < 5) throw new Error(`only ${qs.length} questions in Module 1`);
      const [q1, q2, q3, , q5] = qs.map((q) => q.id);
      await onQuestion(page, 1); await choice(page, "A").click();
      await jumpTo(page, 2); await choice(page, "B").click();
      const r0 = await waitRow(m1.id, (r) => r.answers?.[q1] === "A" && r.answers?.[q2] === "B", 20000);
      if (r0?.answers?.[q2] !== "B") throw new Error("setup: laptop answers didn't save");
      // Wi-Fi drops; one more answer only lives on the laptop.
      await ctxA.setOffline(true);
      await jumpTo(page, 3); await choice(page, "C").click();
      await sleep(3000);
      if ((await db.from("submissions").select("answers").eq("id", m1.id).single()).data?.answers?.[q3])
        throw new Error("setup: the offline answer reached the server (offline not effective)");
      // Spare computer (B): fresh browser profile, same student.
      const B = await login(b, STUDENT1_CLERK);
      const pb = B.page;
      try {
        await startTestBrowser(pb, T);
        const startedAt = Date.parse(m1.started_at);
        const tb = await timerSecs(pb);
        const expect = full - Math.round((Date.now() - startedAt) / 1000);
        notes.push(`new computer timer ${tb}s (expected ≈${expect}s)`);
        if (tb == null) problems.push("can't read the timer on the new computer");
        else if (tb > expect + 20) problems.push(`on the new computer the timer restarted: ${tb}s, expected ≈${expect}s`);
        else if (tb < expect - 20) problems.push(`on the new computer the timer lost time: ${tb}s, expected ≈${expect}s`);
        await jumpTo(pb, 1);
        if (!(await picked(pb, "A"))) problems.push("new computer: Q1 doesn't show the saved answer A");
        await jumpTo(pb, 2);
        if (!(await picked(pb, "B"))) problems.push("new computer: Q2 doesn't show the saved answer B");
        // The student changes Q1 and answers Q5 on the new computer.
        await jumpTo(pb, 1); await choice(pb, "D").click();
        await jumpTo(pb, 5); await choice(pb, "A").click();
        const r1 = await waitRow(m1.id, (r) => r.answers?.[q1] === "D" && r.answers?.[q5] === "A", 20000);
        if (r1?.answers?.[q1] !== "D") throw new Error("setup: the new computer's change didn't save");
        await sleep(2000);
        // The laptop comes back online and flushes what it had.
        const tOn = Date.now();
        await ctxA.setOffline(false);
        const r2 = await waitRow(m1.id, (r) => r.answers?.[q3] === "C" || r.answers?.[q1] !== "D", 25000);
        await sleep(4000);
        const r3 = (await db.from("submissions").select("answers,status").eq("id", m1.id).single()).data;
        const laptopFlushed = r2?.answers?.[q3] === "C" || r2?.answers?.[q1] !== "D";
        notes.push(`laptop back online: ${laptopFlushed ? `flushed after ${Math.round((Date.now() - tOn) / 1000) - 4}s` : "sent nothing within 25s"}; saved now Q1=${r3.answers?.[q1]} Q2=${r3.answers?.[q2]} Q3=${r3.answers?.[q3] ?? "—"} Q5=${r3.answers?.[q5] ?? "—"}`);
        if (r3.answers?.[q1] !== "D") problems.push(`after the old laptop reconnected, the saved Q1 went back to "${r3.answers?.[q1]}" — the student's later change to D on the new computer was overwritten`);
        if (r3.answers?.[q5] !== "A") problems.push(`after the old laptop reconnected, Q5 (answered on the new computer) is "${r3.answers?.[q5] ?? "missing"}"`);
        // The student refreshes the new computer: must still see their own answers.
        await pb.reload({ waitUntil: "networkidle" });
        await waitTake(pb);
        await jumpTo(pb, 1);
        const shownQ1 = ["A", "B", "C", "D"];
        let shown = null;
        for (const l of shownQ1) if (await picked(pb, l)) shown = l;
        notes.push(`new computer after refresh shows Q1=${shown ?? "none"}`);
        if (shown !== "D") problems.push(`after refreshing the new computer, Q1 shows "${shown ?? "nothing"}" instead of the D the student picked there`);
        // Submit from the new computer; the graded answer for Q1 must be D.
        await goToSubmitModal(pb, await totalOf(pb));
        await pb.getByRole("button", { name: /Submit Test/ }).last().click();
        await pb.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).catch(() => problems.push("submit on the new computer did not reach the Module 2 screen"));
        const fin = (await db.from("submissions").select("status,answers").eq("id", m1.id).single()).data;
        const { data: rec } = await db.from("answer_records").select("student_answer").eq("submission_id", m1.id).eq("question_id", q1);
        notes.push(`graded Module 1: ${fin.status}, Q1=${fin.answers?.[q1]}`);
        if (fin.status === "In Progress") problems.push("Module 1 still In Progress after submit");
        else if (fin.answers?.[q1] !== "D" || (rec?.[0] && rec[0].student_answer !== "D"))
          problems.push(`Module 1 was graded with Q1="${fin.answers?.[q1]}" (record "${rec?.[0]?.student_answer}"), not the student's final choice D`);
        const m2s = (await subs(s.id, T)).filter((r) => String(r.adaptive_track).startsWith("module_2"));
        if (m2s.length !== 1) problems.push(`${m2s.length} Module 2 rows (expected 1)`);
      } finally {
        await B.context.close().catch(() => {});
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261102-2 ─────────────────────────────────────────
  // Adaptive routing right at the cut-off (threshold % of Module 1). One
  // more right answer than the cut-off → hard Module 2, one fewer → easy.
  // Same result when the admin force-submits Module 1 and the student then
  // presses "Continue to Module 2" (the start route's recovery path, which
  // picks the track separately from the normal submit path).
  await check("D-20261102-2", [], "自適應測驗第一模組剛好在及格線上下：剛好過線要進難的第二模組、差一題進簡單的；管理員強制交卷後學生按「繼續第二模組」也要分到一樣的難度", "計分", () =>
    asStudent(78, TESTS.adaptive, async ({ s, b, context }) => {
      const T = TESTS.adaptive;
      const R = context.request;
      const t = (await db.from("tests").select("adaptive_threshold,module_1_id,module_2_easy_id,module_2_hard_id").eq("id", T).single()).data;
      if (!t.module_2_easy_id || !t.module_2_hard_id) throw new Error("setup: adaptive test lacks a Module 2 track");
      const thr = t.adaptive_threshold ?? 60;
      const qs = await moduleQs(t.module_1_id);
      const n = qs.length;
      const pct = (k) => Math.round((k / n) * 1000) / 10;
      let kHard = 0;
      while (kHard <= n && pct(kHard) < thr) kHard++;
      const mc = qs.filter((q) => q.question_type === "Multiple Choice" && /^[A-D]$/.test(String(q.correct_answer ?? "").trim().toUpperCase()));
      if (kHard < 1 || kHard > mc.length) throw new Error(`setup: cut-off needs ${kHard} right, only ${mc.length} MC questions with an A–D key`);
      const answersFor = (k) => {
        const right = new Set(mc.slice(0, k).map((q) => q.id));
        return Object.fromEntries(qs.map((q) => {
          const key = String(q.correct_answer ?? "").trim().toUpperCase();
          if (right.has(q.id)) return [q.id, key];
          if (q.question_type === "Multiple Choice") return [q.id, ["A", "B", "C", "D"].find((l) => l !== key)];
          return [q.id, "99999"];
        }));
      };
      const admin = await login(b, ADMIN_CLERK);
      const problems = [], notes = [];
      try {
        const run = async (k, viaForce) => {
          await deleteSubs(s.id, T);
          const st = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
          const m1Id = (await st.json().catch(() => ({}))).data?.id;
          if (!m1Id) throw new Error(`setup: start → ${st.status()}`);
          const ans = answersFor(k);
          const p = await R.patch(`${BASE}/api/student/submissions/${m1Id}`, { data: { answers: ans, answersMode: "merge", metadata: {} } });
          if (p.status() >= 400) throw new Error(`setup: save → ${p.status()}`);
          let m2Id;
          if (!viaForce) {
            const sb = await R.post(`${BASE}/api/student/submissions/${m1Id}/submit`, { data: { answers: ans, answersMode: "merge", metadata: {} } });
            const j = await sb.json().catch(() => ({}));
            if (sb.status() >= 400) throw new Error(`setup: submit → ${sb.status()} ${JSON.stringify(j).slice(0, 100)}`);
            m2Id = j.data?.nextSubmissionId;
          } else {
            const fs = await admin.context.request.post(`${BASE}/api/admin/submissions/${m1Id}/force-submit`, {});
            if (fs.status() >= 400) throw new Error(`setup: force-submit → ${fs.status()}`);
            const m2pre = (await subs(s.id, T)).filter((r) => String(r.adaptive_track).startsWith("module_2"));
            if (m2pre.length) notes.push(`force-submit created Module 2 itself (${m2pre[0].adaptive_track})`);
            const cont = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
            const cj = await cont.json().catch(() => ({}));
            if (cont.status() >= 400) { problems.push(`k=${k} force: "Continue to Module 2" → ${cont.status()} ${JSON.stringify(cj).slice(0, 100)}`); return; }
            m2Id = cj.data?.id;
          }
          const m1 = (await db.from("submissions").select("correct_count,total_questions,percentage,status").eq("id", m1Id).single()).data;
          if (m1.correct_count !== k || m1.total_questions !== n)
            throw new Error(`setup: Module 1 graded ${m1.correct_count}/${m1.total_questions}, intended ${k}/${n}`);
          const rows = await subs(s.id, T);
          const m2s = rows.filter((r) => String(r.adaptive_track).startsWith("module_2"));
          const m1s = rows.filter((r) => r.adaptive_track === "module_1");
          const want = pct(k) >= thr ? "module_2_hard" : "module_2_easy";
          const wantMod = want === "module_2_hard" ? t.module_2_hard_id : t.module_2_easy_id;
          const label = `${k}/${n} (${m1.percentage}%) ${viaForce ? "force-submit + Continue" : "normal submit"}`;
          if (m2s.length !== 1 || m1s.length !== 1) { problems.push(`${label}: ${m1s.length} Module 1 and ${m2s.length} Module 2 rows (expected 1 each)`); return; }
          const m2 = m2s[0];
          notes.push(`${label} → ${m2.adaptive_track}`);
          if (m2.id !== m2Id) problems.push(`${label}: the Module 2 the student was sent to (${m2Id}) isn't the one in the database`);
          if (m2.adaptive_track !== want || m2.module_id !== wantMod)
            problems.push(`${label}: routed to ${m2.adaptive_track}, expected ${want} (cut-off ${thr}%)`);
          if (m2.session_id !== m1s[0].session_id || m2.status !== "In Progress") problems.push(`${label}: Module 2 row ${m2.status}, same session ${m2.session_id === m1s[0].session_id}`);
        };
        await run(kHard, false);
        await run(kHard - 1, false);
        await run(kHard, true);
        await run(kHard - 1, true);
      } finally {
        await admin.context.close().catch(() => {});
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261102-3 ─────────────────────────────────────────
  // The admin grants a one-off retake on a test that doesn't allow retakes.
  // Before: no way to start again. After: Start Test opens a clean attempt
  // (Question 1, nothing picked, full timer), the student finishes both
  // modules, the first attempt stays untouched, and the grant is used up.
  await check("D-20261102-3", [], "管理員讓一位已考完的學生「再考一次」：學生重新開始時是全新的考卷（第一題、沒有舊答案、時間是完整的），兩個模組都能考完，第一次的成績不會被改掉，而且只能多考這一次", "老師/管理員動作", () =>
    asStudent(75, TESTS.engLinear, async ({ s, b, page, context }) => {
      const T = TESTS.engLinear;
      const R = context.request;
      const t = (await db.from("tests").select("allow_retake,time_limit_minutes").eq("id", T).single()).data;
      if (t.allow_retake) throw new Error("setup: engLinear now allows retakes, the grant isn't needed");
      const full = t.time_limit_minutes * 60;
      const clearGrants = () => db.from("test_retake_grants").delete().eq("test_id", T).eq("student_id", s.id);
      await clearGrants();
      // If a start that should have been refused went through, drop that
      // stray attempt so the rest of the check sees a clean state.
      const deleteSubsExcept = async (sid, tid, keepUpTo) => {
        const { data } = await db.from("submissions").select("id").eq("student_id", sid).eq("test_id", tid).gt("attempt_number", keepUpTo);
        const ids = (data ?? []).map((r) => r.id);
        if (ids.length) { await db.from("answer_records").delete().in("submission_id", ids); await db.from("submissions").delete().in("id", ids); }
      };
      const problems = [], notes = [];
      const admin = await login(b, ADMIN_CLERK);
      try {
        const a1 = await apiTakeTest(R, s.id, T);
        if (!a1.m2Id) throw new Error("setup: engLinear attempt 1 has no Module 2");
        const snap = async () => JSON.stringify((await subs(s.id, T)).filter((r) => r.attempt_number === 1)
          .map((r) => [r.id, r.status, r.answers, r.correct_count, r.submitted_at, r.adaptive_track]));
        const before = await snap();
        // Before the grant: finished, no way to start again.
        await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
        const btn = page.getByRole("button", { name: /Start Test|Resume Test/ });
        if (await btn.count()) problems.push("before any retake grant the test page offers Start/Resume");
        const deny = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
        if (deny.status() !== 403) problems.push(`before the grant, starting again → ${deny.status()} (expected 403)`);
        await deleteSubsExcept(s.id, T, 1);
        // Admin grants a retake.
        const g = await admin.context.request.post(`${BASE}/api/admin/tests/${T}/grant-retake`, { data: { studentId: s.id, notes: "qa nightly D-20261102-3" } });
        if (g.status() !== 200) throw new Error(`setup: grant-retake → ${g.status()} ${(await g.text()).slice(0, 120)}`);
        // Student opens the test page and starts again.
        const tClick = Date.now();
        await startTestBrowser(page, T);
        await onQuestion(page, 1).catch(() => problems.push("the retake did not open on Question 1"));
        const tm = await page.getByRole("timer").first().innerText().catch(() => "");
        const mm = tm.match(/(\d+):(\d{2})/);
        const secs = mm ? Number(mm[1]) * 60 + Number(mm[2]) : null;
        const loadS = Math.round((Date.now() - tClick) / 1000);
        notes.push(`retake timer ${secs}s of ${full}s`);
        if (secs == null || secs < full - loadS - 15 || secs > full) problems.push(`retake timer shows ${tm || "nothing"}, expected the full ${full / 60}:00`);
        const pickedQ1 = [];
        for (const l of ["A", "B", "C", "D"]) if ((await choice(page, l).getAttribute("aria-checked").catch(() => null)) === "true") pickedQ1.push(l);
        if (pickedQ1.length) problems.push(`the retake opens with Q1 already answered (${pickedQ1.join(",")}) from the first attempt`);
        const rows = await subs(s.id, T);
        const a2 = rows.filter((r) => r.attempt_number === 2);
        const a1m1 = rows.find((r) => r.id === a1.m1Id);
        if (a2.length !== 1 || a2[0].adaptive_track !== "module_1" || a2[0].status !== "In Progress") problems.push(`after Start: attempt 2 rows ${JSON.stringify(a2.map((r) => [r.adaptive_track, r.status]))} (expected one Module 1 In Progress)`);
        else {
          if (Object.keys(a2[0].answers ?? {}).length) problems.push(`attempt 2 starts with ${Object.keys(a2[0].answers).length} saved answers`);
          if (a2[0].session_id === a1m1?.session_id) problems.push("attempt 2 shares the first attempt's session");
        }
        const gr = (await db.from("test_retake_grants").select("consumed_at").eq("test_id", T).eq("student_id", s.id)).data ?? [];
        if (gr.length !== 1 || !gr[0].consumed_at) problems.push(`grant after Start: ${JSON.stringify(gr)}`);
        // Finish attempt 2 through the page: pick a different Q1 than attempt 1.
        const qs = await moduleQs(a2[0]?.module_id);
        const a1q1 = a1.answers1?.[qs[0]?.id];
        const pick = ["A", "B", "C", "D"].find((l) => l !== a1q1);
        await choice(page, pick).click();
        await waitRow(a2[0].id, (r) => r.answers?.[qs[0].id] === pick, 20000);
        await goToSubmitModal(page, await totalOf(page));
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 });
        await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 });
        await waitTake(page);
        await onQuestion(page, 1);
        const m2Picked = [];
        for (const l of ["A", "B", "C", "D"]) if ((await choice(page, l).getAttribute("aria-checked").catch(() => null)) === "true") m2Picked.push(l);
        if (m2Picked.length) problems.push(`attempt 2's Module 2 opens with Q1 already answered (${m2Picked.join(",")})`);
        await choice(page, "B").click();
        await sleep(1500);
        await goToSubmitModal(page, await totalOf(page));
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        await page.waitForURL(/\/result/, { timeout: 45000 }).catch(() => problems.push("attempt 2's Module 2 submit did not open the result page"));
        const fin = (await subs(s.id, T)).filter((r) => r.attempt_number === 2);
        const f1 = fin.find((r) => r.adaptive_track === "module_1"), f2 = fin.find((r) => String(r.adaptive_track).startsWith("module_2"));
        if (fin.length !== 2 || f1?.status !== "Submitted" || f2?.status !== "Submitted" || f2?.session_id !== f1?.session_id)
          problems.push(`attempt 2 ended as ${JSON.stringify(fin.map((r) => [r.adaptive_track, r.status]))} (expected Module 1 + Module 2 Submitted, same session)`);
        else {
          if (f1.answers?.[qs[0].id] !== pick) problems.push(`attempt 2 Module 1 Q1 saved "${f1.answers?.[qs[0].id]}", expected ${pick}`);
          if (!Object.values(f2.answers ?? {}).includes("B")) problems.push("attempt 2 Module 2 answer B not saved");
          notes.push(`attempt 2: M1 ${f1.correct_count}/${f1.total_questions}, M2 ${f2.correct_count}/${f2.total_questions}; attempt 1: M1 ${a1.dbScore1}`);
        }
        if ((await snap()) !== before) problems.push("the first attempt's rows changed during the retake");
        // The grant is used up: no third attempt.
        await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
        if (await page.getByRole("button", { name: /Start Test|Resume Test/ }).count()) problems.push("after the retake the test page still offers Start/Resume");
        const again = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
        if (again.status() !== 403) problems.push(`after using the retake, starting a third attempt → ${again.status()} (expected 403)`);
        await deleteSubsExcept(s.id, T, 2);
      } finally {
        await admin.context.close().catch(() => {});
        await clearGrants();
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);
  // ── shared for the 2026-11-03 checks ─────────────────────
  const timerSecsOf = async (p) => {
    await p.getByRole("timer").first().waitFor({ timeout: 20000 });
    const m = (await p.getByRole("timer").first().innerText().catch(() => "")).match(/(\d+):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const isPicked = async (p, l) => (await choice(p, l).getAttribute("aria-checked").catch(() => null)) === "true";
  const answersOf = async (id) => (await db.from("submissions").select("answers").eq("id", id).single()).data?.answers ?? {};

  // ── D-20261103-1 ─────────────────────────────────────────
  // Commit 3e09f4a: saves now send only answers whose local change time
  // (Date.now()) is at or after the last confirmed save's build time. If the
  // computer's clock is corrected BACKWARDS mid-exam (auto time sync after
  // sleep, a student fixing a fast clock), answers picked after the
  // correction look "older" than the last save. They must still reach the
  // server and be graded, and the countdown must not gain the clock jump.
  await check("D-20261103-1", [], "考到一半學生電腦的時鐘被自動校正（往回調 10 分鐘）：校正後選的答案一定要存進去、交卷時有算分，倒數時間也不能突然多出 10 分鐘", "計時", () =>
    asStudent(74, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      const SKEW = 10 * 60e3;
      const limit = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data.time_limit_minutes;
      const problems = [], notes = [];
      // The laptop's clock runs 10 min fast when the exam starts.
      await page.clock.install({ time: new Date(Date.now() + SKEW) });
      await startTestBrowser(page, T);
      const skew0 = (await page.evaluate(() => Date.now())) - Date.now();
      if (Math.abs(skew0 - SKEW) > 60e3) throw new Error(`setup: clock skew not applied (${Math.round(skew0 / 1000)} s)`);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      if (qs.length < 4) throw new Error(`only ${qs.length} questions in Module 1`);
      const [q1, q2, q3] = qs.map((q) => q.id);
      const expLeft = () => limit * 60 - (Date.now() - Date.parse(m1.started_at)) / 1000;
      await onQuestion(page, 1); await choice(page, "A").click();
      const r0 = await waitRow(m1.id, (r) => r.answers?.[q1] === "A", 20000);
      if (r0?.answers?.[q1] !== "A") throw new Error("setup: Q1 didn't save before the clock change");
      await sleep(1500);
      const t0 = await timerSecsOf(page);
      notes.push(`before: timer ${t0}s vs server ≈${Math.round(expLeft())}s`);
      // Windows/macOS time sync corrects the clock: it jumps back 10 min.
      await page.clock.setSystemTime(new Date(Date.now()));
      const skew1 = (await page.evaluate(() => Date.now())) - Date.now();
      if (Math.abs(skew1) > 30e3) throw new Error(`setup: clock not corrected (still ${Math.round(skew1 / 1000)} s off)`);
      let patches = 0;
      const countPatch = (req) => { if (req.method() === "PATCH" && req.url().includes("/api/student/submissions/")) patches++; };
      page.on("request", countPatch);
      const tPick = Date.now();
      await jumpTo(page, 2); await choice(page, "B").click();
      await jumpTo(page, 3); await choice(page, "C").click();
      const r1 = await waitRow(m1.id, (r) => r.answers?.[q2] === "B" && r.answers?.[q3] === "C", 15000);
      const secs = Math.max(1, Math.round((Date.now() - tPick) / 1000));
      page.off("request", countPatch);
      const status = (await page.getByRole("status").filter({ hasText: /Saved|Saving|Not saved/ }).first().innerText({ timeout: 3000 }).catch(() => "")).trim();
      notes.push(`after the clock change: saved Q2=${r1?.answers?.[q2] ?? "—"} Q3=${r1?.answers?.[q3] ?? "—"}, page says "${status}", ${patches} save requests in ${secs}s`);
      if (r1?.answers?.[q2] !== "B" || r1?.answers?.[q3] !== "C")
        problems.push(`answers picked after the clock was corrected never reached the server within 15 s (Q2=${r1?.answers?.[q2] ?? "missing"}, Q3=${r1?.answers?.[q3] ?? "missing"})${/^Saved/.test(status) ? ` while the page says "${status}"` : ""}`);
      if (patches > 40) problems.push(`the page sent ${patches} save requests in ${secs}s (a save loop)`);
      const t1 = await timerSecsOf(page);
      const e1 = expLeft();
      notes.push(`timer ${t1}s vs server ≈${Math.round(e1)}s`);
      if (t1 == null) problems.push("can't read the timer after the clock change");
      else if (t1 > e1 + 60) problems.push(`after the clock change the timer shows ${t1}s left but the server deadline is ${Math.round(e1)}s away (+${Math.round(t1 - e1)}s too much)`);
      else if (t1 < e1 - 60) problems.push(`after the clock change the timer shows ${t1}s, server says ${Math.round(e1)}s`);
      // Submit through the page; Q2 and Q3 must be graded as picked.
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).catch(() => problems.push("Submit did not reach the Module 2 screen"));
      const fin = await waitRow(m1.id, (r) => r.status !== "In Progress", 20000);
      const { data: recs } = await db.from("answer_records").select("question_id,student_answer").eq("submission_id", m1.id).in("question_id", [q1, q2, q3]);
      const rec = (id) => (recs ?? []).find((r) => r.question_id === id)?.student_answer ?? null;
      notes.push(`graded Module 1 (${fin?.status}): Q1=${fin?.answers?.[q1] ?? "—"} Q2=${fin?.answers?.[q2] ?? "—"} Q3=${fin?.answers?.[q3] ?? "—"}`);
      if (fin?.status === "In Progress") problems.push("Module 1 still In Progress after Submit");
      else {
        const lost = [[q2, "B", 2], [q3, "C", 3]].filter(([id, v]) => fin?.answers?.[id] !== v || (rec(id) != null && rec(id) !== v));
        if (lost.length) problems.push(`graded without the student's answers ${lost.map(([, v, n]) => `Q${n}=${v}`).join(", ")} (picked after the clock correction)`);
        if (fin?.answers?.[q1] !== "A") problems.push(`Q1 graded as ${fin?.answers?.[q1] ?? "blank"}, expected A`);
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261103-2 ─────────────────────────────────────────
  // Erasing a typed (SPR) math answer. Commit 3e09f4a turned saves into
  // "changed answers only" + the server's copy adopted back, so a cleared box
  // must travel as a delete in every path: erase then refresh at once, erase
  // while offline, and erase on a second computer while the first is open
  // (first refreshes / first keeps working). A cleared answer must never come
  // back, on screen or in grading.
  await check("D-20261103-2", [], "數學填答題學生把打好的答案整個刪掉（刪完馬上重新整理、斷網時刪、或在另一台電腦刪）：刪掉的答案不能又跑回來，畫面上和交卷算分時都要是空白", "考試流程", () =>
    asStudent(77, TESTS.mathLinear, async ({ s, b, page }) => {
      const T = TESTS.mathLinear;
      const problems = [], notes = [];
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      const all = qs.map((q, i) => ({ q, idx: i + 1 }));
      const spr = all.filter((x) => x.q.question_type !== "Multiple Choice");
      const mcq = all.find((x) => x.q.question_type === "Multiple Choice");
      if (spr.length < 4 || !mcq) throw new Error(`Math M1 has ${spr.length} typed-answer questions (need 4) and ${mcq ? "an" : "no"} MC question`);
      const [s1, s2, s3, s4] = spr;
      const box = (p, x) => p.locator(`[id="spr-${x.q.id}"]`);
      const shownOn = async (p, x) => { await jumpTo(p, x.idx); return await box(p, x).inputValue().catch(() => null); };
      const typeSaved = async (p, x, v) => {
        await jumpTo(p, x.idx);
        if (!(await box(p, x).isVisible().catch(() => false))) throw new Error(`Q${x.idx} has no typed-answer box (question order mismatch)`);
        await box(p, x).fill(v);
        const r = await waitRow(m1.id, (row) => row.answers?.[x.q.id] === v, 20000);
        if (r?.answers?.[x.q.id] !== v) throw new Error(`setup: Q${x.idx} "${v}" didn't save`);
      };
      const goneWithin = async (x, ms) => !(x.q.id in ((await waitRow(m1.id, (r) => !(x.q.id in (r.answers ?? {})), ms))?.answers ?? {}));
      const staysGone = async (x, ms) => { await sleep(ms); return !(x.q.id in (await answersOf(m1.id))); };

      // (a) erase, then refresh straight away.
      await typeSaved(page, s1, "12");
      await box(page, s1).fill("");
      await sleep(250);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitTake(page);
      const a1 = await shownOn(page, s1);
      const aGone = await goneWithin(s1, 10000) && await staysGone(s1, 3000);
      notes.push(`(a) erase+refresh: box "${a1}", server ${aGone ? "blank" : `"${(await answersOf(m1.id))[s1.q.id]}"`}`);
      if (a1 !== "") problems.push(`(a) erased Q${s1.idx} then refreshed: the box shows "${a1}" again`);
      if (!aGone) problems.push(`(a) erased Q${s1.idx} then refreshed: the server still has "${(await answersOf(m1.id))[s1.q.id]}"`);

      // (b) erase while the Wi-Fi is down, then it comes back.
      await typeSaved(page, s2, "7");
      await page.context().setOffline(true);
      await box(page, s2).fill("");
      await sleep(2500);
      await page.context().setOffline(false);
      const bGone = await goneWithin(s2, 20000);
      notes.push(`(b) erase offline: server ${bGone ? "blank" : `"${(await answersOf(m1.id))[s2.q.id]}"`} after reconnect`);
      if (!bGone) problems.push(`(b) erased Q${s2.idx} while offline: after reconnecting the server still has "${(await answersOf(m1.id))[s2.q.id]}"`);

      // (c) a second computer erases while the first stays open.
      await typeSaved(page, s3, "5");
      await typeSaved(page, s4, "9");
      const B = await login(b, STUDENT1_CLERK);
      const pb = B.page;
      try {
        await startTestBrowser(pb, T);
        const b3 = await shownOn(pb, s3);
        if (b3 !== "5") throw new Error(`setup: second computer shows Q${s3.idx}="${b3}", expected 5`);
        await box(pb, s3).fill("");
        if (!(await goneWithin(s3, 20000))) throw new Error(`setup: the second computer's erase of Q${s3.idx} didn't save`);
        // (c1) the first computer refreshes (no save in between).
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitTake(page);
        const c1 = await shownOn(page, s3);
        const c1Gone = await staysGone(s3, 6000);
        notes.push(`(c1) other computer erased, this one refreshed: box "${c1}", server ${c1Gone ? "blank" : `"${(await answersOf(m1.id))[s3.q.id]}"`}`);
        if (c1 !== "") problems.push(`(c1) Q${s3.idx} was erased on the second computer; after refreshing the first computer the box shows "${c1}" again`);
        if (!c1Gone) problems.push(`(c1) Q${s3.idx} was erased on the second computer; after the first computer refreshed, the server has "${(await answersOf(m1.id))[s3.q.id]}" again`);
        // (c2) the first computer keeps working (another save) after the erase.
        const b4 = await shownOn(pb, s4);
        if (b4 !== "9") throw new Error(`setup: second computer shows Q${s4.idx}="${b4}", expected 9`);
        await box(pb, s4).fill("");
        if (!(await goneWithin(s4, 20000))) throw new Error(`setup: the second computer's erase of Q${s4.idx} didn't save`);
        await B.context.close().catch(() => {});
        await jumpTo(page, mcq.idx); await choice(page, "B").click();
        await waitRow(m1.id, (r) => r.answers?.[mcq.q.id] === "B", 20000);
        await sleep(1500);
        const c2 = await shownOn(page, s4);
        const c2Gone = await staysGone(s4, 3000);
        notes.push(`(c2) other computer erased, this one saved again: box "${c2}", server ${c2Gone ? "blank" : `"${(await answersOf(m1.id))[s4.q.id]}"`}`);
        if (!c2Gone) problems.push(`(c2) Q${s4.idx} was erased on the second computer; after the first computer saved again the server has "${(await answersOf(m1.id))[s4.q.id]}" again`);
        if (c2 !== "") problems.push(`(c2) Q${s4.idx} was erased on the second computer; the first computer still shows "${c2}" after its next save`);
      } finally {
        await B.context.close().catch(() => {});
      }
      // Submit from the first computer: none of the erased answers may be graded.
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).catch(() => problems.push("Submit did not reach the Module 2 screen"));
      const fin = await waitRow(m1.id, (r) => r.status !== "In Progress", 20000);
      const { data: recs } = await db.from("answer_records").select("question_id,student_answer").eq("submission_id", m1.id).in("question_id", [s1, s2, s3, s4].map((x) => x.q.id));
      const back = [s1, s2, s3, s4].filter((x) => x.q.id in (fin?.answers ?? {}) || (recs ?? []).some((r) => r.question_id === x.q.id && r.student_answer));
      notes.push(`graded Module 1 (${fin?.status}): erased answers back in grading: ${back.length ? back.map((x) => `Q${x.idx}`).join(",") : "none"}`);
      if (fin?.status === "In Progress") problems.push("Module 1 still In Progress after Submit");
      else if (back.length) problems.push(`graded with erased answers ${back.map((x) => `Q${x.idx}="${fin?.answers?.[x.q.id] ?? (recs ?? []).find((r) => r.question_id === x.q.id)?.student_answer}"`).join(", ")}`);
      if (fin?.answers?.[mcq.q.id] !== "B") problems.push(`Q${mcq.idx} (B) not kept at submit`);
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261103-3 ─────────────────────────────────────────
  // Keyboard-only exam (no mouse): A–D picks, N/→ next, P/← back, F flags,
  // Tab to a choice + Space picks it without moving on, Esc closes the
  // navigator, keys pressed behind the open submit dialog change nothing,
  // and Enter on the focused Submit Test submits. Everything must save,
  // survive a reload and be graded.
  await check("D-20261103-3", [], "學生只用鍵盤考試（按 A–D 選答案、N/P 或左右鍵換題、F 標記、Tab 加空白鍵選答、Enter 交卷）：答案和標記都存得進去，交卷時跳出的確認視窗後面按鍵不會改到答案", "裝置/瀏覽器", () =>
    asStudent(80, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      const problems = [], notes = [];
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      if (qs.length < 4) throw new Error(`only ${qs.length} questions in Module 1`);
      const [q1, q2] = qs.map((q) => q.id);
      const total = await totalOf(page);
      const K = (k) => page.keyboard.press(k);
      const at = async (i) => onQuestion(page, i).then(() => true, () => false);
      await onQuestion(page, 1);
      await K("b");
      if (!(await isPicked(page, "B"))) problems.push("pressing B didn't pick B on Q1");
      await K("n");
      if (!(await at(2))) problems.push("N didn't move to Q2");
      await K("ArrowRight");
      if (!(await at(3))) problems.push("→ didn't move to Q3");
      await K("p");
      if (!(await at(2))) problems.push("P didn't move back to Q2");
      await K("Shift+D");
      if (!(await isPicked(page, "D"))) problems.push("pressing Shift+D didn't pick D on Q2");
      await K("f");
      const flagBtn = page.getByRole("button", { name: /Mark(ed)? for Review/ }).first();
      if ((await flagBtn.getAttribute("aria-pressed").catch(() => null)) !== "true") problems.push("F didn't mark Q2 for review");
      await K("ArrowLeft");
      if (!(await at(1))) problems.push("← didn't move back to Q1");
      // Tab to a choice that isn't picked and press Space: it must be picked, still on Q1.
      let tabbed = null;
      for (let i = 0; i < 60 && !tabbed; i++) {
        await K("Tab");
        tabbed = await page.evaluate(() => {
          const el = document.activeElement;
          if (el?.getAttribute("role") !== "radio" || el.getAttribute("aria-checked") === "true") return null;
          return el.querySelector("span")?.textContent?.trim() ?? null;
        });
      }
      if (!tabbed) throw new Error("setup: Tab never reached an unpicked answer choice");
      await K(" ");
      await sleep(300);
      if (!(await at(1))) problems.push("Space on a focused choice moved off Q1");
      if (!(await isPicked(page, tabbed))) problems.push(`Tab to choice ${tabbed} + Space didn't pick it`);
      const want = { [q1]: tabbed, [q2]: "D" };
      const r1 = await waitRow(m1.id, (r) => r.answers?.[q1] === tabbed && r.answers?.[q2] === "D" && (r.metadata?.flagged ?? []).includes(q2), 20000);
      notes.push(`saved Q1=${r1?.answers?.[q1] ?? "—"} Q2=${r1?.answers?.[q2] ?? "—"} flagged Q2=${(r1?.metadata?.flagged ?? []).includes(q2)}`);
      if (r1?.answers?.[q1] !== tabbed || r1?.answers?.[q2] !== "D") problems.push(`keyboard answers not saved (Q1=${r1?.answers?.[q1] ?? "—"} want ${tabbed}, Q2=${r1?.answers?.[q2] ?? "—"} want D)`);
      if (!(r1?.metadata?.flagged ?? []).includes(q2)) problems.push("the F flag on Q2 wasn't saved");
      // Navigator opened, Esc closes it.
      await page.getByRole("button", { name: /Question \d+ of \d+/ }).first().click();
      const nav = page.getByRole("dialog", { name: "Question Navigator" });
      await nav.waitFor({ timeout: 10000 });
      await K("Escape");
      if (!(await nav.waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false))) problems.push("Esc didn't close the question navigator");
      // Reload: answers and flag still there.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitTake(page);
      await jumpTo(page, 2);
      if (!(await isPicked(page, "D"))) problems.push("after reload Q2 doesn't show D");
      if ((await flagBtn.getAttribute("aria-pressed").catch(() => null)) !== "true") problems.push("after reload Q2 isn't marked for review");
      // Walk to the last question with N only.
      for (let i = 2; i < total; i++) await K("n");
      if (!(await at(total))) problems.push(`pressing N ${total - 2} times didn't reach Q${total}`);
      await jumpTo(page, total);
      await page.getByRole("button", { name: /Review & Submit/ }).focus();
      await K("Enter");
      const submitBtn = page.getByRole("button", { name: /Submit Test/ }).last();
      if (!(await submitBtn.waitFor({ timeout: 10000 }).then(() => true, () => false))) {
        problems.push("Enter on Review & Submit didn't open the submit dialog");
        await page.getByRole("button", { name: /Review & Submit/ }).click();
        await submitBtn.waitFor({ timeout: 10000 });
      }
      // Keys behind the open dialog must not change answers or move questions.
      await page.locator("body").focus().catch(() => {});
      for (const k of ["a", "c", "n", "p", "f"]) await K(k);
      await sleep(2500);
      const rBehind = (await db.from("submissions").select("answers,metadata").eq("id", m1.id).single()).data;
      const changed = Object.entries(rBehind?.answers ?? {}).filter(([id, v]) => want[id] !== v);
      if (changed.length || Object.keys(rBehind?.answers ?? {}).length !== 2) problems.push(`keys pressed behind the submit dialog changed answers: ${JSON.stringify(rBehind?.answers)}`);
      if (!(rBehind?.metadata?.flagged ?? []).includes(q2) || (rBehind?.metadata?.flagged ?? []).length !== 1) problems.push(`keys pressed behind the submit dialog changed flags: ${JSON.stringify(rBehind?.metadata?.flagged)}`);
      await submitBtn.focus();
      await K("Enter");
      const reached = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true, () => false);
      if (!reached) problems.push("Enter on Submit Test didn't submit (no Module 2 screen)");
      const fin = await waitRow(m1.id, (r) => r.status !== "In Progress", reached ? 15000 : 3000);
      notes.push(`submitted by Enter: ${fin?.status}, Q1=${fin?.answers?.[q1] ?? "—"} Q2=${fin?.answers?.[q2] ?? "—"}`);
      if (fin?.status === "In Progress") problems.push("Module 1 still In Progress");
      else if (fin?.answers?.[q1] !== tabbed || fin?.answers?.[q2] !== "D") problems.push(`graded with Q1=${fin?.answers?.[q1]} Q2=${fin?.answers?.[q2]} (want ${tabbed}, D)`);
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── shared for the 2026-11-04 checks ─────────────────────
  const flagBtnOf = (p) => p.getByRole("button", { name: /Mark(ed)? for Review/ }).first();
  const isFlagged = async (p) => (await flagBtnOf(p).getAttribute("aria-pressed").catch(() => null)) === "true";
  const isCrossed = async (p, l) => (await p.getByRole("button", { name: `Restore choice ${l}`, exact: true }).count()) > 0;
  const metaOf = async (id) => (await db.from("submissions").select("metadata").eq("id", id).single()).data?.metadata ?? {};

  // ── D-20261104-1 ─────────────────────────────────────────
  // Answers are merged per question (3e09f4a/04468a1), but flags and
  // crossed-out choices travel as whole lists. A student whose old laptop
  // lost Wi-Fi moves to another computer, marks/unmarks questions and crosses
  // out choices there; the old laptop, still open, reconnects and sends its
  // offline flag. Every computer's marks must survive, an un-mark made on the
  // new computer must stay un-marked, and the new computer must show them all
  // after a refresh.
  await check("D-20261104-1", [], "學生考到一半舊筆電斷網、換到另一台電腦繼續考，在新電腦上標記「稍後再看」、取消標記、刪去選項；之後舊筆電又連上網：兩台電腦做的標記和刪去的選項都要留著，新電腦取消的標記不能又跑回來", "考試流程", () =>
    asStudent(79, TESTS.engLinear, async ({ s, b, page }) => {
      const T = TESTS.engLinear;
      const problems = [], notes = [];
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      if (qs.length < 6) throw new Error(`only ${qs.length} questions in Module 1`);
      const [q1, q2, q3, , q5, q6] = qs.map((q) => q.id);
      // Old laptop (A): mark Q1 for review, saved.
      await onQuestion(page, 1);
      await flagBtnOf(page).click();
      const r0 = await waitRow(m1.id, (r) => (r.metadata?.flagged ?? []).includes(q1), 20000);
      if (!(r0?.metadata?.flagged ?? []).includes(q1)) throw new Error("setup: Q1's mark didn't save");
      // A loses Wi-Fi: marks Q2 and crosses out A on Q3 (only on this laptop).
      await page.context().setOffline(true);
      await jumpTo(page, 2); await flagBtnOf(page).click();
      if (!(await isFlagged(page))) throw new Error("setup: Q2 mark didn't toggle on the old laptop");
      await jumpTo(page, 3); await page.getByRole("button", { name: "Eliminate choice A", exact: true }).click();
      if (!(await isCrossed(page, "A"))) throw new Error("setup: crossing out A on Q3 didn't toggle");
      await sleep(1500);
      // New computer (B): resume, un-mark Q1, mark Q5, cross out B on Q6.
      const B = await login(b, STUDENT1_CLERK);
      const pb = B.page;
      try {
        await startTestBrowser(pb, T);
        await jumpTo(pb, 1);
        if (!(await isFlagged(pb))) throw new Error("setup: the new computer doesn't show Q1 marked");
        await flagBtnOf(pb).click();
        await jumpTo(pb, 5); await flagBtnOf(pb).click();
        await jumpTo(pb, 6); await pb.getByRole("button", { name: "Eliminate choice B", exact: true }).click();
        const rb = await waitRow(m1.id, (r) => {
          const f = r.metadata?.flagged ?? [];
          return f.includes(q5) && !f.includes(q1) && (r.metadata?.crossed_out?.[q6] ?? []).includes("B");
        }, 20000);
        const fb = rb?.metadata?.flagged ?? [];
        if (!(fb.includes(q5) && !fb.includes(q1) && (rb?.metadata?.crossed_out?.[q6] ?? []).includes("B")))
          throw new Error(`setup: the new computer's marks didn't save (flagged=${JSON.stringify(fb)})`);
        notes.push("new computer saved: Q1 un-marked, Q5 marked, Q6 B crossed out");
        // The old laptop reconnects and sends what it did offline.
        await page.context().setOffline(false);
        const ra = await waitRow(m1.id, (r) => (r.metadata?.flagged ?? []).includes(q2) && (r.metadata?.crossed_out?.[q3] ?? []).includes("A"), 45000);
        await sleep(3000);
        const meta = await metaOf(m1.id);
        const f = meta.flagged ?? [], x = meta.crossed_out ?? {};
        const has = (arr, v) => (arr ?? []).includes(v);
        notes.push(`after the old laptop reconnected: marked ${["Q1", "Q2", "Q5"].filter((_, i) => has(f, [q1, q2, q5][i])).join(",") || "none"}; crossed out Q3:${(x[q3] ?? []).join("") || "-"} Q6:${(x[q6] ?? []).join("") || "-"}`);
        if (!ra) notes.push("old laptop's offline marks never reached the server in 45 s");
        if (!has(f, q2)) problems.push("the old laptop's Q2 mark (made offline) was lost after it reconnected");
        if (!has(x[q3], "A")) problems.push("the old laptop's crossed-out choice A on Q3 (made offline) was lost");
        if (!has(f, q5)) problems.push("Q5, marked on the new computer, was un-marked on the server when the old laptop reconnected");
        if (!has(x[q6], "B")) problems.push("choice B on Q6, crossed out on the new computer, was restored on the server when the old laptop reconnected");
        if (has(f, q1)) problems.push("Q1, un-marked on the new computer, came back as marked when the old laptop reconnected");
        // The new computer refreshes: it must show its own marks still.
        await pb.reload({ waitUntil: "domcontentloaded" });
        await waitTake(pb);
        await jumpTo(pb, 5); const s5 = await isFlagged(pb);
        await jumpTo(pb, 6); const s6 = await isCrossed(pb, "B");
        await jumpTo(pb, 1); const s1 = await isFlagged(pb);
        await jumpTo(pb, 2); const s2 = await isFlagged(pb);
        notes.push(`new computer after refresh: Q5 marked=${s5}, Q6 B crossed=${s6}, Q1 marked=${s1}, Q2 marked=${s2}`);
        if (!s5) problems.push("after refreshing, the new computer shows Q5 un-marked");
        if (!s6) problems.push("after refreshing, the new computer shows Q6 choice B not crossed out");
        if (s1) problems.push("after refreshing, the new computer shows Q1 marked again");
      } finally {
        await B.context.close().catch(() => {});
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261104-2 ─────────────────────────────────────────
  // Laptop lid closed mid-exam and opened after the module's time ran out
  // (04468a1 rewrote the timer to count elapsed time). Just before closing,
  // Wi-Fi had dropped and Q3 was picked offline. On wake the clock jumps
  // forward, Wi-Fi returns a moment later. The page must count the sleep,
  // auto-submit without getting stuck, grade every answer picked in time
  // (Q3 included: the submit route accepts late inline answers), and the
  // student must get a clean Module 2 with its full time.
  await check("D-20261104-2", [], "學生考試中把筆電蓋上（睡眠），等時間結束後才打開：倒數要馬上歸零並自動交卷，不能卡住；蓋上前選的答案（包括斷網時選的）都要算分；接著第二模組要從完整的時間開始、答案存得進去", "計時", () =>
    asStudent(75, TESTS.engLinear, async ({ s, page }) => {
      const T = TESTS.engLinear;
      const tl = (await db.from("tests").select("time_limit_minutes,time_limit_minutes_module_2").eq("id", T).single()).data;
      const limit = tl.time_limit_minutes, full2 = (tl.time_limit_minutes_module_2 ?? tl.time_limit_minutes) * 60;
      const problems = [], notes = [];
      await page.clock.install({ time: new Date() });
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      if (qs.length < 4) throw new Error(`only ${qs.length} questions in Module 1`);
      const [q1, q2, q3] = qs.map((q) => q.id);
      await onQuestion(page, 1); await choice(page, "A").click();
      await jumpTo(page, 2); await choice(page, "B").click();
      const r0 = await waitRow(m1.id, (r) => r.answers?.[q1] === "A" && r.answers?.[q2] === "B", 20000);
      if (r0?.answers?.[q2] !== "B") throw new Error("setup: Q1/Q2 didn't save");
      // Wi-Fi drops, Q3 picked offline, then the lid closes.
      await page.context().setOffline(true);
      await jumpTo(page, 3); await choice(page, "C").click();
      await sleep(1000);
      // Asleep until 2 min after the time limit: server and laptop clock both move on.
      const started = Date.parse((await db.from("submissions").select("started_at").eq("id", m1.id).single()).data.started_at);
      const jump = limit * 60e3 + 120e3 - (Date.now() - started);
      const { error: upErr } = await db.from("submissions").update({ started_at: new Date(started - jump).toISOString() }).eq("id", m1.id).eq("status", "In Progress");
      if (upErr) throw new Error(`setup: moving started_at: ${upErr.message}`);
      const pageNow = await page.evaluate(() => Date.now());
      await page.clock.setSystemTime(new Date(pageNow + jump));
      const tWake = Date.now();
      await sleep(1500);
      await page.context().setOffline(false);
      // Timer must hit zero and the page must hand over to Module 2 by itself.
      let t0 = null;
      for (let i = 0; i < 10 && t0 !== 0; i++) { t0 = await timerSecsOf(page).catch(() => null); if (t0 !== 0) await sleep(500); }
      notes.push(`timer right after wake: ${t0 == null ? "gone (already submitting)" : `${t0}s`}`);
      if (t0 != null && t0 > 5) problems.push(`after waking past the time limit the timer still shows ${t0}s`);
      const reached = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 60000 }).then(() => true, () => false);
      const secs = Math.round((Date.now() - tWake) / 1000);
      if (!reached) {
        const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
        problems.push(`after waking past the time limit the page never reached the Module 2 screen in ${secs}s (shows: "${body}")`);
      } else notes.push(`auto-submitted, Module 2 screen after ${secs}s`);
      const fin = await waitRow(m1.id, (r) => r.status !== "In Progress", reached ? 15000 : 5000);
      const { data: recs } = await db.from("answer_records").select("question_id,student_answer").eq("submission_id", m1.id).in("question_id", [q1, q2, q3]);
      const rec = (id) => (recs ?? []).find((r) => r.question_id === id)?.student_answer ?? null;
      notes.push(`Module 1 ${fin?.status}: graded Q1=${rec(q1) ?? "—"} Q2=${rec(q2) ?? "—"} Q3=${rec(q3) ?? "—"}`);
      if (fin?.status === "In Progress") problems.push("Module 1 is still In Progress after waking past the time limit");
      else {
        const lost = [[q1, "A", 1], [q2, "B", 2], [q3, "C", 3]].filter(([id, v]) => rec(id) !== v);
        if (lost.length) problems.push(`graded without ${lost.map(([, v, n]) => `Q${n}=${v}`).join(", ")}${lost.some(([, , n]) => n === 3) ? " (Q3 was picked before time ran out, while Wi-Fi was down)" : ""}`);
      }
      // Module 2: full time, saves work.
      if (reached) {
        const tClick = Date.now();
        await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 });
        await waitTake(page);
        const t2 = await timerSecsOf(page);
        const loadS = Math.round((Date.now() - tClick) / 1000);
        notes.push(`Module 2 timer ${t2}s (full ${full2}s)`);
        if (t2 == null) problems.push("can't read the Module 2 timer");
        else if (t2 < full2 - loadS - 15 || t2 > full2) problems.push(`Module 2 timer shows ${t2}s, expected about ${full2}s`);
        const m2 = (await subs(s.id, T)).find((r) => String(r.adaptive_track).startsWith("module_2"));
        await onQuestion(page, 1); await choice(page, "D").click();
        const m2q1 = m2 ? (await moduleQs(m2.module_id))[0]?.id : null;
        const r2 = m2 && m2q1 ? await waitRow(m2.id, (r) => r.answers?.[m2q1] === "D", 20000) : null;
        if (r2?.answers?.[m2q1] !== "D") problems.push(`Module 2 Q1=D didn't save (${m2 ? `row ${m2.status}` : "no Module 2 row"})`);
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261104-3 ─────────────────────────────────────────
  // The admin gives the whole test more time while a student is in it (e.g. a
  // fire drill). The server deadline follows the new limit at once; the
  // student's open page must too: it must not auto-submit at the old end,
  // must keep saving, and a refresh must show the new time. Submitting inside
  // the new time is on time (not Late).
  await check("D-20261104-3", [], "學生正在考、只剩不到半分鐘時，管理員把這份測驗的時間加長 10 分鐘：學生開著的考試畫面不能在原本的時間到時就自動交卷，要能繼續作答、存得進去；重新整理後倒數是加長後的時間；在新時間內交卷算準時", "老師/管理員動作", async () => {
    const T = TESTS.engLinear;
    const orig = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data.time_limit_minutes;
    if (!orig) throw new Error("engLinear has no time limit");
    const EXTRA = 10;
    let admin = null;
    try {
      return await asStudent(78, T, async ({ s, b, page }) => {
        const problems = [], notes = [];
        await startTestBrowser(page, T);
        const [m1] = await subs(s.id, T);
        const qs = await moduleQs(m1.module_id);
        const [q1, q2, q3] = qs.map((q) => q.id);
        await onQuestion(page, 1); await choice(page, "A").click();
        if ((await waitRow(m1.id, (r) => r.answers?.[q1] === "A", 20000))?.answers?.[q1] !== "A") throw new Error("setup: Q1 didn't save");
        // Fast-forward this attempt to 25 s before the end, and reload so the page agrees.
        const { error: upErr } = await db.from("submissions").update({ started_at: new Date(Date.now() - (orig * 60 - 25) * 1000).toISOString() }).eq("id", m1.id).eq("status", "In Progress");
        if (upErr) throw new Error(`setup: moving started_at: ${upErr.message}`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitTake(page);
        const t0 = await timerSecsOf(page);
        if (t0 == null || t0 > 45) throw new Error(`setup: timer shows ${t0}s, expected under 45 s`);
        // The admin adds 10 minutes to the test.
        admin = await login(b, ADMIN_CLERK);
        const r = await admin.page.request.patch(`${BASE}/api/admin/tests/${T}`, { data: { timeLimitMinutes: orig + EXTRA } });
        if (r.status() >= 400) throw new Error(`setup: admin PATCH timeLimitMinutes → ${r.status()}`);
        const tPatch = Date.now();
        notes.push(`timer ${t0}s when the admin added ${EXTRA} min`);
        // Past the old end (+ the 60 s grace) on the page that was already open.
        await sleep(Math.max(0, (t0 + 65) * 1000 - (Date.now() - tPatch)));
        const mid = (await db.from("submissions").select("status").eq("id", m1.id).single()).data;
        const leftPage = await page.getByText("Module 1 submitted").first().isVisible().catch(() => false);
        const tMid = await timerSecsOf(page).catch(() => null);
        const expMid = (orig + EXTRA) * 60 - (Date.now() - Date.parse((await db.from("submissions").select("started_at").eq("id", m1.id).single()).data.started_at)) / 1000;
        notes.push(`65 s after the old end: Module 1 ${mid?.status}, page ${leftPage ? "on the Module 2 screen" : `timer ${tMid}s`} (server ≈${Math.round(expMid)}s)`);
        if (mid?.status !== "In Progress" || leftPage) {
          problems.push(`the open exam page auto-submitted Module 1 at the old end time (status ${mid?.status}), although the admin had added ${EXTRA} minutes — the student lost the extra time`);
        } else {
          if (tMid != null && tMid < expMid - 60) problems.push(`the open page's timer shows ${tMid}s while the extended deadline is ${Math.round(expMid)}s away`);
          await jumpTo(page, 2); await choice(page, "B").click();
          const r2 = await waitRow(m1.id, (row) => row.answers?.[q2] === "B", 20000);
          if (r2?.answers?.[q2] !== "B") problems.push("Q2 picked after the old end time (inside the extension) didn't save");
          // Refresh: the countdown must be the extended time.
          await page.reload({ waitUntil: "domcontentloaded" });
          await waitTake(page);
          const t1 = await timerSecsOf(page);
          const exp1 = (orig + EXTRA) * 60 - (Date.now() - Date.parse((await db.from("submissions").select("started_at").eq("id", m1.id).single()).data.started_at)) / 1000;
          notes.push(`after refresh: timer ${t1}s (server ≈${Math.round(exp1)}s)`);
          if (t1 == null || Math.abs(t1 - exp1) > 60) problems.push(`after refresh the timer shows ${t1}s, the extended deadline is ${Math.round(exp1)}s away`);
          await jumpTo(page, 3); await choice(page, "C").click();
          await goToSubmitModal(page, await totalOf(page));
          await page.getByRole("button", { name: /Submit Test/ }).last().click();
          await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).catch(() => problems.push("Submit did not reach the Module 2 screen"));
          const fin = await waitRow(m1.id, (row) => row.status !== "In Progress", 20000);
          const { data: recs } = await db.from("answer_records").select("question_id,student_answer").eq("submission_id", m1.id).in("question_id", [q1, q2, q3]);
          const rec = (id) => (recs ?? []).find((x) => x.question_id === id)?.student_answer ?? null;
          notes.push(`submitted inside the extension: ${fin?.status}, Q1=${rec(q1) ?? "—"} Q2=${rec(q2) ?? "—"} Q3=${rec(q3) ?? "—"}`);
          if (fin?.status !== "Submitted") problems.push(`submitted inside the extended time but marked ${fin?.status}`);
          if (rec(q1) !== "A" || rec(q2) !== "B" || rec(q3) !== "C") problems.push(`graded Q1=${rec(q1)} Q2=${rec(q2)} Q3=${rec(q3)} (want A, B, C)`);
        }
        if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
        return notes.join("; ");
      });
    } finally {
      if (admin) await admin.page.request.patch(`${BASE}/api/admin/tests/${T}`, { data: { timeLimitMinutes: orig } }).catch(() => {});
      const now = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data?.time_limit_minutes;
      if (now !== orig) await db.from("tests").update({ time_limit_minutes: orig }).eq("id", T);
    }
  }, 3 * 60 * 1000);

  // ── D-20261105-1 ─────────────────────────────────────────
  // The admin SHORTENS the test while a student is in it (e.g. correcting a
  // limit typed as 64 instead of 32). Since 01a51b3 the server is the
  // authority on time left and the open page re-syncs from each save's
  // reply. After the student's next answer the countdown must drop to the
  // new end; the page must auto-submit at the new end by itself (not leave
  // the student answering into saves the server rejects); every answer
  // picked before the new end is graded, and the module is on time.
  await check("D-20261105-1", [], "學生正在考時，管理員把這份測驗的時間縮短（只剩大約 1 分鐘）：學生下一次作答後畫面倒數要跟著變短，新的時間到時自動交卷，之前選的答案都要算分，而且不算遲交", "老師/管理員動作", async () => {
    const T = TESTS.engLinear;
    const orig = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data.time_limit_minutes;
    if (!orig || orig < 5) throw new Error(`engLinear time limit is ${orig}`);
    const NEW = 2;
    try {
      return await asStudent(72, T, async ({ s, b, page }) => {
        const problems = [], notes = [];
        let admin = null;
        try {
          await startTestBrowser(page, T);
          const [m1] = await subs(s.id, T);
          const qs = await moduleQs(m1.module_id);
          const [q1, q2, q3] = qs.map((q) => q.id);
          await onQuestion(page, 1); await choice(page, "A").click();
          if ((await waitRow(m1.id, (r) => r.answers?.[q1] === "A", 20000))?.answers?.[q1] !== "A") throw new Error("setup: Q1 didn't save");
          // 60 s into the attempt, so a 2-minute limit leaves about 1 minute; reload so the page agrees.
          const { error: upErr } = await db.from("submissions").update({ started_at: new Date(Date.now() - 60e3).toISOString() }).eq("id", m1.id).eq("status", "In Progress");
          if (upErr) throw new Error(`setup: moving started_at: ${upErr.message}`);
          await page.reload({ waitUntil: "domcontentloaded" });
          await waitTake(page);
          const t0 = await timerSecsOf(page);
          if (t0 == null || t0 < orig * 60 - 120) throw new Error(`setup: timer shows ${t0}s, expected about ${orig * 60 - 60}s`);
          admin = await login(b, ADMIN_CLERK);
          const r = await admin.page.request.patch(`${BASE}/api/admin/tests/${T}`, { data: { timeLimitMinutes: NEW } });
          if (r.status() >= 400) throw new Error(`setup: admin PATCH timeLimitMinutes → ${r.status()}`);
          const started = Date.parse((await db.from("submissions").select("started_at").eq("id", m1.id).single()).data.started_at);
          const serverLeft = () => NEW * 60 - (Date.now() - started) / 1000;
          notes.push(`timer ${t0}s when the admin cut the limit to ${NEW} min (server ≈${Math.round(serverLeft())}s left)`);
          // The student answers Q2: the save's reply carries the new time left.
          await jumpTo(page, 2); await choice(page, "B").click();
          const r2 = await waitRow(m1.id, (row) => row.answers?.[q2] === "B", 15000);
          if (r2?.answers?.[q2] !== "B") problems.push("Q2, picked right after the cut, didn't save");
          await sleep(1500);
          const t1 = await timerSecsOf(page).catch(() => null);
          const exp1 = serverLeft();
          notes.push(`after the next save: timer ${t1}s (server ≈${Math.round(exp1)}s)`);
          if (t1 == null || t1 > exp1 + 10)
            problems.push(`after the student's next answer was saved the timer still shows ${t1}s, but the server only allows ≈${Math.round(exp1)}s more — the student would keep answering after the server stops taking answers`);
          await jumpTo(page, 3); await choice(page, "C").click();
          const r3 = await waitRow(m1.id, (row) => row.answers?.[q3] === "C", 15000);
          if (r3?.answers?.[q3] !== "C") problems.push("Q3, picked inside the shortened time, didn't save");
          // The new end: the page must hand over to Module 2 by itself.
          const reached = await page.getByText("Module 1 submitted").first()
            .waitFor({ timeout: Math.max(0, serverLeft() * 1000) + 25000 }).then(() => true, () => false);
          const overS = Math.round(-serverLeft());
          if (!reached) {
            const tEnd = await timerSecsOf(page).catch(() => null);
            const row = (await db.from("submissions").select("status").eq("id", m1.id).single()).data;
            const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 140);
            problems.push(`${overS}s after the shortened time ran out the page had not auto-submitted (timer ${tEnd}s, Module 1 ${row?.status}; page shows "${body}")`);
          } else notes.push(`auto-submitted ${overS}s after the new end`);
          const fin = await waitRow(m1.id, (row) => row.status !== "In Progress", reached ? 15000 : 3000);
          const { data: recs } = await db.from("answer_records").select("question_id,student_answer").eq("submission_id", m1.id).in("question_id", [q1, q2, q3]);
          const rec = (id) => (recs ?? []).find((x) => x.question_id === id)?.student_answer ?? null;
          notes.push(`Module 1 ${fin?.status}: graded Q1=${rec(q1) ?? "—"} Q2=${rec(q2) ?? "—"} Q3=${rec(q3) ?? "—"}`);
          if (fin && fin.status !== "In Progress") {
            if (fin.status !== "Submitted") problems.push(`auto-submitted at the new end but marked ${fin.status}`);
            if (rec(q1) !== "A" || rec(q2) !== "B" || rec(q3) !== "C") problems.push(`graded Q1=${rec(q1)} Q2=${rec(q2)} Q3=${rec(q3)} (want A, B, C — all picked before the new end)`);
          }
        } finally {
          if (admin) await admin.page.request.patch(`${BASE}/api/admin/tests/${T}`, { data: { timeLimitMinutes: orig } }).catch(() => {});
        }
        if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
        return notes.join("; ");
      });
    } finally {
      const now = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data?.time_limit_minutes;
      if (now !== orig) await db.from("tests").update({ time_limit_minutes: orig }).eq("id", T);
    }
  }, 3 * 60 * 1000);

  // ── D-20261105-2 ─────────────────────────────────────────
  // Commit 00ddf34: when the tab is hidden or closed, the page sends a
  // keepalive save, which browsers cap at 64KB. Highlight notes have no
  // length limit, so with very long notes the page drops them from that
  // save and keeps the answers. Tonight: notes of 62,000 characters made
  // while saves are failing, then an answer, then the tab is switched away
  // (A) or closed (B) right after a failed save. The answer must reach the
  // server through the keepalive save; the long note must reach the server
  // once the student is back (A) or reopens the exam (B); the submit grades all.
  await check("D-20261105-2", [], "英文題的筆記寫得非常長（超過 6 萬字）、剛好存檔失敗中，學生選完答案就切到別的分頁或關掉分頁：剛選的答案一定要存進去，回來或重新打開後長筆記也要完整存到，交卷時答案都算分", "考試流程", () =>
    asStudent(73, TESTS.engLinear, async ({ s, context, page }) => {
      const T = TESTS.engLinear;
      const problems = [], notes = [];
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      const [q1, q2, q3] = qs.map((q) => q.id);
      const longNote = (tag) => `QA long note ${tag}: `.padEnd(62000, "the author contrasts two views of the evidence; ");
      const NOTE1 = longNote("Q1"), NOTE3 = longNote("Q3");
      async function highlightWithNote(p, note) {
        const ok = await p.evaluate(() => {
          for (const root of document.querySelectorAll("[data-anchor]")) {
            if (!root.offsetParent) continue;
            const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n; n = w.nextNode()) {
              if ((n.textContent ?? "").trim().length < 40) continue;
              const r = document.createRange();
              r.setStart(n, 10); r.setEnd(n, 30);
              const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
              document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
              return true;
            }
          }
          return false;
        });
        if (!ok) throw new Error("no highlightable text on this question");
        await p.getByRole("button", { name: "Highlight", exact: true }).click({ timeout: 10000 });
        await p.locator("mark.satos-highlight").first().waitFor({ timeout: 10000 });
        await p.locator("mark.satos-highlight").first().click();
        await p.getByPlaceholder(/Add a note for this highlight/).fill(note);
        await p.getByRole("button", { name: "Save", exact: true }).click();
      }
      const noteOnServer = (row, qid, note) => Object.values(row?.metadata?.annotations?.[qid] ?? {}).flat().some((a) => a?.note === note);
      // Saves fail (the regular ones); the test watches for a failed retry, then lets saves through.
      let aborted = 0;
      const blockSaves = (route) => (route.request().method() === "PATCH" ? (aborted++, route.abort("failed")) : route.continue());
      const SAVE_URL = "**/api/student/submissions/**";
      const flushes = [];
      context.on("request", (req) => {
        if (req.method() === "PATCH" && req.url().includes(m1.id)) {
          flushes.push({ at: Date.now() });
        }
      });
      const waitAborts = async (n, ms = 20000) => {
        const until = Date.now() + ms;
        while (aborted < n && Date.now() < until) await sleep(100);
        if (aborted < n) throw new Error(`setup: only ${aborted} failed save attempts, expected ${n}`);
      };
      // After 3 failed retries the page backs off 8 s, so a save that lands
      // within 4 s of leaving the tab can only be the leave-page (keepalive) save.
      async function failOnceMoreThenUnblock(n0) {
        await waitAborts(n0 + 1);
        await sleep(150);
        await page.unroute(SAVE_URL, blockSaves);
      }

      await onQuestion(page, 1); await choice(page, "A").click();
      if ((await waitRow(m1.id, (r) => r.answers?.[q1] === "A", 20000))?.answers?.[q1] !== "A") throw new Error("setup: Q1 didn't save");

      // A: long note on Q1 + Q2=B while saves fail; then the student switches to another tab.
      await page.route(SAVE_URL, blockSaves);
      const a0 = aborted;
      await highlightWithNote(page, NOTE1);
      await jumpTo(page, 2);
      await waitAborts(a0 + 3);
      const nA = aborted;
      await choice(page, "B").click();
      await failOnceMoreThenUnblock(nA);
      const tA = Date.now();
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const rA = await waitRow(m1.id, (r) => r.answers?.[q2] === "B", 4000);
      const sA = ((Date.now() - tA) / 1000).toFixed(1);
      notes.push(`A (tab hidden): ${flushes.filter((f) => f.at >= tA).length} leave-save request(s), Q2 ${rA?.answers?.[q2] === "B" ? `saved within ${sA}s` : "NOT saved"}`);
      if (rA?.answers?.[q2] !== "B") problems.push("Q2, picked just before switching tabs, wasn't saved by the leave-page save (not on the server 4 s after the tab was hidden)");
      await sleep(2000);
      await page.evaluate(() => {
        delete document.visibilityState; delete document.hidden;
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      const rA2 = await waitRow(m1.id, (r) => noteOnServer(r, q1, NOTE1), 40000);
      const keptA = noteOnServer(rA2, q1, NOTE1);
      notes.push(`back on the tab: Q1's ${NOTE1.length}-character note ${keptA ? "saved" : "NOT saved"}`);
      if (!keptA) problems.push(`back on the exam tab, Q1's long note (${NOTE1.length} characters) never reached the server within 40 s`);

      // B: long note on Q3 + Q3=C while saves fail; then the tab is closed.
      await jumpTo(page, 3);
      await page.route(SAVE_URL, blockSaves);
      const b0 = aborted;
      await highlightWithNote(page, NOTE3);
      await waitAborts(b0 + 3);
      const nB = aborted;
      await choice(page, "C").click();
      await failOnceMoreThenUnblock(nB);
      const tB = Date.now();
      await page.goto("about:blank");
      const rB = await waitRow(m1.id, (r) => r.answers?.[q3] === "C", 8000);
      notes.push(`B (tab closed): ${flushes.filter((f) => f.at >= tB).length} leave-save request(s), Q3 ${rB?.answers?.[q3] === "C" ? "saved" : "NOT saved"}`);
      if (rB?.answers?.[q3] !== "C") problems.push("Q3, picked just before the tab was closed, didn't reach the server");
      // Reopen the exam on the same computer.
      const p2 = await context.newPage();
      await p2.goto(`${BASE}/student/tests/${T}/take`, { waitUntil: "domcontentloaded" });
      await waitTake(p2);
      const rB2 = await waitRow(m1.id, (r) => noteOnServer(r, q3, NOTE3), 30000);
      const keptB = noteOnServer(rB2, q3, NOTE3);
      notes.push(`reopened: Q3's note ${keptB ? "saved" : "NOT saved"}`);
      if (!keptB) problems.push(`after reopening the exam, Q3's long note (${NOTE3.length} characters, written while saves were failing) never reached the server within 30 s`);
      await jumpTo(p2, 3);
      if (!(await isPicked(p2, "C"))) problems.push("after reopening, Q3 doesn't show C as picked");
      if ((await p2.locator("mark.satos-highlight").count()) < 1) problems.push("after reopening, Q3's highlight isn't shown");
      // Submit: all three answers graded, notes still there.
      await goToSubmitModal(p2, await totalOf(p2));
      await p2.getByRole("button", { name: /Submit Test/ }).last().click();
      const reached = await p2.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true, () => false);
      if (!reached) problems.push("Submit didn't reach the Module 2 screen");
      const fin = await waitRow(m1.id, (r) => r.status !== "In Progress", 20000);
      const { data: recs } = await db.from("answer_records").select("question_id,student_answer").eq("submission_id", m1.id).in("question_id", [q1, q2, q3]);
      const rec = (id) => (recs ?? []).find((x) => x.question_id === id)?.student_answer ?? null;
      notes.push(`submitted (${fin?.status}): Q1=${rec(q1) ?? "—"} Q2=${rec(q2) ?? "—"} Q3=${rec(q3) ?? "—"}`);
      if (rec(q1) !== "A" || rec(q2) !== "B" || rec(q3) !== "C") problems.push(`graded Q1=${rec(q1)} Q2=${rec(q2)} Q3=${rec(q3)} (want A, B, C)`);
      if (!noteOnServer(fin, q1, NOTE1) || !noteOnServer(fin, q3, NOTE3)) problems.push("after submitting, a long note is missing from the saved exam");
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261105-3 ─────────────────────────────────────────
  // Every live typed-answer (SPR) math question must be gradable: a student
  // must be able to type a correct answer in the box (numbers only, max 12
  // characters), and the forms the SAT accepts must be graded right by the
  // app's own grader (lib/grade-submission.ts answersMatch, run through tsx):
  // the key as written, its exact decimal, 3/4 for a 0.75 key, and for values
  // too long for the grid the 5-character truncated or rounded decimal
  // (2/3 → .6666, .6667, 0.666, 0.667). A wrong number must be graded wrong.
  await check("D-20261105-3", [], "題庫裡每一題上線的數學填答題，學生都要打得出正確答案而且被算對（分數、小數、SAT 規定的四捨五入或截斷寫法都要算對），打錯的數字要算錯", "計分", async () => {
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(here, "../../../..");
    const qsAll = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await db.from("questions").select("id,module_id,original_question_number,correct_answer")
        .eq("parsing_status", "Approved").eq("question_type", "Student Produced Response").range(i, i + 999);
      if (error) throw new Error(`questions: ${error.message}`);
      qsAll.push(...data);
      if (data.length < 1000) break;
    }
    if (qsAll.length < 50) throw new Error(`only ${qsAll.length} live SPR questions found`);
    const mods = new Map(((await db.from("modules").select("id,module_name").in("id", [...new Set(qsAll.map((q) => q.module_id))])).data ?? []).map((m) => [m.id, m.module_name]));
    const parse = (c) => {
      const t = c.replace(/,(?=\d{3}\b)/g, "");
      if (/^-?(\d+(\.\d+)?|\.\d+)$/.test(t)) return Number(t);
      const f = t.match(/^(-?\d+)\s*\/\s*(\d+)$/);
      return f && Number(f[2]) ? Number(f[1]) / Number(f[2]) : null;
    };
    const typeable = (t) => t.length <= 12 && /^-?[\d.,/]+$/.test(t);
    const fitsGrid = (v) => [0, 1, 2, 3, 4].some((d) => { const s = Math.abs(v).toFixed(d).replace(/^0\./, "."); return s.length <= 5 && Math.abs(Number(s) - Math.abs(v)) < 1e-9; });
    const trimDec = (s) => s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
    function satForms(v) {
      const sign = v < 0 ? "-" : "", a = Math.abs(v), out = new Set();
      if (fitsGrid(v)) {
        for (let d = 0; d <= 4; d++) if (Math.abs(Number(a.toFixed(d)) - a) < 1e-9) { const s = trimDec(a.toFixed(d)); out.add(sign + s); if (s.startsWith("0.")) out.add(sign + s.slice(1)); break; }
        return [...out];
      }
      const intLen = Math.trunc(a) === 0 ? 0 : String(Math.trunc(a)).length;
      const shapes = intLen === 0 ? [[4, ""], [3, "0"]] : [[5 - intLen - 1, null]];
      for (const [d, lead] of shapes) {
        if (d < 1) continue;
        const sc = 10 ** d;
        for (const x of [Math.trunc(a * sc) / sc, Math.round(a * sc) / sc]) {
          let s = x.toFixed(d);
          if (lead === "") s = s.replace(/^0/, "");
          out.add(sign + s);
        }
      }
      return [...out];
    }
    const cases = [], unreachable = [];
    for (const q of qsAll) {
      const key = String(q.correct_answer ?? "").trim();
      const where = `${mods.get(q.module_id) ?? q.module_id.slice(0, 8)} 第${q.original_question_number}題`;
      const cands = key.split(/\s*(?:\bor\b|[\n;|])\s*|,\s+|(?<=\D),(?=\D)/i).map((c) => c.trim()).filter(Boolean);
      const vals = cands.map((c) => ({ c, v: parse(c) })).filter((x) => x.v != null);
      if (!vals.length || !cands.some(typeable)) { unreachable.push(`${where}：答案是「${key}」，學生在答案格只能打數字，永遠打不出這個答案`); continue; }
      for (const { c, v } of vals) {
        const right = new Set(satForms(v));
        if (typeable(c)) right.add(c);
        if (!/\//.test(c) && !Number.isInteger(v)) for (let d = 2; d <= 100; d++) if (Math.abs(v * d - Math.round(v * d)) < 1e-9) { right.add(`${Math.round(v * d)}/${d}`); break; }
        for (const t of right) if (typeable(t)) cases.push({ where, key, typed: t, want: true });
        const wrong = v + 1;
        if (!vals.some((x) => Math.abs(x.v - wrong) < 1e-3)) cases.push({ where, key, typed: trimDec(wrong.toFixed(4)), want: false });
      }
    }
    const tsx = path.join(appRoot, "node_modules/.bin/tsx");
    const out = execFileSync(tsx, [path.join(here, "spr-grade.ts")], { cwd: appRoot, input: JSON.stringify(cases.map(({ key, typed }) => ({ key, typed }))), timeout: 60000 }).toString();
    const got = JSON.parse(out);
    if (!Array.isArray(got) || got.length !== cases.length) throw new Error(`grader returned ${Array.isArray(got) ? got.length : typeof got} results for ${cases.length} cases`);
    const wrongGrade = cases.filter((c, i) => got[i] !== c.want).map((c) => `${c.where}：答案「${c.key}」，學生打「${c.typed}」被算${c.want ? "錯（這是正確寫法）" : "對（這是錯的數字）"}`);
    const problems = [...unreachable, ...wrongGrade];
    const summary = `checked ${qsAll.length} live SPR questions, ${cases.length} typed answers through the app's grader`;
    if (problems.length) fail(`${summary}; ${problems.length} 個問題：${problems.slice(0, 12).join("；")}${problems.length > 12 ? ` …（另 ${problems.length - 12} 個）` : ""}`);
    return summary;
  }, 2 * 60 * 1000);

  // ── D-20261106-1 ─────────────────────────────────────────
  // Commit fa1d76b changed the sign-in gate (proxy.ts) to open /terms,
  // /privacy and /disclaimer to signed-out visitors, and added a cron route
  // (/api/cron/ai-spend-alert) that only checks CRON_SECRET when it is set.
  // Must stay true: the three pages open for anyone (and the landing page's
  // footer links reach them); nothing else becomes public through the new
  // entries or path tricks; every cron route (including auto-finalize, which
  // force-submits exams) refuses a caller without the secret.
  // Safety: CRON_SECRET is set in production (vercel env ls). The harmless
  // auto-finalize route is probed first; if it doesn't refuse, the check stops
  // before calling ai-spend-alert, so it can never trigger a real alert email.
  await check("D-20261106-1", [], "新開放的條款/隱私/免責頁沒登入也打得開，但其他頁面不能因此被打開；自動交卷等排程網址沒有密碼時一律拒絕", "安全", async () => {
    const https = await import("node:https");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    // Raw request: the path goes out exactly as written (no ../ or %2e folding).
    const raw = (method, p, headers = {}) => new Promise((resolve) => {
      const u = new URL(BASE);
      const req = https.request({ host: u.hostname, port: u.port || 443, method, path: p, headers: { "user-agent": "sat-qa-nightly", ...headers }, timeout: 30000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (body.length < 400000) body += c; });
        res.on("end", () => resolve({ status: res.statusCode, type: String(res.headers["content-type"] ?? ""), loc: String(res.headers.location ?? ""), body }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, type: "", loc: "", body: String(e.message) }));
      req.end();
    });
    const problems = [], notes = [];
    const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

    // 1. The three legal pages, signed out: 200 with the real document.
    for (const slug of ["terms", "privacy", "disclaimer"]) {
      const md = fs.readFileSync(path.join(appRoot, "docs/LEGAL", `${slug}.md`), "utf8");
      const heading = (md.match(/^#\s+(.+)$/m)?.[1] ?? "").trim();
      const firstPara = md.split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !x.startsWith("#") && !/^\*\*[^*]+\*\*$/.test(x)) ?? "";
      const probe = firstPara.replace(/[*_`"]/g, "").replace(/\s+/g, " ").slice(0, 40);
      const r = await raw("GET", `/${slug}`);
      const t = text(r.body);
      if (r.status !== 200) problems.push(`/${slug} signed out → HTTP ${r.status}${r.loc ? ` → ${r.loc}` : ""} (should open for anyone)`);
      else if (!heading || !t.includes(heading) || !t.replace(/[*_`"]/g, "").includes(probe))
        problems.push(`/${slug} opened but doesn't show the document (heading "${heading}" ${t.includes(heading) ? "found" : "missing"}, text "${probe}" ${t.includes(probe) ? "found" : "missing"})`);
      else if (/Application error|Internal Server Error|This page could not be found/i.test(t)) problems.push(`/${slug} shows an error page`);
    }
    // 2. Landing page footer links to the legal documents must all open.
    const home = await raw("GET", "/");
    const links = [...new Set([...home.body.matchAll(/href="([^"]*(?:terms|privacy|disclaimer)[^"]*)"/gi)].map((m) => m[1]))];
    if (home.status !== 200) problems.push(`landing page → HTTP ${home.status}`);
    else if (links.length < 3) problems.push(`landing page links only ${links.length} legal page(s): ${links.join(", ") || "none"}`);
    for (const l of links) {
      const u = l.startsWith("http") ? new URL(l) : new URL(l, BASE);
      if (u.host !== new URL(BASE).host) continue;
      const r = await raw("GET", u.pathname + u.search);
      if (r.status !== 200) problems.push(`landing page link ${l} → HTTP ${r.status} (a broken footer link)`);
    }
    notes.push(`legal pages 200 with their text; landing links ${links.join(", ")}`);

    // 3. Nothing else became public: near-miss paths and path tricks, signed out.
    const T = TESTS.engLinear;
    const closed = [
      "/terms/x", "/privacy/student", "/disclaimer/admin", "/TERMS", "/terms.json",
      "/terms/..%2Fstudent%2Ftests", "/privacy/%2e%2e/student/tests", "/terms/../student/tests",
      "/student/tests", `/student/tests/${T}/take`, "/admin", "/teacher",
      "/api/cron/%2e%2e/student/submissions", "/api/cron/..%2F..%2Fapi/student/submissions",
      "/api/webhooks/%2e%2e/student/submissions", "/api/public/..%2Fstudent/submissions",
      "/api/student/submissions?next=/terms", "/api/student/submissions;/terms", "/api/student/submissions/..%2F..%2Fcron/x",
    ];
    const leaks = [];
    for (const p of closed) {
      const r = await raw("GET", p);
      // A 200 is acceptable only if it is plainly a sign-in or not-found page.
      const looksClosed = r.status !== 200 || /sign-in|Sign in|404|could not be found/i.test(text(r.body).slice(0, 4000));
      const json = /json/.test(r.type) && r.status === 200;
      if (!looksClosed || json || /"(answers|student_id|correct_answer|questions)"\s*:/.test(r.body)) leaks.push(`${p} → ${r.status} ${r.type.split(";")[0]}`);
    }
    if (leaks.length) problems.push(`signed-out visitor got a page/data that should need sign-in: ${leaks.join("; ")}`);
    notes.push(`${closed.length} near-miss/trick paths stay closed`);

    // 4. Cron routes, discovered from the app so new ones are covered too.
    const cronDir = path.join(appRoot, "app/api/cron");
    const routes = [];
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/${e.name}`);
        else if (e.name === "route.ts") {
          const src = fs.readFileSync(path.join(dir, e.name), "utf8");
          const methods = [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
          routes.push({ p: `/api/cron${rel}`.replace(/\[[^\]]+\]/g, "00000000-0000-4000-8000-000000000000"), methods });
        }
      }
    };
    walk(cronDir, "");
    if (routes.length < 2) throw new Error(`found only ${routes.length} cron routes in the app source`);
    // Safety gate: the harmless finalizer first.
    const gate = await raw("GET", "/api/cron/auto-finalize-stale-submissions");
    if (gate.status !== 401) {
      fail(`/api/cron/auto-finalize-stale-submissions without the secret → HTTP ${gate.status} (should be 401: anyone could trigger the exam auto-submitter). Stopped before the other cron routes so no alert email can be sent.`);
    }
    const tokens = [null, "Bearer wrong-secret", "Bearer ", "Bearer undefined", "Bearer null", "bearer wrong-secret"];
    const openCron = [];
    let calls = 0;
    for (const r of routes) {
      for (const m of r.methods) {
        for (const tok of tokens) {
          for (const q of r.p.includes("ai-spend-alert") || r.p.includes("auto-finalize") ? ["", "?test=1"] : [""]) {
            const res = await raw(m, r.p + q, tok == null ? {} : { authorization: tok });
            calls++;
            if (res.status !== 401) openCron.push(`${m} ${r.p}${q} with ${tok == null ? "no" : `"${tok}"`} authorization → ${res.status} ${res.body.slice(0, 60)}`);
          }
        }
      }
    }
    if (openCron.length) problems.push(`cron routes answered without the right secret: ${openCron.slice(0, 6).join("; ")}${openCron.length > 6 ? ` …(+${openCron.length - 6})` : ""}`);
    notes.push(`${routes.length} cron routes × ${tokens.length} wrong/missing secrets (${calls} calls) all 401`);
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 3 * 60 * 1000);

  // ── D-20261106-2 ─────────────────────────────────────────
  // POST /api/admin/submissions/[id]/reset turns the SAME submission back into
  // a fresh attempt (answers {}, metadata {}, started_at now). Admins use it
  // when a student's browser crashed or their laptop lost Wi-Fi. The take
  // page keeps a device backup keyed by the submission id
  // (sat-exam:attempt:<id>) and, on reopen, re-applies answers/flags made on
  // this device that "never reached the server". Situation: Wi-Fi drops, the
  // student picks Q3 and marks Q4, the tab is closed; the admin resets; the
  // student reopens on the same laptop. The fresh attempt must be fresh:
  // nothing from before the reset on screen or on the server, Q1, full time;
  // and the student must be able to answer and submit normally.
  await check("D-20261106-2", [], "學生考到一半網路斷掉、關掉分頁，管理員幫他「重設」考卷後，學生在同一台電腦重新打開：要是全新的考卷（沒有舊答案和標記、從第一題開始、時間是完整的），作答和交卷都正常", "老師/管理員動作", () =>
    asStudent(76, TESTS.engLinear, async ({ s, b, page, context }) => {
      const T = TESTS.engLinear;
      const problems = [], notes = [];
      const limit = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data.time_limit_minutes;
      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      if (qs.length < 5) throw new Error(`only ${qs.length} questions in Module 1`);
      const [q1, q2, q3, q4] = qs.map((q) => q.id);
      const total = await totalOf(page);
      // Before the crash: Q1=A and Q2=B with Q2 marked, all saved.
      await onQuestion(page, 1); await choice(page, "A").click();
      await jumpTo(page, 2); await choice(page, "B").click(); await flagBtnOf(page).click();
      const r0 = await waitRow(m1.id, (r) => r.answers?.[q1] === "A" && r.answers?.[q2] === "B" && (r.metadata?.flagged ?? []).includes(q2), 20000);
      if (!(r0?.answers?.[q2] === "B" && (r0?.metadata?.flagged ?? []).includes(q2))) throw new Error("setup: Q1/Q2/flag didn't save");
      // Wi-Fi drops: Q3=C and a mark on Q4 stay on this laptop only; then the tab is closed.
      await context.setOffline(true);
      await jumpTo(page, 3); await choice(page, "C").click();
      await jumpTo(page, 4); await flagBtnOf(page).click();
      await sleep(1500);
      const backup = await page.evaluate((id) => localStorage.getItem(`sat-exam:attempt:${id}`), m1.id);
      const bk = backup ? JSON.parse(backup) : null;
      if (bk?.answers?.[q3] !== "C" || !(bk?.flagged ?? []).includes(q4)) throw new Error("setup: the device backup doesn't hold the offline Q3 answer / Q4 mark");
      await page.close();
      const pre = (await db.from("submissions").select("answers").eq("id", m1.id).single()).data;
      if (pre?.answers?.[q3]) throw new Error("setup: Q3 reached the server although the laptop was offline");
      // 20 minutes have gone by when the admin steps in.
      await db.from("submissions").update({ started_at: new Date(Date.now() - 20 * 60e3).toISOString() }).eq("id", m1.id).eq("status", "In Progress");
      const admin = await login(b, ADMIN_CLERK);
      const rr = await admin.page.request.post(`${BASE}/api/admin/submissions/${m1.id}/reset`, {});
      await admin.context.close().catch(() => {});
      if (rr.status() >= 400) throw new Error(`setup: admin reset → ${rr.status()}`);
      const fresh = (await db.from("submissions").select("status,answers,metadata").eq("id", m1.id).single()).data;
      if (fresh?.status !== "In Progress" || Object.keys(fresh?.answers ?? {}).length) throw new Error(`setup: after reset the row is ${fresh?.status} with ${Object.keys(fresh?.answers ?? {}).length} answers`);
      notes.push("admin reset the exam (server: no answers, started now)");
      // Wi-Fi is back; the student reopens the exam on the same laptop.
      await context.setOffline(false);
      const p2 = await context.newPage();
      await startTestBrowser(p2, T);
      const rows = await subs(s.id, T);
      if (rows.length !== 1 || rows[0].id !== m1.id) problems.push(`reopening gave ${rows.length} exam row(s) (expected the one reset exam)`);
      await sleep(6000); // time for any restore + save to happen
      const where = Number((await p2.getByText(/Question \d+ of \d+/).first().innerText()).match(/Question (\d+)/)[1]);
      const secs = await timerSecsOf(p2);
      notes.push(`reopened at Q${where}, timer ${secs}s (full ${limit * 60}s)`);
      if (where !== 1) problems.push(`the reset exam opened at question ${where} (the old position from before the reset), not question 1`);
      if (secs == null || secs < limit * 60 - 90) problems.push(`the reset exam's timer shows ${secs}s, not the full ${limit * 60}s`);
      const shown = [];
      for (const [i, q] of [[1, q1], [2, q2], [3, q3], [4, q4]]) {
        void q;
        await jumpTo(p2, i);
        for (const l of ["A", "B", "C", "D"]) if (await isPicked(p2, l)) shown.push(`Q${i}=${l}`);
        if (await isFlagged(p2)) shown.push(`Q${i} marked`);
      }
      if (shown.length) problems.push(`the reset exam shows answers/marks from before the reset: ${shown.join(", ")}`);
      const srv = (await db.from("submissions").select("answers,metadata").eq("id", m1.id).single()).data;
      const srvOld = [
        ...[[q1, "Q1"], [q2, "Q2"], [q3, "Q3"], [q4, "Q4"]].filter(([id]) => srv?.answers?.[id]).map(([id, n]) => `${n}=${srv.answers[id]}`),
        ...[[q2, "Q2"], [q4, "Q4"]].filter(([id]) => (srv?.metadata?.flagged ?? []).includes(id)).map(([, n]) => `${n} marked`),
      ];
      if (srvOld.length) problems.push(`after reopening, the server's reset exam holds answers/marks from before the reset again: ${srvOld.join(", ")}`);
      // The student carries on normally: Q1=D, submit.
      await jumpTo(p2, 1); await choice(p2, "D").click();
      const r3 = await waitRow(m1.id, (r) => r.answers?.[q1] === "D", 20000);
      if (r3?.answers?.[q1] !== "D") problems.push("Q1=D, picked after reopening, didn't save");
      await goToSubmitModal(p2, total);
      await p2.getByRole("button", { name: /Submit Test/ }).last().click();
      const handed = await p2.getByText("Module 1 submitted").first().waitFor({ timeout: 30000 }).then(() => true, () => false);
      const fin = await waitRow(m1.id, (r) => r.status !== "In Progress", 20000);
      const { data: recs } = await db.from("answer_records").select("question_id,student_answer").eq("submission_id", m1.id).in("question_id", [q1, q2, q3, q4]);
      const rec = (id) => (recs ?? []).find((x) => x.question_id === id)?.student_answer ?? null;
      notes.push(`submitted: ${fin?.status}; graded Q1=${rec(q1) ?? "—"} Q2=${rec(q2) ?? "—"} Q3=${rec(q3) ?? "—"} Q4=${rec(q4) ?? "—"}`);
      if (!handed) problems.push("submitting the reset exam didn't move on to Module 2");
      if (fin?.status !== "Submitted") problems.push(`the reset exam ended as ${fin?.status}`);
      if (rec(q1) !== "D") problems.push(`Q1 graded as ${rec(q1)} (picked D after the reset)`);
      const oldGraded = [[q2, "Q2"], [q3, "Q3"]].filter(([id]) => rec(id)).map(([id, n]) => `${n}=${rec(id)}`);
      if (oldGraded.length) problems.push(`answers from before the reset were graded: ${oldGraded.join(", ")}`);
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261108-1 ─────────────────────────────────────────
  // Today's 3c6b77d/4e02749: an admin removes a student from their class
  // ("Remove from class" on the Students page) while the student is mid-exam.
  // The admin's warning must see the live exam; the student must still find
  // the exam on My Tests ("Finish your attempt"), resume it with the answers
  // intact and finish both modules, but never start a new attempt or a test
  // they hadn't begun. Second student: Module 1 graded, Module 2 never created
  // (failed handoff) when removed → "Continue to Module 2" must still work.
  await check("D-20261108-1", [], "學生考到一半時被管理員移出班級：管理員要被提醒有人在考；學生在「我的測驗」還找得到這份考卷、答案都在、能把兩個模組考完；但不能開始新的一次或還沒考過的測驗", "老師/管理員動作", async () => {
    const T = TESTS.engLinear, TM = TESTS.mathLinear;
    const A = studentByN(78), B = studentByN(73);
    if (!A || !B) throw new Error("students 078/073 not found");
    const orig = C.students[0].id;
    const tName = (await db.from("tests").select("test_name").eq("id", T).single()).data.test_name;
    const mName = (await db.from("tests").select("test_name").eq("id", TM).single()).data.test_name;
    const asg = (await db.from("test_assignments").select("class_group_ids,student_ids").eq("test_id", T).single()).data;
    if ((asg.student_ids ?? []).length) throw new Error("setup: engLinear now has direct student assignments");
    const memOf = async (st) => ((await db.from("class_group_members").select("class_group_id").eq("student_id", st.id)).data ?? []).map((m) => m.class_group_id);
    const memA = await memOf(A), memB = await memOf(B);
    const cgA = memA.filter((c) => asg.class_group_ids.includes(c)), cgB = memB.filter((c) => asg.class_group_ids.includes(c));
    if (cgA.length !== 1 || cgB.length !== 1) throw new Error(`setup: expected one assigned class each (078: ${cgA.length}, 073: ${cgB.length})`);
    const clean = async () => { for (const st of [A, B]) for (const t of [T, TM]) await deleteSubs(st.id, t).catch(() => {}); };
    const restore = async () => {
      for (const [st, cgs] of [[A, memA], [B, memB]]) for (const cg of cgs)
        await db.from("class_group_members").upsert({ class_group_id: cg, student_id: st.id }, { onConflict: "class_group_id,student_id" });
    };
    const problems = [], notes = [];
    await clean();
    const b = await chromium.launch();
    let admin;
    try {
      admin = await login(b, ADMIN_CLERK);
      const AR = admin.context.request;
      const removeFromClass = async (st, cg) => {
        const r = await AR.post(`${BASE}/api/admin/class-groups/${cg}/members`, { data: { action: "remove", studentId: st.id } });
        if (r.status() !== 200) throw new Error(`setup: admin remove-from-class → ${r.status()} ${(await r.text()).slice(0, 120)}`);
        if ((await memOf(st)).includes(cg)) throw new Error("setup: membership still there after remove");
      };
      // The My Tests row for a test name → its action link text ("" = not listed).
      const myTestsAction = async (page, name) => {
        await page.goto(`${BASE}/student/tests`, { waitUntil: "networkidle" });
        await page.locator("main").first().waitFor({ timeout: 20000 });
        const row = page.locator("tr", { hasText: name }).first();
        if (!(await row.count())) return { listed: false, actions: "" };
        const actions = (await row.locator("a").allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== name && !x.includes(name));
        return { listed: true, actions: actions.join(" | "), row };
      };

      // ── A: 078 mid-Module 1, tab closed, removed from class ──
      let x = await borrowAs(b, 78);
      let page = x.page;
      await startTestBrowser(page, T);
      const [m1] = await subs(A.id, T);
      const qs1 = await moduleQs(m1.module_id);
      await onQuestion(page, 1); await choice(page, "A").click();
      await page.getByRole("button", { name: /^Next/ }).first().click();
      await onQuestion(page, 2); await choice(page, "B").click();
      const saved = await waitRow(m1.id, (r) => r.answers?.[qs1[0].id] === "A" && r.answers?.[qs1[1].id] === "B", 20000);
      if (!(saved?.answers?.[qs1[1].id] === "B")) throw new Error("setup: Q1/Q2 didn't save before the removal");
      await page.close();
      // Admin side: the new "who is mid-test" warning must see this exam.
      const chk = await AR.post(`${BASE}/api/admin/class-groups/${cgA[0]}/in-progress-check`, { data: { studentIds: [A.id] } });
      const chkJ = await chk.json().catch(() => ({}));
      const hit = (chkJ.tests ?? []).find((t) => t.id === T);
      if (chk.status() !== 200 || !hit || !(hit.inProgressCount >= 1)) problems.push(`the admin's "students mid-test" warning didn't list this exam (${chk.status()} ${JSON.stringify(chkJ).slice(0, 120)}), so the admin isn't warned`);
      else notes.push(`admin warning lists the exam (${hit.inProgressCount} mid-test)`);
      await removeFromClass(A, cgA[0]);
      page = await x.context.newPage();
      const lA = await myTestsAction(page, tName);
      const lM = await myTestsAction(page, mName);
      notes.push(`078 removed: My Tests shows exam ${lA.listed ? `"${lA.actions}"` : "NOT listed"}; never-started math test ${lM.listed ? `listed "${lM.actions}"` : "not listed"}`);
      if (!lA.listed) problems.push("after being removed from the class mid-exam, the student's exam disappeared from My Tests");
      else if (!/Finish your attempt|Continue/i.test(lA.actions)) problems.push(`My Tests row for the unfinished exam offers "${lA.actions}" instead of a way to finish it`);
      if (lM.listed && /Start/i.test(lM.actions)) problems.push("a test the student never started is still offered (Start) after removal from the class");
      const newM = await x.context.request.post(`${BASE}/api/student/submissions`, { data: { testId: TM } });
      if (newM.status() < 400) problems.push(`after removal the student could still start a test they hadn't begun (${newM.status()})`);
      if (lA.listed) {
        await myTestsAction(page, tName);
        await page.locator("tr", { hasText: tName }).first().getByRole("link", { name: /Finish your attempt|Continue/i }).first().click();
        await page.waitForURL(/\/student\/tests\/[^/]+(\/take)?$/, { timeout: 30000 }).catch(() => {});
        if (!/\/take/.test(page.url())) {
          const resume = page.getByRole("button", { name: /Resume Test/ });
          await resume.click({ timeout: 20000 }).catch(() => problems.push(`the exam page didn't offer Resume (${page.url().replace(BASE, "")})`));
          await page.waitForURL(/\/take/, { timeout: 45000, waitUntil: "commit" }).catch(() => {});
        }
      } else {
        await page.goto(`${BASE}/student/tests/${T}/take`, { waitUntil: "networkidle" });
      }
      const opened = await waitTake(page).then(() => true, () => false);
      if (!opened) throw new Error(`078 could not reopen the exam after removal (${page.url().replace(BASE, "")}) — ${problems.join("; ") || "no take page"}`);
      await jumpTo(page, 1);
      const picked = await isPicked(page, "A");
      if (!picked) problems.push("after reopening, Q1 no longer shows the answer A saved before the removal");
      await jumpTo(page, 3); await choice(page, "C").click();
      const r3 = await waitRow(m1.id, (r) => r.answers?.[qs1[2].id] === "C", 20000);
      if (r3?.answers?.[qs1[2].id] !== "C") problems.push("after removal, a new answer (Q3=C) didn't save");
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      const toM2 = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true, () => false);
      const f1 = await waitRow(m1.id, (r) => r.status !== "In Progress", 20000);
      if (f1?.status !== "Submitted") problems.push(`Module 1 ended ${f1?.status} after removal`);
      const kept = ["A", "B", "C"].filter((l, i) => f1?.answers?.[qs1[i].id] === l).length;
      if (kept !== 3) problems.push(`only ${kept}/3 Module 1 answers kept (Q1=A, Q2=B before removal, Q3=C after)`);
      if (!toM2) problems.push(`submitting Module 1 after removal didn't reach the Module 2 screen (${page.url().replace(BASE, "")})`);
      else {
        await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 });
        const m2open = await waitTake(page).then(() => true, () => false);
        if (!m2open) problems.push(`Start Module 2 after removal didn't open Module 2 (${page.url().replace(BASE, "")})`);
        else {
          await onQuestion(page, 1); await choice(page, "D").click();
          await goToSubmitModal(page, await totalOf(page));
          await page.getByRole("button", { name: /Submit Test/ }).last().click();
          const res = await page.waitForURL(/\/result/, { timeout: 45000 }).then(() => true, () => false);
          if (!res) problems.push("Module 2 submit after removal did not open the result page");
          else {
            const body = await page.locator("body").innerText().catch(() => "");
            if (/404|not found|could not be found/i.test(body.slice(0, 400))) problems.push("the result page after finishing shows Not Found");
          }
        }
      }
      const rowsA = await subs(A.id, T);
      const m2A = rowsA.filter((r) => String(r.adaptive_track).startsWith("module_2"));
      if (m2A.length !== 1 || m2A[0].status !== "Submitted" || !Object.values(m2A[0].answers ?? {}).includes("D"))
        problems.push(`Module 2 after removal: ${m2A.map((r) => `${r.status}/${Object.keys(r.answers ?? {}).length} answers`).join(", ") || "none"} (expected one Submitted with D)`);
      notes.push(`078 resumed (Q1=A shown: ${picked}), M1 ${f1?.status} ${kept}/3 kept, M2 ${m2A.map((r) => r.status).join(",") || "none"}`);
      // Finished: no new attempt, no Start on My Tests.
      const again = await x.context.request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const againJ = await again.json().catch(() => ({}));
      if (again.status() < 400 && againJ.data?.id && !rowsA.some((r) => r.id === againJ.data.id)) problems.push(`after finishing, the removed student could start a new attempt (${again.status()})`);
      const lA2 = await myTestsAction(page, tName);
      if (lA2.listed && /Start|Finish your attempt/i.test(lA2.actions)) problems.push(`after finishing, My Tests still offers "${lA2.actions}"`);
      notes.push(`after finishing: new attempt → ${again.status()}, My Tests ${lA2.listed ? `"${lA2.actions}"` : "not listed"}`);
      await x.context.close();
      await borrowLogin(orig, STUDENT1_CLERK);

      // ── B: 073 Module 1 graded, Module 2 never created, then removed ──
      x = await borrowAs(b, 73);
      page = x.page;
      const R = x.context.request;
      const st = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const bM1 = (await st.json().catch(() => ({}))).data?.id;
      if (!bM1) throw new Error(`setup: 073 start ${st.status()}`);
      const bQs = await moduleQs((await db.from("submissions").select("module_id").eq("id", bM1).single()).data.module_id);
      await R.patch(`${BASE}/api/student/submissions/${bM1}`, { data: { answers: { [bQs[0].id]: "B" }, metadata: {} } });
      const sb = await R.post(`${BASE}/api/student/submissions/${bM1}/submit`, { data: { answers: { [bQs[0].id]: "B" }, metadata: {} } });
      if (sb.status() >= 400) throw new Error(`setup: 073 M1 submit ${sb.status()}`);
      await sleep(1500);
      const pre = (await subs(B.id, T)).filter((r) => r.id !== bM1);
      for (const r of pre) { await db.from("answer_records").delete().eq("submission_id", r.id); await db.from("submissions").delete().eq("id", r.id); }
      if ((await subs(B.id, T)).length !== 1) throw new Error("setup: couldn't simulate the failed Module 2 handoff");
      await removeFromClass(B, cgB[0]);
      const lB = await myTestsAction(page, tName);
      notes.push(`073 (M1 graded, no M2) removed: My Tests ${lB.listed ? `"${lB.actions}"` : "NOT listed"}`);
      if (!lB.listed) problems.push("a removed student whose Module 2 handoff failed can't find the exam on My Tests");
      const tp = await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
      const cont = page.getByRole("button", { name: /Continue to Module 2/ }).first();
      const hasCont = await cont.waitFor({ timeout: 20000 }).then(() => true, () => false);
      if (!hasCont) problems.push(`the exam page (HTTP ${tp?.status()}) doesn't offer "Continue to Module 2" to the removed student`);
      else {
        await cont.click();
        await page.getByText("Module 1 submitted").first().waitFor({ timeout: 30000 }).catch(() => {});
        await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 }).catch(() => {});
        const ok = await waitTake(page).then(() => true, () => false);
        if (!ok) problems.push(`"Continue to Module 2" didn't open Module 2 for the removed student (${page.url().replace(BASE, "")})`);
        else {
          await onQuestion(page, 1); await choice(page, "C").click();
          await goToSubmitModal(page, await totalOf(page));
          await page.getByRole("button", { name: /Submit Test/ }).last().click();
          await page.waitForURL(/\/result/, { timeout: 45000 }).catch(() => problems.push("073's Module 2 submit did not open the result page"));
        }
      }
      const rowsB = await subs(B.id, T);
      const m2B = rowsB.filter((r) => String(r.adaptive_track).startsWith("module_2"));
      if (m2B.length !== 1 || m2B[0].status !== "Submitted" || !Object.values(m2B[0].answers ?? {}).includes("C"))
        problems.push(`073's Module 2: ${m2B.map((r) => `${r.status}/${Object.keys(r.answers ?? {}).length} answers`).join(", ") || "none"} (expected one Submitted with C)`);
      notes.push(`073 M2 ${m2B.map((r) => r.status).join(",") || "none"}`);
      await x.context.close();
    } finally {
      await restore().catch(() => {});
      await admin?.context.close().catch(() => {});
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await clean();
    }
    const back = [(await memOf(A)).length === memA.length, (await memOf(B)).length === memB.length];
    if (back.includes(false)) problems.push("CLEANUP: class membership was not restored");
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 4 * 60 * 1000);

  // ── D-20261108-2 ─────────────────────────────────────────
  // Today's 6fcf7e0 added printable student results (/print/results/<test>,
  // a PDF route, a CSV summary) plus a sign-in bypass for a signed "pt"
  // ticket. The printout must follow the same rules as the result page:
  // a student prints only their own finished attempt, never another
  // student's; nothing while the exam (or a retake) is running, nor the
  // Module 2 they're taking; nothing once the admin set "Hide"; a teacher
  // only their own classes; a missing / forged / foreign ticket opens nothing.
  await check("D-20261108-2", [], "新的「列印成績」功能：學生只能印自己考完的成績，印不到別的同學的；考試中、重考中、管理員設定隱藏答案時都印不出答案；老師只能印自己班的學生；沒登入或偽造的列印票一律打不開", "安全", async () => {
    const T = TESTS.mathLinear;
    const main = studentByN(77), other = studentByN(79), live = studentByN(76);
    if (!main || !other || !live) throw new Error("students 076/077/079 not found");
    const orig = C.students[0].id;
    const studs = [main, other, live];
    const t0 = (await db.from("tests").select("module_id,module_2_id,review_unlocked,show_answers_after_submission,show_explanations_after_submission,allow_retake").eq("id", T).single()).data;
    if (!t0.show_answers_after_submission || t0.show_explanations_after_submission === false || !t0.allow_retake)
      throw new Error(`setup: mathLinear flags changed (${JSON.stringify(t0)})`);
    const teacher = cast().teachers[0];
    const tClasses = ((await db.from("class_group_teachers").select("class_group_id").eq("teacher_id", teacher.id)).data ?? []).map((r) => r.class_group_id);
    const inTeacherClass = async (st) => ((await db.from("class_group_members").select("class_group_id").eq("student_id", st.id).in("class_group_id", tClasses)).data ?? []).length > 0;
    if (!teacher.clerkId || (await inTeacherClass(main)) || (await inTeacherClass(other))) throw new Error("setup: Teacher 01 has no login or teaches 077/079's class");
    const clean = async () => {
      for (const st of studs) {
        await deleteSubs(st.id, T).catch(() => {});
        await db.from("student_answer_visibility").delete().eq("test_id", T).eq("student_id", st.id);
        await db.from("student_answer_visibility_log").delete().eq("test_id", T).eq("student_id", st.id);
      }
    };
    const { data: qrows } = await db.from("questions").select("module_id,explanation,question_text").in("module_id", [t0.module_id, t0.module_2_id]).eq("parsing_status", "Approved");
    const run = (x) => String(x ?? "").match(/[A-Za-z][A-Za-z0-9 ,]{24,}/)?.[0]?.slice(0, 24);
    const uniq = (a) => [...new Set(a.filter(Boolean))];
    const expl = uniq((qrows ?? []).map((q) => run(q.explanation)));
    const stems1 = uniq((qrows ?? []).filter((q) => q.module_id === t0.module_id).map((q) => run(q.question_text)));
    const stems2 = uniq((qrows ?? []).filter((q) => q.module_id === t0.module_2_id).map((q) => run(q.question_text)));
    if (expl.length < 5 || stems1.length < 5 || stems2.length < 5) throw new Error(`only ${expl.length}/${stems1.length}/${stems2.length} snippets usable`);
    const seen = (html, list) => list.filter((x) => html.includes(x)).length;
    const scan = (html) => ({ s1: seen(html, stems1), s2: seen(html, stems2), e: seen(html, expl) });
    const leaks = (v) => v.s1 + v.s2 + v.e > 0;
    const fmt = (v, st) => `${st ? `HTTP ${st}, ` : ""}${v.s1} M1 + ${v.s2} M2 questions, ${v.e} explanations`;
    const PR = (q = "") => `${BASE}/print/results/${T}?expl=1${q}`;
    const problems = [], notes = [];
    await clean();
    const b = await chromium.launch();
    let admin, tch;
    try {
      admin = await login(b, ADMIN_CLERK);
      const setMode = async (st, mode) => {
        const r = await admin.context.request.post(`${BASE}/api/teacher/tests/${T}/student-answer-visibility`, { data: { studentId: st.id, mode, showExplanations: true } });
        if (r.status() !== 200) throw new Error(`setup: admin set ${mode} → ${r.status()}`);
      };
      const get = async (R, url) => { const r = await R.get(url, { maxRedirects: 0 }).catch(() => null); const html = r ? await r.text().catch(() => "") : ""; return { st: r?.status() ?? 0, v: scan(html), html }; };

      // 079 and 077 each finish an attempt.
      let x = await borrowAs(b, 79);
      const aO = await apiTakeTest(x.context.request, other.id, T);
      await x.context.close();
      x = await borrowAs(b, 77);
      let R = x.context.request;
      const a1 = await apiTakeTest(R, main.id, T);
      if (!a1.m2Id) throw new Error("setup: no Module 2");
      // Control: 077 prints their own result → the scan must see it.
      const own = await get(R, PR());
      if (!(own.st === 200 && own.v.s1 > 0 && own.v.s2 > 0 && own.v.e > 0)) throw new Error(`setup: 077 can't print their own result (${fmt(own.v, own.st)}) — scan not valid`);
      notes.push(`own printout: ${fmt(own.v, own.st)}`);
      // Another student's attempt (alone, or mixed with own).
      for (const [label, q] of [["other's id", `&subs=${aO.m1Id}`], ["other's M2 id", `&subs=${aO.m2Id}`], ["own+other ids", `&subs=${a1.m1Id},${aO.m1Id}`]]) {
        const g = await get(R, PR(q));
        const otherName = (await db.from("users").select("display_name").eq("id", other.id).single()).data?.display_name;
        const named = otherName && otherName.length > 3 && g.html.includes(otherName);
        if (g.st === 200 && (leaks(g.v) || named)) problems.push(`student printing with ${label} got another student's result (${fmt(g.v, g.st)}${named ? ", their name" : ""})`);
        notes.push(`${label}: ${g.st}`);
      }
      const pdf = await R.get(`${BASE}/api/print/results/${T}/pdf?sub=${aO.m1Id}`);
      if (pdf.status() < 400 || /pdf/i.test(pdf.headers()["content-type"] ?? "")) problems.push(`the PDF download of another student's result answered ${pdf.status()} ${pdf.headers()["content-type"]}`);
      for (const api of ["students", "summary"]) {
        const r = await R.get(`${BASE}/api/print/results/${T}/${api}`);
        const t = await r.text();
        if (r.status() < 400 || t.includes(other.id)) problems.push(`student calling the ${api} list got ${r.status()}${t.includes(other.id) ? " with another student in it" : ""}`);
      }
      // Admin set Hide → nothing printable.
      await setMode(main, "hide");
      const hid = await get(R, PR());
      if (leaks(hid.v)) problems.push(`admin set Hide, the printout still shows ${fmt(hid.v, hid.st)}`);
      notes.push(`hide: ${fmt(hid.v, hid.st)}`);
      await setMode(main, "follow");
      // Retake running → the first attempt's printout shows no answers.
      const st2 = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const rt = (await st2.json().catch(() => ({}))).data?.id;
      const rtRow = rt && (await db.from("submissions").select("attempt_number").eq("id", rt).single()).data;
      if (!rtRow || rtRow.attempt_number !== 2) throw new Error(`setup: retake start ${st2.status()}`);
      for (const [label, q] of [["retake running", ""], ["retake running, old id", `&subs=${a1.m1Id}`], ["retake running, new id", `&subs=${rt}`]]) {
        const g = await get(R, PR(q));
        if (leaks(g.v)) problems.push(`${label}: the printout shows the answer key of the exam being retaken (${fmt(g.v, g.st)})`);
        notes.push(`${label}: ${fmt(g.v, g.st)}`);
      }
      await x.context.close();

      // 076 taking the exam for the first time: Module 1, then Module 2.
      x = await borrowAs(b, 76);
      R = x.context.request;
      const st3 = await R.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
      const lm1 = (await st3.json().catch(() => ({}))).data?.id;
      if (!lm1) throw new Error(`setup: 076 start ${st3.status()}`);
      for (const q of ["", `&subs=${lm1}`]) {
        const g = await get(R, PR(q));
        if (leaks(g.v)) problems.push(`a student in the middle of Module 1 prints ${fmt(g.v, g.st)}${q ? " (own in-progress id)" : ""}`);
      }
      const sb = await R.post(`${BASE}/api/student/submissions/${lm1}/submit`, { data: { answers: {}, metadata: {} } });
      const lm2 = (await sb.json().catch(() => ({}))).data?.nextSubmissionId;
      if (!lm2) throw new Error(`setup: 076 M1 submit ${sb.status()} gave no Module 2`);
      for (const q of ["", `&subs=${lm2}`]) {
        const g = await get(R, PR(q));
        if (g.v.s2 > 0) problems.push(`a student in the middle of Module 2 prints Module 2's questions with answers (${fmt(g.v, g.st)})`);
        notes.push(`mid-Module 2${q ? " (M2 id)" : ""}: ${fmt(g.v, g.st)}`);
      }
      await x.context.close();

      // Teacher 01 (Class A only) → 077/079 are not theirs.
      tch = await login(b, teacher.clerkId);
      const TR = tch.context.request;
      const tg = await get(TR, PR(`&subs=${a1.m1Id}`));
      if (tg.st === 200 && leaks(tg.v)) problems.push(`a teacher printed a student outside their classes (${fmt(tg.v, tg.st)})`);
      const tl = await TR.get(`${BASE}/api/print/results/${T}/students`);
      const tlT = await tl.text();
      if (tlT.includes(main.id) || tlT.includes(other.id)) problems.push("the teacher's printable-students list includes students outside their classes");
      const ts = await TR.get(`${BASE}/api/print/results/${T}/summary?subs=${a1.m1Id},${aO.m1Id}`);
      const tsT = await ts.text();
      if (ts.status() < 400 && /\d+\/\d+/.test(tsT)) problems.push(`the teacher's score CSV for students outside their classes answered ${ts.status()} with scores`);
      const tAll = await get(TR, PR());
      if (seen(tAll.html, [main.id, other.id]) || tAll.html.includes(a1.m1Id) || tAll.html.includes(aO.m1Id)) problems.push("the teacher's 'print all' includes students outside their classes");
      notes.push(`teacher: subs ${tg.st}, list ${tl.status()}, csv ${ts.status()}`);

      // Signed out: no ticket, junk, forged, other test's id.
      const adminId = cast().admins[0].id;
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const forgedBody = b64({ viewer: { userId: adminId, role: "admin", isQa: true }, testId: T, subs: [aO.m1Id], opts: { mode: "full", explanations: true, explanationsAt: "inline" }, exp: Date.now() + 3600e3 });
      const tickets = { none: null, junk: "x", dot: ".", "body-only": `${forgedBody}.`, forged: `${forgedBody}.${"A".repeat(43)}`, "forged-long": `${forgedBody}.${"A".repeat(86)}` };
      const outRes = [];
      for (const [label, pt] of Object.entries(tickets)) {
        const url = pt == null ? PR(`&subs=${aO.m1Id}`) : `${BASE}/print/results/${T}?pt=${encodeURIComponent(pt)}`;
        const r = await fetch(url, { redirect: "manual" });
        const html = await r.text().catch(() => "");
        const v = scan(html);
        outRes.push(`${label} ${r.status}`);
        if (leaks(v) || (r.status === 200 && html.includes(aO.m1Id))) problems.push(`signed out with ${label} ticket: ${fmt(v, r.status)}`);
      }
      const pdfOut = await fetch(`${BASE}/api/print/results/${T}/pdf?sub=${aO.m1Id}`, { redirect: "manual" });
      if (pdfOut.status !== 401) problems.push(`signed-out PDF download answered ${pdfOut.status}`);
      notes.push(`signed out: ${outRes.join(", ")}, pdf ${pdfOut.status}`);
    } finally {
      await tch?.context.close().catch(() => {});
      await admin?.context.close().catch(() => {});
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await clean();
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 3 * 60 * 1000);

  // ── D-20261109-1 ─────────────────────────────────────────
  // Browser storage refuses every write: Safari private browsing on older
  // iPads, a device whose site storage is full, or a school-managed browser.
  // The take page keeps its device backup in localStorage (and Desmos and
  // other widgets may use it). Every setItem throws QuotaExceededError,
  // installed after sign-in. The exam must still open, save answers and
  // marks to the server (also after an offline moment), show them again
  // after a reload, use Desmos, and go Module 1 → Module 2 → result page.
  // Students 074, mathLinear.
  await check("D-20261109-1", [], "瀏覽器不能存任何資料（Safari 私密瀏覽、儲存空間滿了）時考數學：考卷打得開、答案和標記存得進去、斷網再連上也會補存、重新整理後還在、能用 Desmos、能交卷進第二模組再到成績頁", "裝置/瀏覽器", () =>
    asStudent(74, TESTS.mathLinear, async ({ s, page, context }) => {
      const T = TESTS.mathLinear;
      const notes = [], problems = [], pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e).slice(0, 160)));
      await context.addInitScript(() => {
        window.__qaStorageRefusals = 0;
        Storage.prototype.setItem = function () {
          window.__qaStorageRefusals++;
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
      });
      await startTestBrowser(page, T);
      // Control: storage really refuses writes on this page.
      const probe = await page.evaluate(() => { try { localStorage.setItem("qa-probe", "1"); return "stored"; } catch (e) { return e.name; } });
      if (probe !== "QuotaExceededError") throw new Error(`setup: storage still writable (${probe})`);
      const m1 = (await subs(s.id, T)).find((r) => r.adaptive_track === "module_1");
      if (!m1) throw new Error("setup: no Module 1 row");
      const qs = await moduleQs(m1.module_id);
      const mc = qs.map((q, i) => ({ q, n: i + 1 })).filter((x) => x.q.question_type === "Multiple Choice").slice(0, 3);
      if (mc.length < 3) throw new Error("setup: fewer than 3 multiple-choice questions");
      const [a, bq, c] = mc;
      const picked = async (l) => (await choice(page, l).getAttribute("aria-checked").catch(() => null)) === "true";
      const flagBtn = () => page.getByRole("button", { name: /Mark(ed)? for Review/ }).first();

      await jumpTo(page, a.n); await choice(page, "A").click();
      await jumpTo(page, bq.n); await choice(page, "B").click();
      await flagBtn().click();
      let row = await waitRow(m1.id, (r) => r.answers?.[a.q.id] === "A" && r.answers?.[bq.q.id] === "B" && (r.metadata?.flagged ?? []).includes(bq.q.id), 25000);
      if (row?.answers?.[a.q.id] !== "A" || row?.answers?.[bq.q.id] !== "B") problems.push(`answers didn't reach the server: ${JSON.stringify(row?.answers ?? {})}`);
      if (!(row?.metadata?.flagged ?? []).includes(bq.q.id)) problems.push(`Q${bq.n} mark for review didn't reach the server`);

      // Offline moment: pick while offline, come back online.
      await context.setOffline(true);
      await jumpTo(page, c.n); await choice(page, "C").click();
      await sleep(2500);
      await context.setOffline(false);
      row = await waitRow(m1.id, (r) => r.answers?.[c.q.id] === "C", 40000);
      if (row?.answers?.[c.q.id] !== "C") problems.push(`Q${c.n}=C picked while offline never reached the server after reconnecting (40 s)`);
      const refusals = await page.evaluate(() => window.__qaStorageRefusals);
      notes.push(`storage writes refused: ${refusals}`);

      // Desmos with no storage.
      await page.locator('button[title="Desmos calculator"]').click();
      const desmosOk = await page.locator('iframe[title="Desmos calculator"]').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      if (!desmosOk) problems.push("Desmos calculator didn't open");
      else {
        await sleep(5000);
        const frame = page.frames().find((f) => f.url().includes("desmos"));
        const n = await frame?.evaluate(() => { window.Calc?.setExpression({ id: "qa", latex: "y=x^2" }); return window.Calc?.getExpressions?.().length ?? 0; }).catch(() => 0);
        if (!n) problems.push("Desmos opened but couldn't draw a graph");
        await page.locator('button[title="Desmos calculator"]').click().catch(() => {});
      }

      // Reload: answers and mark come back from the server.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitTake(page);
      await jumpTo(page, a.n); if (!(await picked("A"))) problems.push(`after reload Q${a.n} no longer shows A`);
      await jumpTo(page, bq.n); if (!(await picked("B"))) problems.push(`after reload Q${bq.n} no longer shows B`);
      if ((await flagBtn().getAttribute("aria-pressed").catch(() => null)) !== "true") problems.push(`after reload Q${bq.n} is no longer marked for review`);
      await jumpTo(page, c.n); if (!(await picked("C"))) problems.push(`after reload Q${c.n} no longer shows C`);

      // Module 1 → Module 2 → result.
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      const m2Open = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
      if (!m2Open) fail(`${problems.concat("Module 1 submit did not reach the Module 2 screen within 45 s").join("; ")}. page errors: ${pageErrors.join(" | ") || "none"}`);
      await page.locator('a:has-text("Start Module 2")').click();
      await waitTake(page);
      await onQuestion(page, 1);
      const m2Mc = await choice(page, "D").isVisible().catch(() => false);
      if (m2Mc) await choice(page, "D").click();
      await goToSubmitModal(page, await totalOf(page));
      await page.getByRole("button", { name: /Submit Test/ }).last().click();
      const res = await page.waitForURL(/\/result/, { timeout: 45000 }).then(() => true).catch(() => false);
      if (!res) problems.push("Module 2 submit did not open the result page within 45 s");
      else {
        const body = await page.locator("body").innerText().catch(() => "");
        if (/something went wrong|application error/i.test(body)) problems.push("result page shows an error");
      }

      const rows = await subs(s.id, T);
      const r1 = rows.find((r) => r.adaptive_track === "module_1"), r2 = rows.find((r) => r.adaptive_track !== "module_1");
      if (!r1 || r1.status !== "Submitted") problems.push(`Module 1 status ${r1?.status}`);
      else {
        const got = [a.q.id, bq.q.id, c.q.id].map((id) => r1.answers?.[id] ?? "-").join("");
        if (got !== "ABC") problems.push(`graded Module 1 answers ${got}, expected ABC`);
      }
      if (!r2 || r2.status !== "Submitted") problems.push(`Module 2 status ${r2?.status}`);
      else if (m2Mc) {
        const q1 = (await moduleQs(r2.module_id))[0];
        if (r2.answers?.[q1.id] !== "D") problems.push(`Module 2 Q1=D not graded (${r2.answers?.[q1.id]})`);
      }
      const storageErrs = pageErrors.filter((e) => /quota|storage|setItem/i.test(e));
      if (storageErrs.length) problems.push(`uncaught storage errors on the page: ${storageErrs.join(" | ")}`);
      if (refusals < 1) problems.push("setup: the page never tried to write storage, so the situation wasn't exercised");
      notes.push(`Q${a.n}/Q${bq.n}/Q${c.n} = A/B/C; M1 ${r1?.status} ${r1?.correct_count}/${r1?.total_questions}; M2 ${r2?.status}`);
      if (pageErrors.length) notes.push(`other page errors: ${pageErrors.slice(0, 3).join(" | ")}`);
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261109-2 ─────────────────────────────────────────
  // Figures and tables as the student really sees them. BANK-IMG opens each
  // image straight from Vercel Blob with the server token; students get them
  // through /api/blob-image (host allow-list, two-store token fallback, see
  // c4f8f69 / 3c5d5c9) and fc2b591 moved figures next to the passage.
  // (a) Every image of every Approved question in a module used by any test
  //     (stem figures and image choices) must load and decode through the
  //     student's proxy, signed in as a student.
  // (b) On the take page of mathLinear M1 and engLinear M1, on a laptop
  //     (1366×768) and an iPad held upright (810×1080), every figure
  //     question shows its picture (loaded, ≥ 60 px wide, not cut off at the
  //     right edge) and every table question shows a real table with the
  //     header cells from the question, no raw "|---|" and no raw "$\frac".
  // Student 077. Read-only apart from its own QA submissions.
  await check("D-20261109-2", [], "考試畫面上的圖和表：題庫裡每一張學生會用到的題目圖片都要透過學生的帳號載得出來；在筆電和直拿的 iPad 上，有圖的題目要看得到完整的圖、有表格的題目要顯示成真正的表格（不能出現 |---| 或 $\\frac 這種原始符號）", "題目內容", () =>
    asStudent(77, [TESTS.mathLinear, TESTS.engLinear], async ({ s, page }) => {
      const notes = [], problems = [];
      async function allRows(table, sel, f) {
        let out = [];
        for (let i = 0; ; i += 1000) {
          let q = db.from(table).select(sel).range(i, i + 999);
          if (f) q = f(q);
          const { data, error } = await q;
          if (error) throw new Error(error.message);
          out = out.concat(data);
          if (data.length < 1000) break;
        }
        return out;
      }
      // (a) bank-wide through the student proxy.
      const tests = await allRows("tests", "module_id,module_2_id,module_1_id,module_2_easy_id,module_2_hard_id");
      const mods = new Set(tests.flatMap((t) => [t.module_id, t.module_2_id, t.module_1_id, t.module_2_easy_id, t.module_2_hard_id]).filter(Boolean));
      const modNames = new Map((await allRows("modules", "id,module_name")).map((m) => [m.id, m.module_name]));
      const qs = (await allRows("questions", "id,module_id,original_question_number,image_urls,choices", (q) => q.eq("parsing_status", "Approved")))
        .filter((q) => mods.has(q.module_id));
      const jobs = [];
      for (const q of qs) {
        const where = `${modNames.get(q.module_id) ?? q.module_id} Q${q.original_question_number}`;
        for (const u of q.image_urls ?? []) if (u) jobs.push({ where, u });
        for (const c of q.choices ?? []) if (c?.image_url) jobs.push({ where: `${where} choice ${c.label}`, u: c.image_url });
      }
      if (jobs.length < 20) throw new Error(`setup: only ${jobs.length} images found`);
      await page.goto(`${BASE}/student`, { waitUntil: "domcontentloaded" });
      const bad = await page.evaluate(async (jobs) => {
        const out = [];
        const load = (j) => new Promise((res) => {
          const img = new Image();
          const t = setTimeout(() => res(`${j.where}: timed out`), 30000);
          img.onload = () => { clearTimeout(t); res(img.naturalWidth > 0 && img.naturalHeight > 0 ? null : `${j.where}: decoded to 0×0`); };
          img.onerror = async () => {
            clearTimeout(t);
            const r = await fetch(`/api/blob-image?u=${encodeURIComponent(j.u)}`).catch(() => null);
            res(`${j.where}: doesn't load (HTTP ${r?.status ?? "?"} ${(r?.headers.get("content-type") ?? "").slice(0, 30)})`);
          };
          img.src = `/api/blob-image?u=${encodeURIComponent(j.u)}`;
        });
        for (let i = 0; i < jobs.length; i += 6) out.push(...(await Promise.all(jobs.slice(i, i + 6).map(load))));
        return out.filter(Boolean);
      }, jobs);
      if (bad.length) problems.push(`${bad.length} of ${jobs.length} question images don't load for a student: ${bad.slice(0, 6).join("; ")}`);
      notes.push(`proxy: ${jobs.length - bad.length}/${jobs.length} images load`);

      // (b) take pages.
      const VIEWS = [{ tag: "laptop", w: 1366, h: 768 }, { tag: "iPad", w: 810, h: 1080 }];
      let figures = 0, tables = 0;
      for (const key of ["mathLinear", "engLinear"]) {
        const T = TESTS[key];
        await page.setViewportSize({ width: 1366, height: 768 });
        await startTestBrowser(page, T);
        const m1 = (await subs(s.id, T)).find((r) => r.adaptive_track === "module_1");
        const { data: mq } = await db.from("questions").select("id,original_question_number,question_text,has_image,has_table,image_urls,choices")
          .eq("module_id", m1.module_id).eq("parsing_status", "Approved").order("original_question_number");
        const targets = mq.map((q, i) => ({ q, n: i + 1 })).filter(({ q }) => q.image_urls?.length || q.choices?.some((c) => c?.image_url) || /\n\s*\|.*\|/.test(q.question_text ?? ""));
        if (!targets.length) throw new Error(`setup: ${key} M1 has no figure/table questions`);
        for (const v of VIEWS) {
          await page.setViewportSize({ width: v.w, height: v.h });
          for (const { q, n } of targets) {
            await jumpTo(page, n);
            await sleep(400);
            const where = `${key} Q${n} (${v.tag})`;
            const nImgs = (q.image_urls?.length ?? 0) + (q.choices ?? []).filter((c) => c?.image_url).length;
            if (nImgs) {
              figures++;
              const imgs = page.locator('img[src*="/api/blob-image"]');
              await page.waitForFunction(() => [...document.querySelectorAll('img[src*="/api/blob-image"]')].every((i) => i.complete), null, { timeout: 30000 }).catch(() => {});
              const info = await imgs.evaluateAll((els) => els.map((i) => {
                const r = i.getBoundingClientRect();
                return { ok: i.complete && i.naturalWidth > 0, w: Math.round(r.width), right: Math.round(r.right), vis: getComputedStyle(i).visibility !== "hidden" && r.height > 0 };
              }));
              if (info.length < nImgs) problems.push(`${where}: ${info.length} of ${nImgs} pictures on the page`);
              info.forEach((i, k) => {
                if (!i.ok) problems.push(`${where}: picture ${k + 1} didn't load`);
                else if (!i.vis || i.w < 60) problems.push(`${where}: picture ${k + 1} only ${i.w} px wide`);
                else if (i.right > v.w + 1) problems.push(`${where}: picture ${k + 1} cut off at the right (${i.right} px > ${v.w})`);
              });
            }
            const md = (q.question_text ?? "").split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l));
            if (md.length >= 2) {
              tables++;
              const header = md[0].split("|").map((x) => x.trim()).filter(Boolean).filter((x) => !/[$\\]/.test(x)).slice(0, 3);
              const t = await page.evaluate(() => {
                const ts = [...document.querySelectorAll("main table, table")].filter((x) => !x.querySelector("caption"));
                const body = document.body.innerText;
                return {
                  tables: ts.map((x) => {
                    const r = x.getBoundingClientRect();
                    let p = x.parentElement, scrolls = false;
                    while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if ((o === "auto" || o === "scroll") && p.getBoundingClientRect().right <= innerWidth + 1) { scrolls = true; break; } p = p.parentElement; }
                    return { text: x.innerText, rows: x.querySelectorAll("tr").length, right: Math.round(r.right), scrolls };
                  }),
                  raw: /\|\s*-{3,}\s*\|/.test(body), rawTex: /\$\\frac|\\frac\{/.test(body),
                };
              });
              const hit = t.tables.find((x) => header.every((h) => x.text.includes(h)));
              if (!hit) problems.push(`${where}: no table with the header ${JSON.stringify(header)} on the page`);
              else {
                if (hit.rows < md.length - 1) problems.push(`${where}: table has ${hit.rows} rows, question has ${md.length - 1}`);
                if (hit.right > v.w + 1 && !hit.scrolls) problems.push(`${where}: table cut off at the right (${hit.right} px > ${v.w}) and can't be scrolled`);
              }
              if (t.raw) problems.push(`${where}: raw "|---|" table text shown`);
              if (t.rawTex) problems.push(`${where}: raw "\\frac" shown`);
            }
          }
        }
      }
      notes.push(`take pages: ${figures} figure and ${tables} table views checked on laptop + iPad`);
      if (problems.length) fail(`${problems.slice(0, 12).join("; ")}${problems.length > 12 ? ` (+${problems.length - 12} more)` : ""}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261109-3 ─────────────────────────────────────────
  // Teacher "Teaching mode" quick test. Teaching mode suggests questions for
  // one skill from the whole bank (skill-questions), so a teacher naturally
  // picks questions that come from several different tests. The teacher
  // builds the quick test through the real API, the admin publishes it and
  // assigns student 080, and the student opens it. Every picked question must
  // be on the exam ("Question 1 of 4"), and answering all 4 correctly must
  // grade 4/4. Teacher 01 (Math), skill picked at run time; the quick test is
  // deleted in finally.
  await check("D-20261109-3", [], "老師在「教學模式」用同一個技能挑了 4 題（來自不同的考卷）做成小考、指派給學生：學生打開小考要看到全部 4 題，4 題都答對要算 4/4", "老師/管理員動作", async () => {
    const s = studentByN(80);
    if (!s) throw new Error("student 080 not found");
    const T1 = C.teachers[0];
    const orig = C.students[0].id;
    const NAME = `TEST qa-teacher QT D-20261109-3 ${Date.now()}`;
    const notes = [], problems = [];
    let qtId = null;
    const b = await chromium.launch();
    try {
      const pub = (await db.from("tests").select("module_id,module_2_id").eq("status", "Published")).data ?? [];
      const liveMods = new Set(pub.flatMap((t) => [t.module_id, t.module_2_id]).filter(Boolean));
      const tch = await login(b, T1.clerkId);
      let pick = null, skillUsed = null;
      for (const skill of ["Linear equations in one variable", "Linear equations in two variables", "Equivalent expressions", "Quadratic equations"]) {
        const r = await tch.context.request.get(`${BASE}/api/teacher/teaching-mode/skill-questions?skill=${encodeURIComponent(skill)}&limit=30`);
        const list = (await r.json().catch(() => ({}))).questions ?? [];
        if (!list.length) continue;
        const { data: rows } = await db.from("questions").select("id,module_id,question_type,correct_answer,parsing_status,has_image,has_table,choices")
          .in("id", list.map((q) => q.questionId));
        const ok = (rows ?? []).filter((q) => q.parsing_status === "Approved" && q.question_type === "Multiple Choice" && !q.has_image && !q.has_table
          && liveMods.has(q.module_id) && /^[A-D]$/.test(String(q.correct_answer ?? "").trim()));
        const byMod = new Map();
        for (const q of ok) byMod.set(q.module_id, [...(byMod.get(q.module_id) ?? []), q]);
        const two = [...byMod.values()].filter((v) => v.length >= 2).slice(0, 2);
        if (two.length === 2) { pick = [...two[0].slice(0, 2), ...two[1].slice(0, 2)]; skillUsed = skill; break; }
      }
      if (!pick) throw new Error("setup: no skill offered 2+2 usable questions from two different tests");
      const create = await tch.context.request.post(`${BASE}/api/teacher/teaching-mode/quick-test`, { data: { name: NAME, questionIds: pick.map((q) => q.id) } });
      qtId = (await create.json().catch(() => ({}))).data?.id ?? null;
      if (!qtId) throw new Error(`setup: quick test not created (${create.status()})`);
      await tch.context.close();
      notes.push(`skill "${skillUsed}", 4 questions from 2 tests`);

      const adm = await login(b, ADMIN_CLERK);
      const p = await adm.context.request.patch(`${BASE}/api/admin/tests/${qtId}`, { data: { status: "Published", studentIds: [s.id] } });
      if (!p.ok()) throw new Error(`setup: admin publish/assign answered ${p.status()} ${(await p.text()).slice(0, 120)}`);
      await adm.context.close();

      await deleteSubs(s.id, qtId);
      const st = await borrowAs(b, 80);
      await startTestBrowser(st.page, qtId);
      const shown = await totalOf(st.page);
      notes.push(`student sees ${shown} question(s)`);
      if (shown !== 4) problems.push(`the teacher picked 4 questions but the student's exam shows only ${shown}`);
      const row = (await subs(s.id, qtId))[0];
      if (!row) throw new Error("setup: no submission row");
      const answers = Object.fromEntries(pick.map((q) => [q.id, String(q.correct_answer).trim()]));
      const sv = await st.context.request.patch(`${BASE}/api/student/submissions/${row.id}`, { data: { answers, answersMode: "merge", metadata: {} } });
      if (!sv.ok()) problems.push(`saving the 4 answers answered ${sv.status()}`);
      const sub = await st.context.request.post(`${BASE}/api/student/submissions/${row.id}/submit`, { data: {} });
      if (!sub.ok()) problems.push(`submit answered ${sub.status()}`);
      const done = await waitRow(row.id, (r) => r.status !== "In Progress", 20000);
      notes.push(`graded ${done?.correct_count}/${done?.total_questions} (${done?.status})`);
      if (done?.total_questions !== 4 || done?.correct_count !== 4)
        problems.push(`all 4 answered correctly but graded ${done?.correct_count}/${done?.total_questions}`);
      await st.context.close();
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      const left = (await db.from("tests").select("id").eq("test_name", NAME)).data ?? [];
      for (const id of new Set([qtId, ...left.map((t) => t.id)].filter(Boolean))) {
        await deleteSubs(s.id, id).catch(() => {});
        await db.from("test_assignments").delete().eq("test_id", id);
        await db.from("tests").delete().eq("id", id);
      }
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 3 * 60 * 1000);

  // ── D-20261110-1 ─────────────────────────────────────────
  // Exam day: the teacher sets the test to open at the start of class and
  // the students sit on the test page waiting. Before the open time nothing
  // may start; once it passes, the page must offer Start Test by itself
  // (students don't know to reload), and starting must work.
  await check("D-20261110-1", [], "學生在測驗開放前就打開測驗頁面等待：開放前不能開始考試；開放時間一到，頁面不用重新整理就要出現「開始考試」，按下去能正常考", "考試流程", () =>
    asStudent(72, TESTS.untimedEng, async ({ s, page }) => {
      const T = TESTS.untimedEng;
      const orig = (await db.from("tests").select("open_date,due_date").eq("id", T).single()).data;
      const problems = [], notes = [];
      const openAt = new Date(Date.now() + 40000);
      openAt.setUTCSeconds(openAt.getUTCSeconds(), 0);
      try {
        const up = await db.from("tests").update({ open_date: openAt.toISOString() }).eq("id", T);
        if (up.error) throw new Error(`setup: couldn't set open_date: ${up.error.message}`);
        // Before the open time: the waiting page.
        await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
        const waiting = await page.getByText(/This test opens on/).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
        const body0 = await page.locator("main").first().innerText().catch(() => "");
        const nyTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true }).format(openAt);
        if (!waiting) problems.push(`before the open time the test page doesn't say when it opens ("${body0.replace(/\s+/g, " ").slice(0, 120)}")`);
        else if (!body0.includes(nyTime)) problems.push(`the page says it opens at a different time than set (expected ${nyTime} New York time): "${(body0.match(/This test opens on[^\n]*/) ?? [""])[0]}"`);
        const startBtn = page.getByRole("button", { name: /Start Test/ });
        if (await startBtn.count()) problems.push("a Start Test button is offered before the test opens");
        const early = await page.context().request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
        if (early.status() < 400) problems.push(`starting before the open time was accepted (${early.status()})`);
        if ((await subs(s.id, T)).length) problems.push("an exam row was created before the open time");
        notes.push(`waiting page OK (${nyTime}), early start → ${early.status()}`);
        // Wait on the same page, no reload, until 30 s after the open time.
        const until = openAt.getTime() + 30000;
        let appearedAt = null;
        while (Date.now() < until) {
          if (Date.now() > openAt.getTime() && await startBtn.isVisible().catch(() => false)) { appearedAt = Date.now(); break; }
          await sleep(1000);
        }
        if (appearedAt) notes.push(`Start Test appeared by itself ${Math.round((appearedAt - openAt.getTime()) / 1000)}s after the open time`);
        else {
          const still = await page.locator("main").first().innerText().catch(() => "");
          problems.push(`30 s after the open time the page (not reloaded) still shows "${(still.match(/This test opens on[^\n]*/) ?? ["no Start Test button"])[0]}" — a waiting student has no way to start without reloading`);
          await page.reload({ waitUntil: "networkidle" });
          if (!(await startBtn.isVisible({ timeout: 15000 }).catch(() => false))) {
            await startBtn.waitFor({ timeout: 15000 }).catch(() => problems.push("even after a reload there is no Start Test button"));
          } else notes.push("after a reload Start Test is there");
        }
        // Starting after the open time must work normally.
        if (await startBtn.count()) {
          await startBtn.click({ timeout: 15000 });
          await page.waitForURL(/\/take/, { timeout: 45000, waitUntil: "commit" }).catch(() => {});
          const opened = await waitTake(page).then(() => true, () => false);
          if (!opened) problems.push(`Start Test after the open time didn't open the exam (${page.url().replace(BASE, "")})`);
          else {
            const [row] = await subs(s.id, T);
            await onQuestion(page, 1);
            await choice(page, "B").click();
            const qs = await moduleQs(row.module_id);
            const r = await waitRow(row.id, (x) => x.answers?.[qs[0].id] === "B", 20000);
            if (r?.answers?.[qs[0].id] !== "B") problems.push("after starting, the first answer didn't save");
            if (Date.parse(row.started_at) < openAt.getTime()) problems.push(`the exam's start time ${row.started_at} is before the open time`);
            notes.push("started after opening, answer saved");
          }
        }
      } finally {
        await db.from("tests").update({ open_date: orig.open_date }).eq("id", T);
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261110-2 ─────────────────────────────────────────
  // Students here mostly browse in Chinese, so Chrome offers (or
  // auto-runs, "Always translate English") Google Translate on the English
  // exam page. Translate swaps every text node for <font><font>…</font></font>
  // and keeps doing it for new text, behind React's back — a known cause of
  // React crashes (removeChild NotFoundError) and frozen text. Simulated
  // here the way Translate does it (same words, so only the DOM changes);
  // pages that opt out (translate="no" / meta google notranslate) are left
  // alone, as Chrome would.
  const TRANSLATE_SIM = `(() => {
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);
    const st = (window.__xl = { n: 0, on: false, blocked: false });
    const optedOut = () => document.documentElement.getAttribute("translate") === "no"
      || (document.body && document.body.getAttribute("translate") === "no")
      || !!document.querySelector('meta[name="google"][content="notranslate"]')
      || document.documentElement.classList.contains("notranslate");
    const skip = (node) => {
      for (let e = node.parentElement; e; e = e.parentElement) {
        if (SKIP.has(e.tagName) || e.isContentEditable || e.getAttribute("translate") === "no" || e.classList.contains("notranslate")) return true;
        if (e.tagName === "FONT" && e.dataset.xl) return true;
      }
      return false;
    };
    const tr = (node) => {
      if (!node.parentNode || !node.nodeValue || !node.nodeValue.trim() || skip(node)) return;
      const outer = document.createElement("font"); outer.style.verticalAlign = "inherit"; outer.dataset.xl = "1";
      const inner = document.createElement("font"); inner.style.verticalAlign = "inherit"; inner.textContent = node.nodeValue;
      outer.appendChild(inner);
      node.parentNode.replaceChild(outer, node);
      st.n++;
    };
    const walk = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const list = [];
      while (w.nextNode()) list.push(w.currentNode);
      list.forEach(tr);
    };
    const start = () => {
      if (optedOut()) { st.blocked = true; return; }
      st.on = true; walk(document.body);
      new MutationObserver((ms) => {
        for (const m of ms) {
          if (m.type === "characterData") tr(m.target);
          for (const n of m.addedNodes) { if (n.nodeType === 3) tr(n); else if (n.nodeType === 1) walk(n); }
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    if (document.readyState === "complete") setTimeout(start, 800);
    else addEventListener("load", () => setTimeout(start, 800));
  })();`;
  await check("D-20261110-2", [], "學生的 Chrome 開著「自動翻譯成中文」考英文：考試畫面不能當掉或變白，題號、倒數時間要跟著更新，選的答案和標記都要存到，能交卷進第二模組、最後看到成績頁", "裝置/瀏覽器", () =>
    asStudent(75, TESTS.engLinear, async ({ s, b }) => {
      const T = TESTS.engLinear;
      const problems = [], notes = [];
      const { page, context } = await login(b, STUDENT1_CLERK, { locale: "zh-TW" });
      await context.addInitScript(TRANSLATE_SIM);
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e.message || e).slice(0, 160)));
      // The take page's per-question error boundary catches render crashes
      // and only logs them, so read the console too.
      page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
      const crashed = async () => /Application error|client-side exception|Something went wrong|failed to render|發生錯誤/i.test(await page.locator("body").innerText().catch(() => ""));
      // Translate's <font> pieces become flex items, so innerText splits the
      // "Question 1 of 27" label over lines; read textContent instead.
      const totalOfXl = async () => Number((await page.getByText(/Question \d+ of \d+/).first().textContent()).replace(/\s+/g, " ").match(/of (\d+)/)[1]);
      const timerXl = async () => {
        const m = ((await page.getByRole("timer").first().textContent({ timeout: 10000 })) ?? "").replace(/\s+/g, "").match(/(\d+):(\d{2})/);
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
      };
      const xl = () => page.evaluate(() => window.__xl ?? null).catch(() => null);
      // Each step: on a failure note it and stop (later steps depend on it).
      const step = async (name, fn) => {
        try { await fn(); return true; } catch (e) {
          problems.push(`${name}: ${String(e.message || e).split("\n")[0].slice(0, 140)}${(await crashed()) ? " (the page shows an error screen)" : ""}`);
          return false;
        }
      };
      let m1, qs1, total;
      const ok = await step("opening the exam with translation on", async () => {
        await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
        await page.waitForFunction(() => window.__xl && (window.__xl.on || window.__xl.blocked), null, { timeout: 15000 });
        await page.getByRole("button", { name: /Start Test|Resume Test/ }).click({ timeout: 30000 });
        await page.waitForURL(/\/take/, { timeout: 45000, waitUntil: "commit" });
        await waitTake(page);
        await page.waitForFunction(() => window.__xl && (window.__xl.on || window.__xl.blocked), null, { timeout: 15000 });
        [m1] = await subs(s.id, T);
        qs1 = await moduleQs(m1.module_id);
        total = await totalOfXl();
      });
      const x0 = await xl();
      if (x0?.blocked) notes.push("the exam page opts out of translation (translate=no), so Chrome wouldn't translate it");
      else if (ok && !(x0?.n > 30)) throw new Error(`translation simulation didn't run (${JSON.stringify(x0)})`);
      else if (ok) notes.push(`${x0.n} text pieces translated on load`);
      if (ok) {
        await sleep(1500);
        const broken = ((await page.locator("body").innerText().catch(() => "")).match(/Question \d+ failed to render/) ?? [])[0];
        if (broken) problems.push(`right after opening, the exam shows "${broken}" instead of the question and its choices`);
      }
      let go = ok && await step("Q1 = A, then Next to Q2", async () => {
        await onQuestion(page, 1);
        await choice(page, "A").click();
        await page.getByRole("button", { name: /^Next/ }).first().click();
        await page.getByText(/Question 2 of \d+/).first().waitFor({ timeout: 10000 }).catch(() => { throw new Error("after Next the question label does not say 'Question 2' (stuck text)"); });
      });
      go = go && await step("Q2 = B and Mark for Review", async () => {
        await choice(page, "B").click();
        await page.getByRole("button", { name: /Mark for Review/ }).first().click();
      });
      if (go) {
        const t1 = await timerXl().catch(() => null);
        await sleep(4000);
        const t2 = await timerXl().catch(() => null);
        notes.push(`timer ${t1}s → ${t2}s`);
        if (t1 == null || t2 == null || !(t2 < t1)) problems.push(`the countdown on screen didn't move in 4 s (${t1} → ${t2})`);
      }
      go = go && await step("navigator jump to Q5, Q5 = C", async () => {
        await jumpTo(page, 5);
        await choice(page, "C").click();
      });
      if (go) {
        const want = { 0: "A", 1: "B", 4: "C" };
        const r = await waitRow(m1.id, (x) => Object.entries(want).every(([i, l]) => x.answers?.[qs1[i].id] === l) && (x.metadata?.flagged ?? []).includes(qs1[1].id), 20000);
        const got = Object.entries(want).filter(([i, l]) => r?.answers?.[qs1[i].id] === l).length;
        if (got !== 3) problems.push(`only ${got}/3 answers saved (Q1=A, Q2=B, Q5=C)`);
        if (!(r?.metadata?.flagged ?? []).includes(qs1[1].id)) problems.push("the mark on Q2 wasn't saved");
        go = await step("Review & Submit shows 3 answered", async () => {
          await goToSubmitModal(page, total);
          const dlg = await page.getByRole("dialog").last().innerText();
          if (!new RegExp(`\\b3\\s*/\\s*${total}\\b`).test(dlg)) throw new Error(`the review screen doesn't show 3 / ${total} answered: "${dlg.replace(/\s+/g, " ").slice(0, 120)}"`);
        });
      }
      go = go && await step("Submit Module 1 → Module 2", async () => {
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 });
        await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 });
        await waitTake(page);
        await onQuestion(page, 1);
        await choice(page, "D").click();
      });
      const f1 = await waitRow(m1.id, (r) => r.status !== "In Progress", 5000);
      if (go && f1?.status !== "Submitted") problems.push(`Module 1 ended ${f1?.status}`);
      go = go && await step("Submit Module 2 → result page", async () => {
        const m2 = (await subs(s.id, T)).find((r) => r.id !== m1.id);
        if (!m2) throw new Error("no Module 2 row");
        const qs2 = await moduleQs(m2.module_id);
        const r2 = await waitRow(m2.id, (r) => r.answers?.[qs2[0].id] === "D", 20000);
        if (r2?.answers?.[qs2[0].id] !== "D") throw new Error("the Module 2 answer didn't save");
        await goToSubmitModal(page, await totalOfXl());
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        await page.waitForURL(/\/result/, { timeout: 45000 });
        await page.locator("main").first().waitFor({ timeout: 20000 });
        await sleep(1500);
        if (await crashed()) throw new Error("the result page shows an error screen");
      });
      if (go) notes.push("M1 and M2 submitted, result page shown");
      const reactErrs = errs.filter((e) => /removeChild|insertBefore|NotFoundError|not a child|Minified React error/i.test(e));
      if (reactErrs.length) problems.push(`${reactErrs.length} render crash error(s), e.g. "${reactErrs[0].split("\n")[0]}"`);
      else if (errs.length) notes.push(`other page errors: ${errs[0]}`);
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261110-3 ─────────────────────────────────────────
  // adff6a3 added "Assign test" to the student page, so a student who
  // already gets a test through their class can now also get it directly.
  // While they are mid-exam the admin then tidies up: "Remove assignment"
  // from the student page (must refuse — they started) and "Remove students
  // + delete their work" from the test page (must keep the work: the class
  // still gives the test). The exam must carry on untouched.
  await check("D-20261110-3", [], "學生已經透過班級拿到測驗，管理員又在學生頁「指派測驗」給他，學生考到一半時管理員再把這個個別指派移除（甚至勾選刪除作答）：我的測驗只能出現一次、只能開出一份考卷；學生已經開始的考卷不能被刪掉，要能繼續考完兩個模組", "老師/管理員動作", () =>
    asStudent(79, TESTS.mathLinear, async ({ s, b, page }) => {
      const T = TESTS.mathLinear;
      const problems = [], notes = [];
      const orig = (await db.from("test_assignments").select("student_ids,class_group_ids").eq("test_id", T).single()).data;
      if ((orig.student_ids ?? []).includes(s.id)) throw new Error("setup: 079 is already directly assigned");
      const mem = ((await db.from("class_group_members").select("class_group_id").eq("student_id", s.id)).data ?? []).map((m) => m.class_group_id);
      if (!mem.some((c) => orig.class_group_ids.includes(c))) throw new Error("setup: 079's class isn't assigned to mathLinear");
      const tName = (await db.from("tests").select("test_name").eq("id", T).single()).data.test_name;
      let admin;
      try {
        admin = await login(b, ADMIN_CLERK);
        const AR = admin.context.request;
        // The student page's Assign test (same route the new menu calls).
        const add = await AR.post(`${BASE}/api/admin/tests/${T}/add-students`, { data: { studentIds: [s.id] } });
        const addJ = await add.json().catch(() => ({}));
        if (add.status() !== 200) throw new Error(`setup: Assign test → ${add.status()} ${JSON.stringify(addJ).slice(0, 120)}`);
        const add2 = await AR.post(`${BASE}/api/admin/tests/${T}/add-students`, { data: { studentIds: [s.id] } });
        const add2J = await add2.json().catch(() => ({}));
        if (add2.status() !== 200 || add2J.added !== 0) problems.push(`assigning the same student twice wasn't a no-op (${add2.status()} added=${add2J.added})`);
        const ids1 = (await db.from("test_assignments").select("student_ids").eq("test_id", T).single()).data.student_ids;
        if (ids1.filter((x) => x === s.id).length !== 1) problems.push(`the student is in the direct list ${ids1.filter((x) => x === s.id).length} times`);
        // My Tests: once, and starting opens one exam.
        await page.goto(`${BASE}/student/tests`, { waitUntil: "networkidle" });
        await page.locator("main").first().waitFor({ timeout: 20000 });
        const rows = await page.locator("tr", { hasText: tName }).count();
        if (rows !== 1) problems.push(`My Tests lists the test ${rows} times (class + direct assignment)`);
        const apiList = await (await page.context().request.get(`${BASE}/api/student/tests`)).json().catch(() => ({}));
        const apiRows = JSON.stringify(apiList).split(`"${T}"`).length - 1;
        notes.push(`My Tests rows: ${rows}; /api/student/tests mentions it ${apiRows}×`);
        await startTestBrowser(page, T);
        let all = await subs(s.id, T);
        if (all.length !== 1) problems.push(`starting created ${all.length} exam rows`);
        const m1 = all[0];
        const qs1 = await moduleQs(m1.module_id);
        const mcIdx = qs1.map((q, i) => [q, i]).filter(([q]) => q.question_type === "Multiple Choice").map(([, i]) => i).slice(0, 2);
        if (mcIdx.length < 2) throw new Error("setup: mathLinear M1 has < 2 multiple-choice questions");
        await jumpTo(page, mcIdx[0] + 1);
        await choice(page, "A").click();
        if ((await waitRow(m1.id, (r) => r.answers?.[qs1[mcIdx[0]].id] === "A", 20000))?.answers?.[qs1[mcIdx[0]].id] !== "A") throw new Error("setup: first answer didn't save");
        // Student page "Remove assignment" (onlyIfNotStarted): must refuse.
        const rmSafe = await AR.post(`${BASE}/api/admin/tests/${T}/remove-students`, { data: { studentIds: [s.id], onlyIfNotStarted: true } });
        if (rmSafe.status() !== 409) problems.push(`"Remove assignment" on a student who is mid-exam answered ${rmSafe.status()} instead of refusing (409)`);
        const ids2 = (await db.from("test_assignments").select("student_ids").eq("test_id", T).single()).data.student_ids;
        if (!ids2.includes(s.id)) problems.push("the refused \"Remove assignment\" still removed the student");
        // Test page "Remove students" with delete-their-work.
        const rm = await AR.post(`${BASE}/api/admin/tests/${T}/remove-students`, { data: { studentIds: [s.id], deleteSubmissions: true } });
        const rmJ = await rm.json().catch(() => ({}));
        notes.push(`remove+delete → ${rm.status()} removed=${rmJ.removed} deleted=${rmJ.deletedSubmissions} stillViaClass=${(rmJ.stillVisibleViaGroup ?? []).includes(s.id)}`);
        if (rm.status() !== 200) problems.push(`remove-students answered ${rm.status()}`);
        if (!(rmJ.stillVisibleViaGroup ?? []).includes(s.id)) problems.push("the admin isn't told the student still has the test through their class");
        all = await subs(s.id, T);
        if (!all.some((r) => r.id === m1.id)) {
          problems.push("the student's in-progress exam was DELETED although their class still gives them the test");
        } else {
          // The open tab carries on.
          await jumpTo(page, mcIdx[1] + 1);
          await choice(page, "B").click();
          const r = await waitRow(m1.id, (x) => x.answers?.[qs1[mcIdx[1]].id] === "B", 20000);
          if (r?.answers?.[qs1[mcIdx[1]].id] !== "B") problems.push("after the removal a new answer didn't save");
          await goToSubmitModal(page, await totalOf(page));
          await page.getByRole("button", { name: /Submit Test/ }).last().click();
          const toM2 = await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true, () => false);
          const f1 = await waitRow(m1.id, (x) => x.status !== "In Progress", 20000);
          if (f1?.status !== "Submitted") problems.push(`Module 1 ended ${f1?.status}`);
          if (f1?.answers?.[qs1[mcIdx[0]].id] !== "A" || f1?.answers?.[qs1[mcIdx[1]].id] !== "B") problems.push("Module 1 lost an answer (before/after the removal)");
          if (!toM2) problems.push("submitting Module 1 didn't reach the Module 2 screen");
          else {
            await page.getByRole("link", { name: /Start Module 2/ }).click({ timeout: 30000 });
            const m2open = await waitTake(page).then(() => true, () => false);
            if (!m2open) problems.push("Start Module 2 didn't open Module 2");
            else {
              await goToSubmitModal(page, await totalOf(page));
              await page.getByRole("button", { name: /Submit Test/ }).last().click();
              if (!(await page.waitForURL(/\/result/, { timeout: 45000 }).then(() => true, () => false))) problems.push("Module 2 submit didn't open the result page");
              all = await subs(s.id, T);
              const st = all.map((r) => `${r.adaptive_track ?? "?"}:${r.status}`).join(", ");
              notes.push(`rows: ${st}`);
              if (all.length !== 2 || all.some((r) => r.status !== "Submitted")) problems.push(`expected 2 Submitted modules, got ${st}`);
            }
          }
        }
      } finally {
        // Put the direct list back exactly as it was.
        await db.from("test_assignments").update({ student_ids: orig.student_ids }).eq("test_id", T);
        await admin?.context.close().catch(() => {});
      }
      const back = (await db.from("test_assignments").select("student_ids").eq("test_id", T).single()).data.student_ids;
      if (JSON.stringify(back) !== JSON.stringify(orig.student_ids)) throw new Error("cleanup: mathLinear's direct assignment list wasn't restored");
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261111-1 ─────────────────────────────────────────
  // DELETE /api/admin/submissions/[id] (manage-submissions "Delete") wipes
  // the row. An admin can do it while the student is mid-exam (a wrong click,
  // or "let them start over"). The open tab then autosaves into a row that
  // no longer exists: PATCH answers 404. Must be true: the student is never
  // told "Saved"; within ~40 s the screen says the attempt is gone (or leaves
  // the exam), not an endless "Not saved — retrying"; Submit gives a clear
  // message (no endless "Submitting…"); the old tab creates no row; and the
  // test page then starts a clean exam (Q1, nothing picked, full time) that
  // the still-open old tab can't write into.
  await check("D-20261111-1", [], "學生考到一半時管理員把他的考卷刪掉：學生畫面不能還顯示「已儲存」，要在一分鐘內清楚告訴學生這份考卷已經不在了（不能一直顯示「重試中」讓學生白寫）；按交卷要有清楚的訊息；回到測驗頁能重新開始一份全新的考卷", "老師/管理員動作", () =>
    asStudent(73, TESTS.engLinear, async ({ s, b, page, context }) => {
      const T = TESTS.engLinear;
      const problems = [], notes = [];
      const limit = (await db.from("tests").select("time_limit_minutes").eq("id", T).single()).data.time_limit_minutes;
      const statusText = async (p) => (await p.locator('[role="status"]').filter({ hasText: /Saved|Saving|Not saved/ }).first().textContent({ timeout: 2000 }).catch(() => "")).trim();
      const TOLD = /removed|deleted|no longer (available|exists|active|there)|isn'?t there|wasn'?t found|not found|was reset|start (it )?(again|over)|contact your teacher|ask your teacher/i;
      const BROKEN = /something went wrong|application error|failed to render/i;

      await startTestBrowser(page, T);
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      const [q1, q2, q3] = qs.map((q) => q.id);
      const total = await totalOf(page);
      await onQuestion(page, 1); await choice(page, "A").click();
      if ((await waitRow(m1.id, (r) => r.answers?.[q1] === "A", 20000))?.answers?.[q1] !== "A") throw new Error("setup: Q1=A didn't save");
      await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((e) => e.textContent.trim() === "Saved"), null, { timeout: 15000 }).catch(() => {});
      const toldBefore = TOLD.test(await page.locator("body").innerText().catch(() => ""));

      // The admin deletes the in-progress exam.
      const admin = await login(b, ADMIN_CLERK);
      const del = await admin.page.request.delete(`${BASE}/api/admin/submissions/${m1.id}`);
      await admin.context.close().catch(() => {});
      if (del.status() !== 200) throw new Error(`setup: admin DELETE → HTTP ${del.status()}`);
      if ((await subs(s.id, T)).length) throw new Error("setup: the row is still there after the admin delete");
      notes.push("admin deleted the in-progress exam (HTTP 200)");

      // The student keeps going: Q2 = B, then watch the screen for 40 s.
      await jumpTo(page, 2); await choice(page, "B").click();
      const pickedAt = Date.now();
      const seen = [];
      let sawNotSaved = false, falseSaved = false, toldAt = null, leftAt = null;
      while (Date.now() - pickedAt < 40000) {
        const st = await statusText(page);
        if (st && seen.at(-1) !== st) seen.push(st);
        if (/Saving|Not saved/.test(st)) sawNotSaved = true;
        else if (st === "Saved" && (sawNotSaved || Date.now() - pickedAt > 5000)) falseSaved = true;
        if (!toldAt && !toldBefore && TOLD.test(await page.locator("body").innerText().catch(() => ""))) toldAt = Date.now();
        if (!leftAt && !/\/take/.test(page.url())) leftAt = Date.now();
        if (toldAt || leftAt) break;
        await sleep(500);
      }
      notes.push(`after the delete the save status went ${seen.map((x) => `"${x}"`).join(" → ") || "(none)"}`);
      if (falseSaved) problems.push("the screen said \"Saved\" for an answer picked after the exam was deleted (it went nowhere)");
      if (toldAt) notes.push(`student told after ${Math.round((toldAt - pickedAt) / 1000)} s`);
      else if (leftAt) notes.push(`page left the exam after ${Math.round((leftAt - pickedAt) / 1000)} s (${new URL(page.url()).pathname})`);
      else problems.push(`40 s after the exam was deleted the student still sees "${seen.at(-1) ?? "?"}" and nothing says the exam is gone — they would keep answering into nothing`);

      // Submit (only if still on the exam).
      if (/\/take/.test(page.url())) {
        await jumpTo(page, 3); await choice(page, "C").click().catch(() => {});
        await goToSubmitModal(page, total);
        await page.getByRole("button", { name: /Submit Test/ }).last().click();
        const t0 = Date.now();
        let msg = null;
        while (Date.now() - t0 < 30000) {
          if (!/\/take/.test(page.url())) { msg = `left to ${new URL(page.url()).pathname}`; break; }
          const body = await page.locator("body").innerText().catch(() => "");
          const m = body.match(/(Couldn't submit[^\n]*|Not submitted yet[^\n]*)/);
          if (m && !/Retrying automatically/.test(m[1])) { msg = m[1].slice(0, 160); break; }
          if (m) msg = m[1].slice(0, 160);
          await sleep(1000);
        }
        notes.push(`Submit → ${msg ?? "nothing within 30 s"}`);
        if (!msg) problems.push("pressing Submit on the deleted exam showed nothing for 30 s (stuck)");
        else if (/Retrying automatically/.test(msg)) problems.push(`pressing Submit on the deleted exam says "${msg.slice(0, 80)}" — it will never succeed`);
        if (BROKEN.test(await page.locator("body").innerText().catch(() => ""))) problems.push("the old tab shows an error screen");
      }
      const zombie = await subs(s.id, T);
      if (zombie.length) problems.push(`the old tab re-created ${zombie.length} exam row(s) after the delete (${zombie.map((r) => `${r.adaptive_track}:${r.status}`).join(", ")})`);

      // The student opens the test page in a new tab (the old one stays open, retrying).
      const p2 = await context.newPage();
      await p2.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
      const tp = await p2.locator("body").innerText().catch(() => "");
      if (BROKEN.test(tp)) problems.push("the test page shows an error after the delete");
      const startBtn = p2.getByRole("button", { name: /Start Test|Resume Test/ }).first();
      const label = (await startBtn.textContent({ timeout: 20000 }).catch(() => "")).trim();
      if (!label) problems.push("the test page has no Start button after the delete");
      else {
        if (/Resume/.test(label)) problems.push(`the test page offers "${label}" for a deleted exam`);
        await startBtn.click();
        await p2.waitForURL(/\/take/, { timeout: 45000, waitUntil: "commit" });
        await waitTake(p2);
        await sleep(8000); // old tab's retries + any restore on the new tab
        const rows = await subs(s.id, T);
        if (rows.length !== 1) problems.push(`starting again made ${rows.length} rows (expected 1)`);
        const fresh = rows.at(-1);
        const where = Number((await p2.getByText(/Question \d+ of \d+/).first().innerText()).match(/Question (\d+)/)[1]);
        const secs = await timerSecsOf(p2);
        const shown = [];
        for (const i of [1, 2, 3]) {
          if (i !== where) await jumpTo(p2, i);
          for (const l of ["A", "B", "C", "D"]) if (await isPicked(p2, l)) shown.push(`Q${i}=${l}`);
        }
        notes.push(`new exam opened at Q${where}, timer ${secs}s of ${limit * 60}s, server answers ${Object.keys(fresh?.answers ?? {}).length}`);
        if (where !== 1) problems.push(`the new exam opened at question ${where}`);
        if (secs == null || secs < limit * 60 - 90) problems.push(`the new exam's timer shows ${secs}s, not the full ${limit * 60}s`);
        if (shown.length) problems.push(`the new exam shows answers from the deleted one: ${shown.join(", ")}`);
        const old = [[q1, "Q1"], [q2, "Q2"], [q3, "Q3"]].filter(([id]) => fresh?.answers?.[id]).map(([id, n]) => `${n}=${fresh.answers[id]}`);
        if (old.length) problems.push(`the deleted exam's answers landed in the new exam on the server: ${old.join(", ")}`);
        await jumpTo(p2, 1); await choice(p2, "D").click();
        if (fresh && (await waitRow(fresh.id, (r) => r.answers?.[q1] === "D", 20000))?.answers?.[q1] !== "D") problems.push("Q1=D in the new exam didn't save");
      }
      if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
      return notes.join("; ");
    }), 3 * 60 * 1000);

  // ── D-20261111-2 ─────────────────────────────────────────
  // A whole Math exam on a small phone (iPhone SE, 375×667, Mobile Safari
  // engine, touch only). H-14-15 only checks the top bar on a 390 px screen
  // and D-20261031-3 is an iPad. On a phone the Desmos panel takes the bottom
  // 55% of the screen, the question gets what's left. Must be true: no
  // sideways scrolling; top-bar items don't overlap; with Desmos open the
  // choices / Next / the answer box can still be reached and tapped, and the
  // calculator is big enough to use; the navigator fits; Module 1 → Module 2
  // → result page all by touch, with every tapped/typed answer graded.
  await check("D-20261111-2", [], "用手機（iPhone SE 小螢幕）考完整份數學：畫面不能左右跑，上方的時間/按鈕不能疊在一起；打開 Desmos 計算機時還是點得到選項、下一題和填答框，計算機也夠大能用；用手指點完兩個模組、看到成績頁，點的答案都有算分", "裝置/瀏覽器", async () => {
    const T = TESTS.mathLinear;
    const s = studentByN(74);
    if (!s) throw new Error("student 074 not found");
    const orig = C.students[0].id;
    const { devices } = await import("playwright");
    const phone = devices["iPhone SE"];
    await deleteSubs(s.id, T);
    const b = await webkit.launch();
    const problems = [], notes = [];
    try {
      await borrowLogin(s.id, STUDENT1_CLERK);
      const { page } = await login(b, STUDENT1_CLERK, { ...phone });
      const vp = page.viewportSize();
      const next = page.getByRole("button", { name: /^Next/ }).first();
      const box = async (loc) => (await loc.first().isVisible().catch(() => false)) ? loc.first().boundingBox() : null;
      const inView = async (loc, what, tag) => {
        const el = loc.first();
        if (!(await el.isVisible().catch(() => false))) { problems.push(`${tag}: ${what} not visible`); return false; }
        await el.scrollIntoViewIfNeeded().catch(() => {});
        const bx = await el.boundingBox();
        if (!bx || bx.x < -1 || bx.y < -1 || bx.x + bx.width > vp.width + 1 || bx.y + bx.height > vp.height + 1 || bx.height < 8) {
          problems.push(`${tag}: ${what} can't be brought fully on screen (${bx ? `${Math.round(bx.x)},${Math.round(bx.y)} ${Math.round(bx.width)}×${Math.round(bx.height)}` : "no box"})`);
          return false;
        }
        // Is it the element a finger at its centre would hit (not covered by a panel/bar)?
        const hit = await el.evaluate((n) => {
          const r = n.getBoundingClientRect();
          const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return !!t && (n === t || n.contains(t));
        }).catch(() => false);
        if (!hit) { problems.push(`${tag}: ${what} is covered by something else`); return false; }
        return true;
      };
      const sideways = async (tag) => {
        const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (o > 1) problems.push(`${tag}: page scrolls sideways by ${o}px`);
      };
      const overlap = (a, c) => a && c && a.x < c.x + c.width - 1 && c.x < a.x + a.width - 1 && a.y < c.y + c.height - 1 && c.y < a.y + a.height - 1;
      const topBar = async (tag) => {
        const items = {
          timer: await box(page.getByRole("timer")),
          "question label": await box(page.getByRole("button", { name: /Question \d+ of \d+/ })),
          calculator: await box(page.locator('button[aria-label="Calculator"]')),
          "save status": await box(page.locator('[role="status"]').filter({ hasText: /Saved|Saving|Not saved/ })),
        };
        const k = Object.keys(items);
        for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) if (overlap(items[k[i]], items[k[j]])) problems.push(`${tag}: ${k[i]} and ${k[j]} overlap`);
        if (!items.timer) problems.push(`${tag}: timer not visible`);
        if (!items.calculator) problems.push(`${tag}: Calculator button not visible`);
      };

      await page.waitForURL(/\/student/, { timeout: 30000 }).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await startTestBrowser(page, T).catch(async () => { await sleep(2000); await startTestBrowser(page, T); });
      const [m1] = await subs(s.id, T);
      const qs = await moduleQs(m1.module_id);
      const total = await totalOf(page);
      const mcIdx = qs.map((q, i) => (q.question_type === "Multiple Choice" ? i : -1)).filter((i) => i >= 0);
      const sprIdx = qs.findIndex((q) => q.question_type !== "Multiple Choice");
      if (mcIdx.length < 2) throw new Error("setup: fewer than 2 multiple-choice questions in Module 1");
      const want = {};
      await onQuestion(page, 1);
      await topBar("Q1");
      await sideways("Q1");

      // Two multiple-choice answers, the second with Desmos open.
      const [a, c] = [mcIdx[0], mcIdx[1]];
      if (a + 1 !== 1) await jumpTo(page, a + 1);
      for (const l of ["A", "B", "C", "D"]) await inView(choice(page, l), `choice ${l}`, `Q${a + 1}`);
      await choice(page, "A").tap(); want[qs[a].id] = "A";
      await page.locator('button[aria-label="Calculator"]').first().tap();
      const ifr = page.locator('iframe[title="Desmos calculator"]').first();
      await ifr.waitFor({ timeout: 20000 }).catch(() => problems.push("tapping Calculator didn't open Desmos"));
      const ib = await box(ifr);
      notes.push(`Desmos panel ${ib ? `${Math.round(ib.width)}×${Math.round(ib.height)}` : "missing"}`);
      if (ib && (ib.height < 180 || ib.width < vp.width * 0.8)) problems.push(`Desmos panel is only ${Math.round(ib.width)}×${Math.round(ib.height)} px on the phone — too small to use`);
      await topBar("Desmos open");
      await sideways("Desmos open");
      await jumpTo(page, c + 1);
      let okD = true;
      for (const l of ["A", "B", "C", "D"]) okD = (await inView(choice(page, l), `choice ${l} (Desmos open)`, `Q${c + 1}`)) && okD;
      if (okD) { await choice(page, "D").tap(); want[qs[c].id] = "D"; }
      await inView(next, "Next (Desmos open)", `Q${c + 1}`);
      // The answer box of a grid-in, Desmos still open.
      if (sprIdx >= 0) {
        await jumpTo(page, sprIdx + 1);
        const inp = page.getByPlaceholder("Enter your answer").first();
        if (await inView(inp, "answer box (Desmos open)", `Q${sprIdx + 1}`)) {
          await inp.tap(); await inp.fill("12"); want[qs[sprIdx].id] = "12";
        }
      } else notes.push("no grid-in in Module 1");
      await page.getByRole("button", { name: "Close panel" }).first().tap().catch(() => problems.push("couldn't close the Desmos panel"));
      await sleep(500);
      if (await ifr.isVisible().catch(() => false)) problems.push("Desmos panel still open after Close");
      const saved = await waitRow(m1.id, (r) => Object.entries(want).every(([id, v]) => r.answers?.[id] === v), 25000);
      const missing = Object.entries(want).filter(([id, v]) => saved?.answers?.[id] !== v).map(([id, v]) => `Q${qs.findIndex((q) => q.id === id) + 1}=${v}`);
      if (missing.length) problems.push(`not saved from the phone: ${missing.join(", ")}`);

      // Navigator must fit; tap the last question.
      await page.getByRole("button", { name: /Question \d+ of \d+/ }).first().tap();
      const nav = page.getByRole("dialog", { name: "Question Navigator" });
      await nav.waitFor({ timeout: 10000 });
      const nb = await nav.boundingBox();
      if (!nb || nb.x < -1 || nb.x + nb.width > vp.width + 1) problems.push(`navigator is wider than the phone (${nb ? Math.round(nb.width) : "?"} px)`);
      const lastBtn = nav.getByRole("button", { name: String(total), exact: true }).first();
      if (await inView(lastBtn, `navigator button ${total}`, "navigator")) await lastBtn.tap();
      else await jumpTo(page, total);
      await onQuestion(page, total);

      // Submit Module 1 by touch, start Module 2, submit, result page.
      const rs = page.getByRole("button", { name: /Review & Submit/ }).first();
      await inView(rs, "Review & Submit", `Q${total}`);
      await rs.tap();
      const sub = page.getByRole("button", { name: /Submit Test/ }).last();
      await sub.waitFor({ timeout: 15000 });
      await inView(sub, "Submit Test", "submit dialog");
      await sub.tap();
      if (!(await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 }).then(() => true, () => false))) problems.push("tapping Submit Test didn't reach the Module 2 screen");
      const f1 = await waitRow(m1.id, (r) => r.status !== "In Progress", 20000);
      const { data: recs } = await db.from("answer_records").select("question_id,student_answer").eq("submission_id", m1.id);
      const graded = Object.entries(want).filter(([id, v]) => String((recs ?? []).find((x) => x.question_id === id)?.student_answer ?? "").trim() === v).length;
      notes.push(`Module 1 ${f1?.status}, ${graded}/${Object.keys(want).length} tapped/typed answers graded`);
      if (f1?.status !== "Submitted") problems.push(`Module 1 ended ${f1?.status}`);
      if (graded !== Object.keys(want).length) problems.push(`only ${graded}/${Object.keys(want).length} answers from the phone were graded`);
      const sm2 = page.getByRole("link", { name: /Start Module 2/ }).or(page.getByRole("button", { name: /Start Module 2/ })).first();
      if (await sm2.isVisible().catch(() => false)) {
        await inView(sm2, "Start Module 2", "Module 2 screen");
        await sm2.tap();
        if (await waitTake(page).then(() => true, () => false)) {
          await topBar("Module 2");
          await sideways("Module 2");
          await choice(page, "B").tap().catch(() => {});
          const t2 = await totalOf(page);
          await jumpTo(page, t2);
          await page.getByRole("button", { name: /Review & Submit/ }).first().tap();
          await page.getByRole("button", { name: /Submit Test/ }).last().tap({ timeout: 15000 });
          if (!(await page.waitForURL(/\/result/, { timeout: 45000 }).then(() => true, () => false))) problems.push("Module 2 submit didn't open the result page");
          else {
            await page.waitForLoadState("networkidle").catch(() => {});
            const rt = await page.locator("main").innerText().catch(() => "");
            if (/something went wrong|application error|NaN|undefined/i.test(rt)) problems.push("the result page shows an error / NaN on the phone");
            await sideways("result page");
          }
        } else problems.push("Start Module 2 didn't open Module 2");
      }
      const rows = await subs(s.id, T);
      notes.push(`rows: ${rows.map((r) => `${r.adaptive_track ?? "?"}:${r.status}`).join(", ")}`);
      if (rows.length !== 2 || rows.some((r) => r.status !== "Submitted")) problems.push(`expected 2 Submitted modules, got ${rows.map((r) => r.status).join(", ")}`);
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      await deleteSubs(s.id, T).catch(() => {});
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 3 * 60 * 1000);

  // ── D-20261111-3 ─────────────────────────────────────────
  // A class teacher must only see their own classes' students. Teacher 01
  // teaches TEST Class A (Math). 076 is in class A, 078 in class C; both take
  // mathLinear (assigned to all QA classes) and get Q1 wrong. Every teacher
  // surface — results list/detail API and pages, CSV export, per-question
  // "who got it wrong", class pages, student page, dashboard — must show 076
  // and never 078; writing tutor notes / granting a retake for 078 must be
  // refused. Guard for d32f7dc, which rewrites all of these for full-length
  // tests and isn't deployed yet.
  await check("D-20261111-3", [], "老師只能看到自己班上的學生：別班學生的成績、作答內容、名字不能出現在老師的成績列表、成績明細、匯出檔、題目分析、班級頁和首頁；老師也不能替別班學生寫筆記或給重考；自己班的學生要看得到", "安全", async () => {
    const T = TESTS.mathLinear;
    const mine = studentByN(76), other = studentByN(78);
    if (!mine || !other) throw new Error("students 076/078 not found");
    const teacher = C.teachers[0];
    const classA = C.classes.find((k) => k.name === "TEST Class A"), classC = C.classes.find((k) => k.name === "TEST Class C");
    // Setup facts (else the check means nothing).
    const { data: tcls } = await db.from("class_group_teachers").select("class_group_id").eq("teacher_id", teacher.id);
    const myClasses = (tcls ?? []).map((r) => r.class_group_id);
    const { data: mem } = await db.from("class_group_members").select("class_group_id,student_id").in("student_id", [mine.id, other.id]);
    const inMine = (sid) => (mem ?? []).some((m) => m.student_id === sid && myClasses.includes(m.class_group_id));
    if (!myClasses.includes(classA.id) || myClasses.includes(classC.id)) throw new Error("setup: Teacher 01 isn't (only) on class A");
    if (!inMine(mine.id) || inMine(other.id)) throw new Error("setup: 076 must be in Teacher 01's classes and 078 must not");
    const { data: asg } = await db.from("test_assignments").select("teacher_ids").eq("test_id", T).single();
    if ((asg?.teacher_ids ?? []).includes(teacher.id)) throw new Error("setup: Teacher 01 is a direct teacher of mathLinear (sees everyone by design)");

    const startedAt = new Date().toISOString();
    const orig = C.students[0].id;
    const took = {};
    const problems = [], notes = [];
    for (const st of [mine, other]) await deleteSubs(st.id, T);
    const b = await chromium.launch();
    try {
      // Both students finish mathLinear with Q1 wrong.
      for (const st of [mine, other]) {
        await borrowLogin(st.id, STUDENT1_CLERK);
        const { context } = await login(b, STUDENT1_CLERK);
        const trow = (await db.from("tests").select("module_id,module_1_id").eq("id", T).single()).data;
        const q = await moduleQs(trow.module_1_id ?? trow.module_id);
        const mc = q.find((x) => x.question_type === "Multiple Choice");
        if (!mc) throw new Error("setup: no multiple-choice question in Module 1");
        const wrong = ["A", "B", "C", "D"].find((l) => !String(mc.correct_answer ?? "").toUpperCase().includes(l));
        took[st.id] = await apiTakeTest(context.request, st.id, T, { forceM1Answers: { [mc.id]: wrong, [q[q.length - 1].id]: "A" } });
        took[st.id].qWrong = mc.id;
        await context.close();
      }
      await borrowLogin(orig, STUDENT1_CLERK);
      const sOther = await subs(other.id, T), sMine = await subs(mine.id, T);
      if (sOther.length !== 2 || sMine.length !== 2 || [...sOther, ...sMine].some((r) => r.status !== "Submitted")) throw new Error("setup: both students should have 2 Submitted modules");

      const { page, context } = await login(b, teacher.clerkId);
      const req = context.request;
      const tag = (st) => [st.name, st.email, st.id];
      const leaks = (txt, st) => tag(st).filter((x) => x && String(txt).includes(x));
      const showsMine = (txt) => String(txt).includes(mine.name);

      // APIs.
      const list = await req.get(`${BASE}/api/teacher/tests/${T}/results`);
      const listTxt = await list.text();
      if (list.status() !== 200) problems.push(`results API → HTTP ${list.status()}`);
      if (!listTxt.includes(mine.id) && !showsMine(listTxt)) problems.push("results API doesn't list the teacher's own student 076 (control)");
      if (leaks(listTxt, other).length) problems.push("results API lists the other class's student 078");
      for (const r of sOther) {
        const d = await req.get(`${BASE}/api/teacher/tests/${T}/results/${r.id}`);
        const dt = await d.text();
        if (d.status() === 200 || leaks(dt, other).length || /"answers"/.test(dt)) problems.push(`078's ${r.adaptive_track} detail → HTTP ${d.status()} (must be refused, no data)`);
      }
      const dm = await req.get(`${BASE}/api/teacher/tests/${T}/results/${sMine[0].id}`);
      if (dm.status() !== 200) problems.push(`076's own detail → HTTP ${dm.status()} (control)`);
      const csv = await req.get(`${BASE}/api/teacher/tests/${T}/export`);
      const csvTxt = await csv.text();
      if (csv.status() !== 200 || !showsMine(csvTxt)) problems.push(`CSV export → HTTP ${csv.status()}, own student 076 ${showsMine(csvTxt) ? "listed" : "missing"} (control)`);
      if (leaks(csvTxt, other).length) problems.push("CSV export contains the other class's student 078");
      const qa = await req.get(`${BASE}/api/teacher/tests/${T}/analytics/${took[other.id].qWrong}`);
      const qaTxt = await qa.text();
      if (leaks(qaTxt, other).length) problems.push("per-question analytics names 078 (other class) among wrong answers");
      const qm = took[mine.id].qWrong === took[other.id].qWrong ? qaTxt : await (await req.get(`${BASE}/api/teacher/tests/${T}/analytics/${took[mine.id].qWrong}`)).text();
      notes.push(`question analytics HTTP ${qa.status()}, own student ${showsMine(qm) ? "named" : "not named"}`);
      const an = await req.get(`${BASE}/api/teacher/tests/${T}/analytics`);
      if (leaks(await an.text(), other).length) problems.push("test analytics API names 078");

      // Writes on the other class's student.
      const tn = await req.patch(`${BASE}/api/teacher/tests/${T}/results/${sOther[0].id}`, { data: { tutorNotes: "qa-probe D-20261111-3" } });
      const tnRow = (await db.from("submissions").select("tutor_notes").eq("id", sOther[0].id).single()).data;
      if (tn.status() < 400 || /qa-probe/.test(tnRow?.tutor_notes ?? "")) problems.push(`teacher wrote tutor notes on 078's exam (HTTP ${tn.status()})`);
      const gr = await req.post(`${BASE}/api/teacher/tests/${T}/grant-retake`, { data: { studentId: other.id } });
      const { data: grants } = await db.from("test_retake_grants").select("id").eq("test_id", T).eq("student_id", other.id).gte("granted_at", startedAt);
      if (gr.status() < 400 || (grants ?? []).length) problems.push(`teacher granted 078 (other class) a retake (HTTP ${gr.status()})`);
      notes.push(`078 detail ${sOther.length}× refused, tutor notes → ${tn.status()}, grant → ${gr.status()}`);

      // Pages.
      const pageText = async (path) => {
        const res = await page.goto(BASE + path, { waitUntil: "networkidle" }).catch(() => null);
        await sleep(1500);
        return { status: res?.status() ?? 0, txt: await page.locator("body").innerText().catch(() => "") };
      };
      const rp = await pageText(`/teacher/tests/${T}/results`);
      if (!showsMine(rp.txt)) problems.push("results page doesn't show own student 076 (control)");
      const pages = [
        `/teacher/tests/${T}/results`, `/teacher/tests/${T}/results/${sOther[0].id}`, `/teacher/tests/${T}/results/${sOther[1].id}`,
        `/teacher/classes/${classC.id}`, `/teacher/classes/${classA.id}/students/${other.id}`, `/teacher/classes/${classA.id}`,
        `/teacher/results`, `/teacher`, `/teacher/analysis`, `/teacher/tests/${T}/analytics`, `/teacher/tests/${T}/analytics/${took[other.id].qWrong}`,
      ];
      const pageLeaks = [];
      for (const p of pages) {
        const { status, txt } = p === pages[0] ? rp : await pageText(p);
        const l = leaks(txt, other);
        if (l.length) pageLeaks.push(`${p.replace(T, "<test>").replace(other.id, "<078>").replace(classA.id, "<A>").replace(classC.id, "<C>").replace(sOther[0].id, "<078 M1>").replace(sOther[1].id, "<078 M2>")} (HTTP ${status})`);
      }
      if (pageLeaks.length) problems.push(`078 (other class) shown on: ${pageLeaks.join(", ")}`);
      notes.push(`${pages.length} teacher pages + 5 APIs checked; own student visible on results API/page/CSV`);
      await context.close();
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(orig, STUDENT1_CLERK).catch(() => {});
      for (const st of [mine, other]) await deleteSubs(st.id, T).catch(() => {});
      await db.from("test_retake_grants").delete().eq("test_id", T).eq("student_id", other.id).gte("granted_at", startedAt);
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 3 * 60 * 1000);
}
