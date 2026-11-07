// Module 1 submit that finds Module 1 already graded (the time-up cron or an
// earlier request won) must continue to Module 2, never dead-end.
// QA student 082 borrowing STUDENT1's login; mathLinear (2-module) test.
//   QA_BASE=http://localhost:3100 node .omc/qa/harness/qst-24-m1-already-submitted.mjs
// Cases:
//   A  M1 graded out-of-band WITHOUT a Module 2 (old cron) → click Submit →
//      lands on "Start Module 2", exactly one M2 row
//   B  M1 graded out-of-band WITH the Module 2 (new cron / lost response) →
//      click Submit → lands on "Start Module 2", still exactly one M2 row
//   C  M1 graded, no M2, student opens /take directly → Module 2 intro
//      (take page runs the handoff recovery instead of bouncing)
//   D  Start Module 2 → clock starts then (module_2_started_at stamped now)
//   E  submit while offline → "Not submitted yet — retrying" + retry button;
//      back online → background retry lands, answers intact, Module 2 intro
import { chromium } from "playwright";
import * as L from "./qa-student-taking-lib.mjs";

const T = L.TESTS.mathLinear;
const s = L.student(82);
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

async function clean() {
  const rows = await L.subs(s.id, T);
  if (rows.length) {
    await L.db.from("answer_records").delete().in("submission_id", rows.map((r) => r.id));
    await L.db.from("submissions").delete().in("id", rows.map((r) => r.id));
  }
}
const m2Rows = async () => (await L.subs(s.id, T)).filter((r) => String(r.adaptive_track).startsWith("module_2"));
/** Grade M1 like the old cron did: status flip only, no Module 2. */
async function gradeWithoutHandoff(m1Id) {
  const { error } = await L.db.from("submissions")
    .update({ status: "Submitted", submitted_at: new Date().toISOString(), percentage: 0, score: 0, correct_count: 0, total_questions: 22 })
    .eq("id", m1Id);
  if (error) throw error;
}
async function clickSubmit(page) {
  await L.openSubmitModal(page);
  await L.confirmSubmit(page);
}
async function onModule2Intro(page) {
  try {
    await page.getByText("Module 1 submitted").first().waitFor({ timeout: 45000 });
    return /\/take/.test(page.url());
  } catch {
    return false;
  }
}

const origS1 = L.S1.id;
await L.borrowLogin(s.id, L.CLERK1);
const b = await chromium.launch();
try {
  // ── A ──
  await clean();
  let { page, context } = await L.login(b, L.CLERK1);
  await L.startTest(page, T);
  await L.answerCurrent(page, "A");
  let [m1] = await L.subs(s.id, T);
  await gradeWithoutHandoff(m1.id);
  await clickSubmit(page);
  ok("A: submit after out-of-band grade (no M2) → Module 2 intro", await onModule2Intro(page), page.url().slice(-50));
  let m2 = await m2Rows();
  ok("A: exactly one Module 2 row", m2.length === 1, `${m2.length}`);
  await context.close();

  // ── B ──
  await clean();
  ({ page, context } = await L.login(b, L.CLERK1));
  await L.startTest(page, T);
  await L.answerCurrent(page, "A");
  [m1] = await L.subs(s.id, T);
  const pre = await page.request.post(`${L.BASE}/api/student/submissions/${m1.id}/submit`, { data: { answers: {}, answersMode: "merge", metadata: {} } });
  const preJ = await pre.json();
  ok("B: out-of-band submit created Module 2", !!preJ.data?.nextSubmissionId, `${pre.status()} ${preJ.data?.nextSubmissionId}`);
  const replay = await page.request.post(`${L.BASE}/api/student/submissions/${m1.id}/submit`, { data: {} });
  const replayJ = await replay.json();
  ok("B: replayed submit → 400 alreadySubmitted with the same nextSubmissionId",
    replay.status() === 400 && replayJ.alreadySubmitted === true && replayJ.nextSubmissionId === preJ.data?.nextSubmissionId,
    `${replay.status()} ${JSON.stringify(replayJ)}`);
  await clickSubmit(page);
  ok("B: UI submit after it was already graded → Module 2 intro", await onModule2Intro(page), page.url().slice(-50));
  m2 = await m2Rows();
  ok("B: still exactly one Module 2 row", m2.length === 1, `${m2.length}`);
  await context.close();

  // ── C ──
  await clean();
  ({ page, context } = await L.login(b, L.CLERK1));
  await L.startTest(page, T);
  [m1] = await L.subs(s.id, T);
  await gradeWithoutHandoff(m1.id);
  await page.goto(`${L.BASE}/student/tests/${T}/take`, { waitUntil: "domcontentloaded" });
  ok("C: /take with M1 graded and no M2 → Module 2 intro", await onModule2Intro(page), page.url().slice(-50));
  m2 = await m2Rows();
  ok("C: exactly one Module 2 row, unopened", m2.length === 1 && !m2[0].metadata?.module_2_started_at, JSON.stringify(m2.map((r) => r.metadata)));

  // ── D ──
  const before = Date.now();
  await page.getByRole("link", { name: /Start Module 2/ }).click();
  await L.waitTake(page);
  m2 = await m2Rows();
  const stamp = m2[0]?.metadata?.module_2_started_at;
  ok("D: Module 2 clock starts on Start Module 2", !!stamp && new Date(stamp).getTime() >= before - 5000, stamp);
  ok("D: device recorded on Module 2", !!m2[0]?.metadata?.device?.platform, JSON.stringify(m2[0]?.metadata?.device ?? null).slice(0, 120));
  await context.close();

  // ── E ── submit + autosave unreachable → visible "retrying" status, then the
  // background retry delivers the answer picked while offline and continues.
  await clean();
  ({ page, context } = await L.login(b, L.CLERK1));
  await L.startTest(page, T);
  [m1] = await L.subs(s.id, T);
  const q1 = (await L.moduleQs(m1.module_id))[0];
  let blocked = true;
  await page.route(`**/api/student/submissions/${m1.id}**`, (route) => (blocked ? route.abort() : route.continue()));
  await L.answerCurrent(page, "B");
  await clickSubmit(page);
  let banner = false;
  try { await page.getByText(/Not submitted yet/).first().waitFor({ timeout: 60000 }); banner = true; } catch {}
  ok("E: offline submit shows 'Not submitted yet … retrying' banner", banner);
  ok("E: banner has a manual retry button", (await page.getByRole("button", { name: /Retry now|Try submitting again/ }).count()) > 0);
  blocked = false;
  ok("E: background retry submits and continues to Module 2", await onModule2Intro(page), page.url().slice(-50));
  [m1] = await L.subs(s.id, T);
  ok("E: answer picked while offline was delivered", m1.answers?.[q1.id] === "B" && m1.status !== "In Progress", `${m1.status} ${m1.answers?.[q1.id]}`);
  await context.close();
} finally {
  await b.close().catch(() => {});
  await clean().catch(() => {});
  await L.borrowLogin(origS1, L.CLERK1).catch(() => {});
}
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
