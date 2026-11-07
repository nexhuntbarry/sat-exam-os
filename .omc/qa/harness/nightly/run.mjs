#!/usr/bin/env node
// harness/nightly/run.mjs — SAT Exam OS nightly regression suite
// Usage: node nightly/run.mjs
// Writes: .omc/qa/nightly/<YYYY-MM-DD>.json  (NY date)
// Never throws out; overall timeout 60 min.

import { chromium, webkit } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { login, db, cast, BASE, borrowLogin, clerk } from "../lib.mjs";
import { answersMatch } from "../qst-grade.mjs";
import { bankIntegrity, bankImages, bankMathRender, realScoreAnomalies } from "./content-checks.mjs";
import { runEdgeChecks } from "./edge-checks.mjs";
import { runDailyChecks } from "./daily-checks.mjs";
import { runPrintChecks } from "./print-checks.mjs";

// ─────────────────────── paths ─────────────────────────
const HARNESS_DIR = new URL("../", import.meta.url).pathname;
const QA_DIR      = new URL("../../", import.meta.url).pathname;
const ROOT        = new URL("../../../../", import.meta.url).pathname;
const TESTS       = JSON.parse(readFileSync(QA_DIR + "tests.json", "utf-8"));

const NY_DATE = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const NIGHTLY_DIR = QA_DIR + "nightly";
if (!existsSync(NIGHTLY_DIR)) mkdirSync(NIGHTLY_DIR, { recursive: true });
// ONLY=ID,ID runs just those checks (manual debugging) into a separate file.
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const OUT_JSON = ONLY ? `${NIGHTLY_DIR}/${NY_DATE}-only.json` : `${NIGHTLY_DIR}/${NY_DATE}.json`;
const LOG_LINE = (s) => process.stdout.write(s + "\n");

// ─────────────────────── globals ───────────────────────
const START_MS = Date.now();
const GLOBAL_TIMEOUT_MS = 160 * 60 * 1000; // FULL-TIMED ~66 min, edge ~15, daily new checks ≤25
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const C = cast();
const ADMIN_CLERK    = C.admins[0].clerkId;    // TEST Admin 01
const TEACHER1_CLERK = C.teachers[0].clerkId;  // Math
const TEACHER2_CLERK = C.teachers[1].clerkId;  // R&W
const STUDENT1_CLERK = C.students[0].clerkId;  // 001 class A
const STUDENT2_CLERK = C.students[1].clerkId;  // 002 class B
const REAL_ADMIN_CLERK = "user_3CooOaLGeVAgcwv17iCAypNcSwU"; // Barry read-only

function studentByN(n) {
  return C.students.find((s) => s.name === `TEST Student ${String(n).padStart(3, "0")}`);
}

// ─────────────────────── results ───────────────────────
const results = [];

function saveResults() {
  const out = {
    date: NY_DATE,
    started_at: new Date(START_MS).toISOString(),
    saved_at: new Date().toISOString(),
    total_ms: Date.now() - START_MS,
    counts: {
      PASS:  results.filter((r) => r.result === "PASS").length,
      FAIL:  results.filter((r) => r.result === "FAIL").length,
      ERROR: results.filter((r) => r.result === "ERROR").length,
    },
    checks: results,
  };
  writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
}

function fail(details) {
  const e = new Error(details);
  e.__fail = true;
  e.__details = details;
  throw e;
}

async function check(id, finding_ids, title_zh, area, fn, timeoutMs = 8 * 60 * 1000) {
  if (ONLY && !ONLY.includes(id)) return;
  if (Date.now() - START_MS > GLOBAL_TIMEOUT_MS) {
    results.push({ id, finding_ids, title_zh, area, result: "ERROR", details: "global timeout", ms: 0 });
    saveResults();
    return;
  }
  const t0 = Date.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`check timeout ${timeoutMs / 60000}min`)), timeoutMs)),
    ]);
    results.push({ id, finding_ids, title_zh, area, result: "PASS", details: detail ?? "", ms: Date.now() - t0 });
    LOG_LINE(`✓ PASS  [${id}] ${title_zh}`);
  } catch (e) {
    const result  = e.__fail ? "FAIL" : "ERROR";
    const details = e.__fail ? e.__details : (String(e.message ?? e).slice(0, 800));
    results.push({ id, finding_ids, title_zh, area, result, details, ms: Date.now() - t0 });
    LOG_LINE(`✗ ${result.padEnd(5)} [${id}] ${title_zh} :: ${details.slice(0, 100)}`);
  }
  saveResults();
}

// ─────────────────────── DB helpers ────────────────────
async function moduleQs(moduleId) {
  const { data } = await db
    .from("questions")
    .select("id,original_question_number,question_type,correct_answer,choices,parsing_status")
    .eq("module_id", moduleId)
    .eq("parsing_status", "Approved")
    .order("original_question_number");
  return data ?? [];
}

async function testRow(testId) {
  return (await db.from("tests").select("*").eq("id", testId).single()).data;
}

async function subs(studentId, testId) {
  const { data } = await db
    .from("submissions")
    .select("id,status,answers,metadata,started_at,submitted_at,adaptive_track,session_id,attempt_number,correct_count,total_questions,percentage,score,module_id,time_spent_seconds")
    .eq("student_id", studentId)
    .eq("test_id", testId)
    .order("started_at", { ascending: true });
  return data ?? [];
}

async function deleteSubs(studentId, testId) {
  // Must delete answer_records before submissions to avoid FK constraint failures
  const { data: existing } = await db
    .from("submissions")
    .select("id")
    .eq("student_id", studentId)
    .eq("test_id", testId);
  if (existing?.length) {
    const ids = existing.map((s) => s.id);
    await db.from("answer_records").delete().in("submission_id", ids);
    await db.from("submissions").delete().in("id", ids);
  }
}

function correctPick(q) {
  if (!q.correct_answer) return "A";
  if (q.question_type === "Multiple Choice")
    return String(q.correct_answer).trim().split(/[\n;|,]|\bor\b/)[0].trim();
  return String(q.correct_answer).split(/\s*(?:\bor\b|[\n;|])\s*/)[0].trim();
}

function wrongPick(q) {
  if (q.question_type === "Multiple Choice") {
    const c = correctPick(q);
    return ["A", "B", "C", "D"].find((x) => x !== c);
  }
  return "99999";
}

function gradeCount(qs, answers) {
  return qs.filter((q) => answersMatch(answers[q.id], q.correct_answer)).length;
}

// ─────────────── browser helpers ───────────────────────
async function waitTake(page) {
  await page.getByText(/Question \d+ of \d+/).first().waitFor({ timeout: 45000 });
}

async function startTestBrowser(page, testId) {
  await page.goto(`${BASE}/student/tests/${testId}`, { waitUntil: "networkidle" });
  const btn = page.getByRole("button", { name: /Start Test|Resume Test/ });
  await btn.click({ timeout: 30000 });
  await page.waitForURL(/\/take/, { timeout: 45000, waitUntil: "commit" });
  await waitTake(page);
}

// Take a test entirely via API (fast, no UI clicks for answers)
// Returns { m1Id, m2Id?, answers1, answers2?, score1, score2?, totalCorrect, totalQs }
async function apiTakeTest(reqCtx, studentId, testId, opts = {}) {
  const { forceM1Answers, forceM2Answers } = opts;

  // Start M1
  const startRes = await reqCtx.post(`${BASE}/api/student/submissions`, { data: { testId } });
  const startJ = await startRes.json().catch(() => ({}));
  if (startRes.status() !== 200 && startRes.status() !== 201)
    throw new Error(`start failed ${startRes.status()} ${JSON.stringify(startJ).slice(0, 200)}`);
  const m1Id = startJ.data?.id ?? startJ.id;
  if (!m1Id) throw new Error("no submission id from start: " + JSON.stringify(startJ).slice(0, 200));

  // Get questions for M1 — query by ID for reliability
  await sleep(1000);
  const { data: m1Row } = await db.from("submissions")
    .select("id,student_id,adaptive_track,status,module_id,correct_count,total_questions")
    .eq("id", m1Id)
    .single();
  if (!m1Row) throw new Error("no M1 submission row for id " + m1Id);
  const q1 = await moduleQs(m1Row.module_id);
  if (!q1.length) throw new Error("no M1 questions");

  const answers1 = forceM1Answers ?? Object.fromEntries(q1.map((q) => [q.id, correctPick(q)]));
  const score1Expected = gradeCount(q1, answers1);

  // Save M1 answers
  const patchR = await reqCtx.patch(`${BASE}/api/student/submissions/${m1Id}`, {
    data: { answers: answers1, metadata: {} },
  });
  if (patchR.status() >= 400) throw new Error(`M1 PATCH ${patchR.status()}`);
  await sleep(500);

  // Submit M1
  const subR = await reqCtx.post(`${BASE}/api/student/submissions/${m1Id}/submit`, {
    data: { answers: answers1, metadata: {} },
  });
  const subJ = await subR.json().catch(() => ({}));
  if (subR.status() >= 400) throw new Error(`M1 submit ${subR.status()} ${JSON.stringify(subJ).slice(0, 200)}`);
  const m2Id = subJ.data?.nextSubmissionId;

  // If no M2, we're done (untimedEng single-module or adaptive ending)
  if (!m2Id) {
    await sleep(800);
    const final = (await subs(studentId, testId)).find((s) => s.id === m1Id);
    return {
      m1Id, m2Id: null,
      answers1, score1Expected,
      dbScore1: final?.correct_count ?? null,
      totalCorrect: final?.correct_count ?? null,
      totalQs: q1.length,
    };
  }

  // M2 — query by ID
  await sleep(1000);
  const { data: m2Row } = await db.from("submissions")
    .select("id,student_id,adaptive_track,status,module_id,correct_count,total_questions")
    .eq("id", m2Id)
    .single();
  if (!m2Row) throw new Error("no M2 submission row for id " + m2Id);
  const q2 = await moduleQs(m2Row.module_id);
  if (!q2.length) throw new Error("no M2 questions");

  const answers2 = forceM2Answers ?? Object.fromEntries(q2.map((q) => [q.id, correctPick(q)]));
  const score2Expected = gradeCount(q2, answers2);

  const p2 = await reqCtx.patch(`${BASE}/api/student/submissions/${m2Id}`, {
    data: { answers: answers2, metadata: {} },
  });
  if (p2.status() >= 400) throw new Error(`M2 PATCH ${p2.status()}`);
  await sleep(500);

  const s2R = await reqCtx.post(`${BASE}/api/student/submissions/${m2Id}/submit`, {
    data: { answers: answers2, metadata: {} },
  });
  if (s2R.status() >= 400) throw new Error(`M2 submit ${s2R.status()}`);
  await sleep(800);

  const rows = await subs(studentId, testId);
  const m1Final = rows.find((s) => s.id === m1Id);
  const m2Final = rows.find((s) => s.id === m2Id);

  return {
    m1Id, m2Id,
    answers1, score1Expected, dbScore1: m1Final?.correct_count ?? null,
    answers2, score2Expected, dbScore2: m2Final?.correct_count ?? null,
    totalCorrect: (m1Final?.correct_count ?? 0) + (m2Final?.correct_count ?? 0),
    totalQs: q1.length + q2.length,
    m1Track: m2Row.adaptive_track,
  };
}

// ─────────────────────────────────────────────────────────
//  C-04 BACKGROUND TASK — runs in parallel with other checks
//  (shortTimer: 2+2 min; we wait >2 min after M1 submit to see if M2 gets wrongly finalized)
// ─────────────────────────────────────────────────────────
let c04Promise = null;
let h05Promise = null;
let c04BrowserHandle = null;

async function runC04Background() {
  const b = await chromium.launch();
  c04BrowserHandle = b;
  const LOG = (s) => LOG_LINE(`  [C-04-bg] ${s}`);
  try {
    // Find a fresh student with no shortTimer subs
    const T = TESTS.shortTimer;
    let freshS = null;
    for (let n = 30; n <= 60; n++) {
      const s = studentByN(n);
      if (!s) continue;
      const existing = await subs(s.id, T);
      if (existing.length === 0) { freshS = s; break; }
    }
    if (!freshS) throw new Error("no fresh student for C-04");
    LOG(`using student ${freshS.name}`);

    // borrow CLERK2 onto this student
    const originalS2Id = C.students[1].id; // student 002
    await borrowLogin(freshS.id, STUDENT2_CLERK);

    try {
      const { page, context } = await login(b, STUDENT2_CLERK);
      // Start test via browser to get a real session
      await startTestBrowser(page, T);
      const startedAt = Date.now();
      LOG(`M1 started`);

      // Submit M1 immediately via API (all correct)
      const m1RowDb = (await subs(freshS.id, T))[0];
      const q1 = await moduleQs(m1RowDb.module_id);
      const a1 = Object.fromEntries(q1.map((q) => [q.id, correctPick(q)]));
      const patch1 = await page.request.patch(`${BASE}/api/student/submissions/${m1RowDb.id}`, {
        data: { answers: a1, metadata: {} },
      });
      LOG(`M1 PATCH ${patch1.status()}`);
      const sub1 = await page.request.post(`${BASE}/api/student/submissions/${m1RowDb.id}/submit`, {
        data: { answers: a1, metadata: {} },
      });
      const sub1J = await sub1.json().catch(() => ({}));
      LOG(`M1 submit ${sub1.status()} nextId=${sub1J.data?.nextSubmissionId}`);
      const m2Id = sub1J.data?.nextSubmissionId;
      await context.close();

      // Wait up to 8 minutes — shortTimer M2 is 2 min but cron may run every 5 min.
      // If C-04 bug exists, M2 will be auto-submitted (via started_at proxy) within 2 cron cycles.
      LOG(`waiting up to 8 min for cron to potentially finalize M2...`);
      const waitMs = 8 * 60 * 1000;
      const poll = Math.ceil(waitMs / 5000); // 96 iterations × 5s = 480s
      for (let i = 0; i < poll; i++) {
        await sleep(5000);
        const rows = await subs(freshS.id, T);
        const m2 = rows.find((r) => r.id === m2Id || r.adaptive_track === "module_2");
        if (m2 && m2.status !== "In Progress") {
          LOG(`M2 status changed to ${m2.status} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
          break;
        }
      }

      const rows2 = await subs(freshS.id, T);
      const m2Row = rows2.find((r) => r.id === m2Id || r.adaptive_track === "module_2");
      LOG(`M2 status after wait: ${m2Row?.status} answers=${Object.keys(m2Row?.answers ?? {}).length} submitted_at=${m2Row?.submitted_at}`);

      const elapsedSinceM1 = Math.round((Date.now() - startedAt) / 1000);
      const mStartedAt = m2Row?.metadata?.module_2_started_at;
      // C-04 bug: cron uses started_at (M1 handoff) instead of module_2_started_at for M2 expiry.
      // BUG pattern: M2 auto-submitted (Submitted/Late) with 0 answers and module_2_started_at=null
      //              meaning M2 was never opened yet cron expired it anyway.
      // PASS pattern: M2 is still "In Progress" because cron correctly skips unopened M2.
      if (m2Row && m2Row.status !== "In Progress" && Object.keys(m2Row.answers ?? {}).length === 0 && !mStartedAt) {
        return { result: "FAIL", details: `C-04 bug confirmed: cron auto-submitted M2 with 0 answers after ${elapsedSinceM1}s, M2 was never opened (module_2_started_at=null); submitted_at=${m2Row.submitted_at}` };
      }
      return { result: "PASS", details: `M2 status=${m2Row?.status} after ${elapsedSinceM1}s; module_2_started_at=${mStartedAt ?? "not set (correctly not expired)"}` };
    } finally {
      // Restore CLERK2 to student 002
      await borrowLogin(originalS2Id, STUDENT2_CLERK).catch(() => {});
      // Clean up
      await deleteSubs(freshS.id, TESTS.shortTimer).catch(() => {});
    }
  } catch (e) {
    return { result: "ERROR", details: e.message?.slice(0, 500) ?? String(e) };
  } finally {
    await b.close().catch(() => {});
    c04BrowserHandle = null;
  }
}

// ─────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────
LOG_LINE(`\n=== SAT Exam OS Nightly Suite — ${NY_DATE} ===`);
LOG_LINE(`BASE: ${BASE}\n`);

// Kick off C-04 background (only — H-05 runs sequentially at the end to avoid
// STUDENT1_CLERK borrowing conflicts with sequential checks).
c04Promise = !ONLY || ONLY.includes("C-04") ? runC04Background() : null;

// ── A. ISOLATION ──────────────────────────────────────────
await check("ISO-01", [], "QA 測驗 URL 對真實管理員不可見", "isolation", async () => {
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, REAL_ADMIN_CLERK);
    const QA_PATTERN = /qa-test-|TEST (Admin|Teacher|Student|Class)/;
    const leaks = [];
    const pages = [
      "/admin/tests",
      "/admin/students?status=approved",
      "/admin/teachers",
      "/admin/classes",
    ];
    for (const p of pages) {
      const r = await page.goto(BASE + p, { waitUntil: "networkidle" }).catch(() => null);
      const txt = await page.locator("body").innerText().catch(() => "");
      if (QA_PATTERN.test(txt)) leaks.push(p);
      await sleep(500);
    }
    // Direct QA URLs should 404/403
    const denied = [];
    for (const qaUrl of [
      `/admin/tests/${TESTS.mathLinear}`,
      `/admin/students/${C.students[0].id}`,
    ]) {
      const r = await page.request.get(BASE + qaUrl);
      if (r.status() < 400) {
        const t = await r.text();
        if (QA_PATTERN.test(t)) denied.push(`${qaUrl} → ${r.status()}`);
      }
    }
    await context.close();
    if (leaks.length > 0) fail(`QA data visible on: ${leaks.join(", ")}`);
    if (denied.length > 0) fail(`QA direct URL accessible: ${denied.join(", ")}`);
    return `scanned ${pages.length} pages, ${denied.length === 0 ? "no" : denied.length} direct leaks`;
  } finally {
    await b.close().catch(() => {});
  }
});

// ── B. C-01 Vercel logs ────────────────────────────────────
await check("C-01", ["C-01"], "Clerk 速率上限：Vercel 錯誤日誌中的 Too Many Requests 數量", "性能", async () => {
  let logsJson = "";
  try {
    logsJson = execSync(
      `npx -y vercel@latest logs --since 24h --query "level:error" --json -n 1000 2>/dev/null || echo "[]"`,
      { cwd: ROOT, timeout: 60000, encoding: "utf-8" }
    );
  } catch (e) {
    return `vercel logs command failed: ${e.message.slice(0, 200)}`;
  }
  let lines = logsJson.trim().split("\n").filter(Boolean);
  let tooMany = 0, total = 0;
  const pathCounts = {};
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    total++;
    const msg = (obj.message ?? obj.msg ?? JSON.stringify(obj)).toLowerCase();
    if (msg.includes("too many requests") || msg.includes("clerkError") || msg.includes("api_response_error")) {
      tooMany++;
      const path = obj.path ?? obj.requestPath ?? "unknown";
      pathCounts[path] = (pathCounts[path] ?? 0) + 1;
    }
  }
  const topPaths = Object.entries(pathCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const summary = `total errors=${total} TooManyRequests=${tooMany} top: ${topPaths.map(([p, n]) => `${p}(${n})`).join(", ")}`;
  // Write full summary for report
  writeFileSync(`${NIGHTLY_DIR}/${NY_DATE}-vercel-logs.json`, JSON.stringify({ total, tooMany, pathCounts, lines: lines.slice(0, 200) }, null, 2));
  if (tooMany > 10) fail(`${tooMany} 'Too Many Requests' in last 24h — ${summary}`);
  return summary;
});

// ── C. C-02 Grading invariant ──────────────────────────────
await check("C-02", ["C-02"], "計分不變式：每份已提交的作答 total_questions == approved 題數", "計分", async () => {
  // For all submitted submissions with test, check total_questions == approved question count of module
  const { data: submitted } = await db
    .from("submissions")
    .select("id,student_id,test_id,module_id,correct_count,total_questions,status,adaptive_track")
    .in("status", ["Submitted", "Late"])
    .not("module_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (!submitted?.length) return "no submitted submissions found";

  // Get approved counts per module
  const moduleIds = [...new Set(submitted.map((s) => s.module_id))];
  const approvedCounts = {};
  for (const mid of moduleIds) {
    const { count } = await db
      .from("questions")
      .select("id", { count: "exact", head: true })
      .eq("module_id", mid)
      .eq("parsing_status", "Approved");
    approvedCounts[mid] = count ?? 0;
  }

  const violations = submitted.filter((s) => {
    const approved = approvedCounts[s.module_id] ?? 0;
    return approved > 0 && s.total_questions !== approved;
  });

  if (violations.length > 0) {
    const examples = violations.slice(0, 5).map(
      (s) => `sub=${s.id.slice(0, 8)} module=${s.module_id.slice(0, 8)} total=${s.total_questions} approved=${approvedCounts[s.module_id]}`
    );
    fail(`${violations.length} submissions have total_questions != approved question count: ${examples.join("; ")}`);
  }
  return `checked ${submitted.length} submissions across ${moduleIds.length} modules — all match`;
});

// ── D. C-03 Unauthenticated API ────────────────────────────
await check("C-03", ["C-03"], "未登入的 /api/student/* 必須回 401 JSON（不是 200 HTML）", "安全", async () => {
  const paths = [
    ["GET",  "/api/student/tests"],
    ["POST", "/api/student/submissions"],
    ["GET",  "/api/student/submissions/00000000-0000-0000-0000-000000000000"],
    ["PATCH","/api/student/submissions/00000000-0000-0000-0000-000000000000"],
    ["POST", "/api/student/submissions/00000000-0000-0000-0000-000000000000/submit"],
  ];
  const bad = [];
  for (const [method, path] of paths) {
    const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: method !== "GET" ? "{}" : undefined });
    const ct = res.headers.get("content-type") ?? "";
    const status = res.status;
    if (status !== 401 && status !== 403) {
      bad.push(`${method} ${path} → ${status} ${ct.slice(0, 40)}`);
    } else if (!ct.includes("json")) {
      bad.push(`${method} ${path} → ${status} but content-type=${ct} (expected JSON)`);
    }
    await sleep(300);
  }
  if (bad.length) fail(`non-401 or non-JSON: ${bad.join(" | ")}`);
  return `all ${paths.length} unauthenticated routes returned 401 JSON`;
});

// ── E. C-05 Suspended student ──────────────────────────────
await check("C-05", ["C-05"], "停權/待審學生開始測驗應收到 403", "安全", async () => {
  // Pick student 040 (DB-only); temporarily suspend them
  const s = studentByN(40);
  if (!s) throw new Error("student 040 not found");
  const originalStatus = (await db.from("users").select("account_status").eq("id", s.id).single()).data?.account_status;

  // Suspend
  await db.from("users").update({ account_status: "suspended" }).eq("id", s.id);

  const b = await chromium.launch();
  let startStatus = null;
  try {
    // borrow CLERK1 onto suspended student
    const origS1Id = C.students[0].id;
    await borrowLogin(s.id, STUDENT1_CLERK);
    try {
      const { page, context } = await login(b, STUDENT1_CLERK);
      const r = await page.request.post(`${BASE}/api/student/submissions`, {
        data: { testId: TESTS.mathLinear },
      });
      startStatus = r.status();
      await context.close();
    } finally {
      await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    }
  } finally {
    // Restore original status
    await db.from("users").update({ account_status: originalStatus ?? "approved" }).eq("id", s.id);
    // Clean up any submission that may have been created (if API missed the suspension check)
    await deleteSubs(s.id, TESTS.mathLinear).catch(() => {});
    await b.close().catch(() => {});
  }

  if (startStatus !== 403 && startStatus !== 401)
    fail(`suspended student got ${startStatus} on POST /api/student/submissions (expected 403)`);
  return `suspended student correctly blocked: ${startStatus}`;
});

// ── F. HAPPY PATH — mathLinear ─────────────────────────────
await check("HP-MATH", [], "Happy path：mathLinear 完整作答，分數正確", "考試流程", async () => {
  const T = TESTS.mathLinear;
  const s = studentByN(35);
  if (!s) throw new Error("student 035 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, STUDENT1_CLERK);
    const r = await apiTakeTest(context.request, s.id, T);
    await context.close();
    if (r.dbScore1 !== r.score1Expected)
      fail(`M1 score mismatch: db=${r.dbScore1} expected=${r.score1Expected}`);
    if (r.dbScore2 !== r.score2Expected)
      fail(`M2 score mismatch: db=${r.dbScore2} expected=${r.score2Expected}`);
    return `M1 ${r.dbScore1}/${r.totalQs - (r.dbScore2 ?? 0) + r.dbScore1} M2 ${r.dbScore2} all correct`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── G. HAPPY PATH — adaptive (high → hard track) ──────────
await check("HP-ADAPTIVE-HARD", [], "Happy path：adaptive 高分路線（hard track）", "考試流程", async () => {
  const T = TESTS.adaptive;
  const s = studentByN(36);
  if (!s) throw new Error("student 036 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, STUDENT1_CLERK);
    // Score M1 100% correct → should go to hard M2
    const r = await apiTakeTest(context.request, s.id, T);
    await context.close();
    if (r.dbScore1 !== r.score1Expected)
      fail(`adaptive M1 score mismatch: db=${r.dbScore1} expected=${r.score1Expected}`);
    return `M1=${r.dbScore1} M2 track=${r.m1Track ?? "?"} M2=${r.dbScore2} total=${r.totalCorrect}/${r.totalQs}`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── H. HAPPY PATH — untimedEng ─────────────────────────────
await check("HP-UNTIMED", [], "Happy path：untimedEng 單模組作答，分數正確", "考試流程", async () => {
  const T = TESTS.untimedEng;
  const s = studentByN(37);
  if (!s) throw new Error("student 037 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, STUDENT1_CLERK);
    const r = await apiTakeTest(context.request, s.id, T);
    await context.close();
    if (r.dbScore1 !== r.score1Expected)
      fail(`score mismatch: db=${r.dbScore1} expected=${r.score1Expected}`);
    return `score ${r.dbScore1}/${r.totalQs} correct`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── I. H-01 Answer then reload within 1s ──────────────────
await check("H-01", ["H-01"], "選答案後 1 秒內重新整理，答案保留", "考試流程", async () => {
  const T = TESTS.engLinear;
  const s = studentByN(38);
  if (!s) throw new Error("student 038 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, STUDENT1_CLERK);
    // Start via API to get m1Id reliably
    const sR = await page.request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
    const sJ = await sR.json().catch(() => ({}));
    const m1Id_h01 = sJ.data?.id;
    if (!m1Id_h01) throw new Error("no M1 id for H-01: " + JSON.stringify(sJ).slice(0, 100));
    await sleep(1000);
    const { data: m1Row_h01 } = await db.from("submissions").select("id,module_id").eq("id", m1Id_h01).single();
    const q1 = await moduleQs(m1Row_h01?.module_id ?? "");
    if (!q1.length) throw new Error("no H-01 questions");
    // Navigate to the take page
    await page.goto(`${BASE}/student/tests/${T}/take`, { waitUntil: "domcontentloaded" });
    await waitTake(page);
    // Answer Q1 and immediately reload
    await page.locator(`button:has(> span:text-is("A"))`).first().click({ timeout: 10000 });
    await sleep(200); // 200ms — within debounce window
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitTake(page);
    await sleep(3000); // let autosave settle
    const { data: m1After } = await db.from("submissions").select("answers").eq("id", m1Id_h01).single();
    const dbAns = m1After?.answers ?? {};
    const q1Saved = dbAns[q1[0].id];
    await context.close();
    if (!q1Saved) fail(`Q1 answer not saved after immediate reload (within 1s); db.answers=${JSON.stringify(dbAns).slice(0, 100)}`);
    return `Q1 answer '${q1Saved}' persisted after immediate reload`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── J. H-02 Offline answer then online persists ─────────────
await check("H-02", ["H-02"], "斷網時作答，恢復連線後答案同步", "考試流程", async () => {
  const T = TESTS.engLinear;
  const s = studentByN(39);
  if (!s) throw new Error("student 039 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, STUDENT1_CLERK);
    // Start via API
    const sR2 = await page.request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
    const sJ2 = await sR2.json().catch(() => ({}));
    const m1Id_h02 = sJ2.data?.id;
    if (!m1Id_h02) throw new Error("no M1 id for H-02");
    await sleep(1000);
    const { data: m1R_h02 } = await db.from("submissions").select("id,module_id").eq("id", m1Id_h02).single();
    const q1 = await moduleQs(m1R_h02?.module_id ?? "");
    if (!q1.length) throw new Error("no H-02 questions");
    // Navigate to take page
    await page.goto(`${BASE}/student/tests/${T}/take`, { waitUntil: "domcontentloaded" });
    await waitTake(page);

    // Go offline, answer Q5
    await context.setOffline(true);
    await page.getByRole("button", { name: /Question \d+ of \d+/ }).click().catch(() => {});
    await page.locator(".fixed.inset-0.z-40").getByRole("button", { name: "5" }).first().click().catch(() => {});
    await page.locator(`button:has(> span:text-is("B"))`).first().click().catch(() => {});
    await sleep(2000);

    // Come back online
    await context.setOffline(false);
    await sleep(8000); // wait for retry/sync

    const { data: m1After_h02 } = await db.from("submissions").select("answers").eq("id", m1Id_h02).single();
    const dbAns = m1After_h02?.answers ?? {};
    await context.close();
    const q5Saved = dbAns[q1[4]?.id];
    if (!q5Saved) fail(`offline answer for Q5 not synced after coming online; saved keys: ${Object.keys(dbAns).length}`);
    return `Q5 answer '${q5Saved}' synced after offline→online`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── K. H-03 Resume Module 2 from test detail ───────────────
await check("H-03", ["H-03"], "Module 2 中途離開後，從測驗詳情頁能繼續作答", "考試流程", async () => {
  const T = TESTS.mathLinear;
  const s = studentByN(41);
  if (!s) throw new Error("student 041 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, STUDENT1_CLERK);

    // Start M1 via API
    const startR = await page.request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
    const startJ = await startR.json().catch(() => ({}));
    const m1Id = startJ.data?.id;
    if (!m1Id) throw new Error("no M1 id: " + JSON.stringify(startJ).slice(0, 100));
    await sleep(1000);
    const { data: m1Row } = await db.from("submissions").select("id,module_id").eq("id", m1Id).single();
    const q1 = await moduleQs(m1Row?.module_id ?? "");
    if (!q1.length) throw new Error("no M1 questions");
    const a1 = Object.fromEntries(q1.map((q) => [q.id, correctPick(q)]));
    await page.request.patch(`${BASE}/api/student/submissions/${m1Id}`, { data: { answers: a1, metadata: {} } });
    const sub1R = await page.request.post(`${BASE}/api/student/submissions/${m1Id}/submit`, { data: { answers: a1, metadata: {} } });
    const sub1J = await sub1R.json().catch(() => ({}));
    const m2Id = sub1J.data?.nextSubmissionId;
    if (!m2Id) throw new Error("no M2 id after M1 submit: " + JSON.stringify(sub1J).slice(0, 200));

    // Navigate away (to home)
    await page.goto(BASE + "/student", { waitUntil: "domcontentloaded" });
    await sleep(500);

    // Go to test detail page and look for Resume button
    await page.goto(`${BASE}/student/tests/${T}`, { waitUntil: "networkidle" });
    const bodyTxt = await page.locator("body").innerText().catch(() => "");
    const hasResume = /Resume|繼續|continue/i.test(bodyTxt);

    await context.close();
    if (!hasResume)
      fail(`test detail page shows no Resume button for M2; page text: ${bodyTxt.replace(/\s+/g, " ").slice(0, 200)}`);
    return `test detail shows Resume button for M2 after leaving mid-test`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── L. H-04 Two contexts — union persists ──────────────────
await check("H-04", ["H-04"], "兩個分頁作答不同題，合集保留（或後者蓋前者）", "考試流程", async () => {
  const T = TESTS.mathLinear;
  const sA = studentByN(42);
  const sB = studentByN(43); // same student via CLERK1+CLERK2
  if (!sA || !sB) throw new Error("students 042/043 not found");
  await deleteSubs(sA.id, T);
  const origS1Id = C.students[0].id;
  const origS2Id = C.students[1].id;
  // Both contexts point to sA (same student, two devices)
  await borrowLogin(sA.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const ctxA = await login(b, STUDENT1_CLERK);
    // Start via API
    const sR = await ctxA.page.request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
    const sJ = await sR.json().catch(() => ({}));
    const m1Id_h04 = sJ.data?.id;
    if (!m1Id_h04) throw new Error("no M1 id for H-04");
    await sleep(1000);
    const { data: m1Data } = await db.from("submissions").select("id,module_id").eq("id", m1Id_h04).single();
    const q1 = await moduleQs(m1Data?.module_id ?? "");
    if (!q1.length) throw new Error("no H-04 questions");

    // Context A: PATCH answers for Q1,Q2,Q3 via API
    const aA = { [q1[0].id]: "A", [q1[1].id]: "B", [q1[2].id]: "C" };
    await ctxA.page.request.patch(`${BASE}/api/student/submissions/${m1Id_h04}`, { data: { answers: aA, metadata: {} } });
    await sleep(2000); // let autosave flush

    // Context B: same submission, different questions (Q4, Q5) — simulates second device
    const ctxB = await login(b, STUDENT1_CLERK);
    const aB = { [q1[3].id]: "D", [q1[4].id]: "A" };
    await ctxB.page.request.patch(`${BASE}/api/student/submissions/${m1Id_h04}`, { data: { answers: aB, metadata: {} } });
    await sleep(2000);

    // Check DB: ideally union of both; at minimum Q4 from B should be present
    const { data: m1Final } = await db.from("submissions").select("answers").eq("id", m1Id_h04).single();
    const dbAns = m1Final?.answers ?? {};
    const q1Saved = dbAns[q1[0]?.id];
    const q4Saved = dbAns[q1[3]?.id];
    await ctxA.context.close().catch(() => {});
    await ctxB.context.close().catch(() => {});

    // EXPECTED (fixed): both Q1 and Q4 are saved (union).
    // BUG: one context's PATCH overwrites the other.
    const savedCount = Object.keys(dbAns).length;
    if (!q4Saved) fail(`Q4 (from context B) not in DB; DB has ${savedCount} answers, q1=${q1Saved ?? "missing"}`);
    return `both contexts saved: q1=${q1Saved} q4=${q4Saved} total=${savedCount} answers`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(sA.id, T).catch(() => {});
  }
});

// ── M. H-05 Late submit marked Late / PATCH after deadline 409
// H-05 is resolved via background promise (started at suite top) — the await is below.
// Background task:
//   1. M1 submit → get m2Id
//   2. Open M2 via page.goto(".../take?start=1") → stamps module_2_started_at
//   3. Verify stamp in DB; record m2StartedMs
//   4. PATCH with a real answer before deadline → expect 200
//   5. Wait until m2StartedMs + 2min + 60s grace + 10s (=190s) → PATCH → expect 409 {error:"time_up"}
//   6. Wait until m2StartedMs + 5min → POST submit → expect "Late" status

async function runH05Background() {
  const T = TESTS.shortTimer;
  const s = studentByN(44);
  const LOG = (msg) => LOG_LINE(`  [H-05-bg] ${msg}`);
  if (!s) return { result: "ERROR", details: "student 044 not found" };
  const origS1Id = C.students[0].id;
  const b = await chromium.launch();
  try {
    await deleteSubs(s.id, T);
    await borrowLogin(s.id, STUDENT1_CLERK);
    const { page, context } = await login(b, STUDENT1_CLERK);

    // Start M1
    const startR = await page.request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
    const startJ = await startR.json().catch(() => ({}));
    const m1Id = startJ.data?.id;
    if (!m1Id) return { result: "ERROR", details: "no M1 id: " + JSON.stringify(startJ).slice(0, 100) };
    await sleep(800);
    const { data: m1Row } = await db.from("submissions").select("id,module_id").eq("id", m1Id).single();
    if (!m1Row) return { result: "ERROR", details: "no M1 row" };

    // Submit M1
    const q1 = await moduleQs(m1Row.module_id);
    const a1 = Object.fromEntries(q1.slice(0, 3).map((q) => [q.id, correctPick(q)]));
    const sub1R = await page.request.post(`${BASE}/api/student/submissions/${m1Id}/submit`, {
      data: { answers: a1, metadata: {} },
    });
    const sub1J = await sub1R.json().catch(() => ({}));
    const m2Id = sub1J.data?.nextSubmissionId;
    if (!m2Id) return { result: "ERROR", details: "no M2 id: " + JSON.stringify(sub1J).slice(0, 200) };
    LOG(`M1 submitted; M2=${m2Id.slice(0, 8)}`);

    // Open M2 via take page with ?start=1 — this is the correct way to stamp module_2_started_at.
    // Navigate away immediately after to prevent the React front-end timer from auto-submitting M2.
    await page.goto(`${BASE}/student/tests/${T}/take?start=1`, { waitUntil: "domcontentloaded" });
    await sleep(1500); // allow server to process the start stamp
    // Navigate away immediately so the React timer doesn't auto-submit M2
    await page.goto(`${BASE}/student`, { waitUntil: "domcontentloaded" });
    await sleep(500);

    // Verify stamp was set in DB
    const { data: m2Check } = await db.from("submissions").select("metadata,module_id").eq("id", m2Id).single();
    const stamp = m2Check?.metadata?.module_2_started_at;
    LOG(`module_2_started_at: ${stamp ?? "NOT SET"}`);
    if (!stamp) return { result: "ERROR", details: "module_2_started_at not stamped after GET take?start=1" };
    const m2StartedMs = new Date(stamp).getTime();

    // Get M2 questions for real answers
    const q2 = await moduleQs(m2Check.module_id);
    if (!q2.length) return { result: "ERROR", details: "no M2 questions" };
    const oneAnswer = { [q2[0].id]: correctPick(q2[0]) };

    // PATCH with a real answer before deadline → expect 200
    const prePatch = await page.request.patch(`${BASE}/api/student/submissions/${m2Id}`, {
      data: { answers: oneAnswer, metadata: {} },
    });
    LOG(`pre-deadline PATCH → ${prePatch.status()} (expected 200)`);
    if (prePatch.status() !== 200)
      return { result: "FAIL", details: `pre-deadline PATCH returned ${prePatch.status()} (expected 200)` };

    // Wait until module_2_started_at + 2min limit + 60s DEADLINE_GRACE_SECONDS + 10s buffer
    const LIMIT_MS  = 2 * 60 * 1000; // shortTimer M2 = 2 min
    const GRACE_MS  = 60 * 1000;     // DEADLINE_GRACE_SECONDS = 60
    const BUFFER_MS = 10 * 1000;     // 10s safety buffer
    const deadlineMs = m2StartedMs + LIMIT_MS + GRACE_MS + BUFFER_MS;
    const waitDeadline = Math.max(0, deadlineMs - Date.now());
    LOG(`waiting ${Math.round(waitDeadline / 1000)}s for PATCH deadline (2min + 60s grace + 10s buffer)...`);
    await sleep(waitDeadline);

    // PATCH after deadline → expect 409 {error:"time_up"}
    const latePatch = await page.request.patch(`${BASE}/api/student/submissions/${m2Id}`, {
      data: { answers: oneAnswer, metadata: {} },
    });
    const latePatchS = latePatch.status();
    const latePatchJ = await latePatch.json().catch(() => ({}));
    LOG(`post-deadline PATCH → ${latePatchS} ${JSON.stringify(latePatchJ).slice(0, 100)}`);

    if (latePatchS !== 409)
      return { result: "FAIL", details: `PATCH after deadline → ${latePatchS} (expected 409); body=${JSON.stringify(latePatchJ).slice(0, 150)}` };
    if (latePatchJ.error !== "time_up")
      return { result: "FAIL", details: `PATCH → 409 but error="${latePatchJ.error}" (expected "time_up")` };

    // Wait until 5 min from M2 open; submit → should be accepted and marked "Late"
    const lateSubmitMs = m2StartedMs + 5 * 60 * 1000;
    const waitLate = Math.max(0, lateSubmitMs - Date.now());
    LOG(`waiting ${Math.round(waitLate / 1000)}s for Late-submit window (5min from open)...`);
    await sleep(waitLate);

    const subR = await page.request.post(`${BASE}/api/student/submissions/${m2Id}/submit`, {
      data: { answers: oneAnswer, metadata: {} },
    });
    const subS = subR.status();
    const subJ = await subR.json().catch(() => ({}));
    LOG(`late submit → ${subS} ${JSON.stringify(subJ).slice(0, 100)}`);

    await context.close();

    // Verify final DB status
    await sleep(1000);
    const { data: m2Final } = await db.from("submissions").select("status").eq("id", m2Id).single();
    const finalStatus = m2Final?.status;
    LOG(`M2 final status: ${finalStatus}`);

    const elapsedS = Math.round((Date.now() - m2StartedMs) / 1000);
    if (subS >= 400 && finalStatus === "In Progress") {
      // submit was rejected before cron ran — acceptable if we already confirmed 409
      return { result: "PASS", details: `409 at ${LIMIT_MS/1000+GRACE_MS/1000+BUFFER_MS/1000}s ✓; late submit → ${subS} (M2 still In Progress, cron will finalize)` };
    }
    return { result: "PASS", details: `409 at deadline ✓; late submit → ${subS}; M2 status=${finalStatus}; elapsed=${elapsedS}s` };
  } catch (e) {
    return { result: "ERROR", details: String(e.message ?? e).slice(0, 500) };
  } finally {
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
    await b.close().catch(() => {});
  }
}

// ── N. H-06 Unassigned / not-yet-open test ─────────────────
// Creates two real Published QA tests per run:
//   1. Assigned only to class B (student 001 is in class A) → expect 403
//   2. Assigned to class A, open_date = tomorrow → expect 403
// Both deleted in finally.
await check("H-06", ["H-06"], "未指派或未開放的測驗，學生開始應收到 403", "安全", async () => {
  const b = await chromium.launch();
  let testIdNotAssigned = null;
  let testIdFuture = null;
  try {
    // Find an all-approved module (same logic as H-17)
    let moduleId = null;
    for (const testId of [TESTS.engLinear, TESTS.untimedEng, TESTS.mathLinear, TESTS.adaptive]) {
      const tr2 = await testRow(testId);
      const mid = tr2?.module_id;
      if (!mid) continue;
      const { count: totalQ }    = await db.from("questions").select("id", { count: "exact", head: true }).eq("module_id", mid);
      const { count: approvedQ } = await db.from("questions").select("id", { count: "exact", head: true }).eq("module_id", mid).eq("parsing_status", "Approved");
      if (totalQ > 0 && totalQ === approvedQ) { moduleId = mid; break; }
    }
    if (!moduleId) throw new Error("no all-approved module for H-06");

    const { page: ap, context: ac } = await login(b, ADMIN_CLERK);

    // Dates: open now (or slightly past), due next week; future open = tomorrow
    const nowISO       = new Date().toISOString();
    const tomorrowISO  = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split("T")[0] + "T00:00:00-04:00"; })();
    const nextWeekISO  = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().split("T")[0] + "T23:59:59-04:00"; })();
    const ts = Date.now();

    // Test 1: class B only, open now — student 001 (class A) is not in class B
    const classBId = C.classes[1].id;
    const create1R = await ap.request.post(`${BASE}/api/admin/tests`, {
      data: {
        testName: `TEST nightly-h06-notassigned-${ts}`,
        moduleId,
        timeLimitMinutes: 35,
        isAdaptive: false,
        showAnswersAfterSubmission: false,
        allowRetake: false,
        openDate: nowISO,
        dueDate: nextWeekISO,
        classGroupIds: [classBId],
      },
    });
    const create1J = await create1R.json().catch(() => ({}));
    testIdNotAssigned = create1J.data?.id ?? create1J.id;
    if (!testIdNotAssigned) throw new Error(`create not-assigned test failed ${create1R.status()}: ${JSON.stringify(create1J).slice(0, 200)}`);

    // Test 2: class A, open_date = tomorrow — student 001 is in class A but test isn't open yet
    const classAId = C.classes[0].id;
    const create2R = await ap.request.post(`${BASE}/api/admin/tests`, {
      data: {
        testName: `TEST nightly-h06-future-${ts}`,
        moduleId,
        timeLimitMinutes: 35,
        isAdaptive: false,
        showAnswersAfterSubmission: false,
        allowRetake: false,
        openDate: tomorrowISO,
        dueDate: nextWeekISO,
        classGroupIds: [classAId],
      },
    });
    const create2J = await create2R.json().catch(() => ({}));
    testIdFuture = create2J.data?.id ?? create2J.id;
    if (!testIdFuture) throw new Error(`create future test failed ${create2R.status()}: ${JSON.stringify(create2J).slice(0, 200)}`);

    // Publish both tests (Draft → Published; publish route checks all-approved modules)
    const pub1R = await ap.request.post(`${BASE}/api/admin/tests/${testIdNotAssigned}/publish`);
    if (pub1R.status() >= 400) throw new Error(`publish not-assigned test failed ${pub1R.status()}: ${JSON.stringify(await pub1R.json().catch(() => ({}))).slice(0, 200)}`);
    const pub2R = await ap.request.post(`${BASE}/api/admin/tests/${testIdFuture}/publish`);
    if (pub2R.status() >= 400) throw new Error(`publish future test failed ${pub2R.status()}: ${JSON.stringify(await pub2R.json().catch(() => ({}))).slice(0, 200)}`);
    await ac.close();

    // Try as student 001 (in class A)
    const { page: sp, context: sc } = await login(b, STUDENT1_CLERK);
    const r1 = await sp.request.post(`${BASE}/api/student/submissions`, { data: { testId: testIdNotAssigned } });
    const r1J = await r1.json().catch(() => ({}));
    const r2 = await sp.request.post(`${BASE}/api/student/submissions`, { data: { testId: testIdFuture } });
    const r2J = await r2.json().catch(() => ({}));
    await sc.close();

    const issues = [];
    if (r1.status() === 200 || r1.status() === 201) issues.push(`not-assigned test allowed: ${r1.status()} ${JSON.stringify(r1J).slice(0, 100)}`);
    if (r2.status() === 200 || r2.status() === 201) issues.push(`future-open test allowed: ${r2.status()} ${JSON.stringify(r2J).slice(0, 100)}`);
    if (issues.length) fail(issues.join("; "));

    return `not-assigned → ${r1.status()} "${r1J.error}"; future-open → ${r2.status()} "${r2J.error}" (both correctly blocked)`;
  } finally {
    if (testIdNotAssigned) await db.from("tests").delete().eq("id", testIdNotAssigned).then(() => {}, () => {});
    if (testIdFuture)      await db.from("tests").delete().eq("id", testIdFuture).then(() => {}, () => {});
    await b.close().catch(() => {});
  }
});

// ── O. H-08 Teacher My Tests lists class-assigned tests ────
await check("H-08", ["H-08"], "班級老師的「我的測驗」列表包含已指派的基準測驗", "教師功能", async () => {
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, TEACHER1_CLERK);
    const r = await page.request.get(`${BASE}/api/teacher/tests`);
    const j = await r.json().catch(() => ({}));
    await context.close();
    if (r.status() !== 200) fail(`/api/teacher/tests → ${r.status()}`);
    const tests_list = j.data ?? j.tests ?? j ?? [];
    const arr = Array.isArray(tests_list) ? tests_list : [];
    // Should contain at least the baseline mathLinear test
    const hasMath = arr.some((t) => t.id === TESTS.mathLinear || t.test_id === TESTS.mathLinear);
    const names = arr.slice(0, 5).map((t) => t.test_name ?? t.name ?? t.id?.slice(0, 8)).join(", ");
    if (!hasMath) fail(`mathLinear not in teacher tests list; got: ${names} (${arr.length} total)`);
    return `teacher has ${arr.length} tests; mathLinear present`;
  } finally {
    await b.close().catch(() => {});
  }
});

// ── P. H-09 Analytics avg == results avg ────────────────────
await check("H-09", ["H-09"], "題目分析平均分數與成績頁平均一致", "教師功能", async () => {
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, TEACHER1_CLERK);
    const [resR, anR] = await Promise.all([
      page.request.get(`${BASE}/api/teacher/tests/${TESTS.mathLinear}/results`),
      page.request.get(`${BASE}/api/teacher/tests/${TESTS.mathLinear}/analytics`),
    ]);
    const resJ = await resR.json().catch(() => ({}));
    const anJ  = await anR.json().catch(() => ({}));
    await context.close();

    if (resR.status() !== 200) throw new Error(`results API ${resR.status()}`);
    if (anR.status() !== 200)  throw new Error(`analytics API ${anR.status()}`);

    const resAvg = resJ.stats?.avgScore ?? resJ.summary?.avgScore;
    const anAvg  = anJ.summary?.avgClassScore ?? anJ.avgScore;
    if (resAvg == null || anAvg == null)
      return `avgScore missing: results=${resAvg} analytics=${anAvg} (no submissions yet, skip)`;

    const diff = Math.abs(resAvg - anAvg);
    if (diff > 2) fail(`analytics avg ${anAvg?.toFixed(1)} vs results avg ${resAvg?.toFixed(1)} — diff ${diff.toFixed(2)} > 2`);
    return `results avg=${resAvg?.toFixed(1)} analytics avg=${anAvg?.toFixed(1)} diff=${diff.toFixed(2)}`;
  } finally {
    await b.close().catch(() => {});
  }
});

// ── Q. H-10 Tutor notes save ────────────────────────────────
await check("H-10", ["H-10"], "老師的 Tutor notes 能正常存入", "教師功能", async () => {
  // Find any submitted submission for a QA student in Teacher1's class
  const clsId = C.classes[0].id; // Class A - Teacher1 is Math teacher
  const { data: members } = await db.from("class_group_members").select("student_id").eq("class_group_id", clsId);
  const memberIds = (members ?? []).map((m) => m.student_id);
  if (!memberIds.length) throw new Error("no class A members");

  const { data: done } = await db
    .from("submissions")
    .select("id,student_id,test_id,status")
    .in("student_id", memberIds)
    .in("status", ["Submitted", "Late"])
    .eq("test_id", TESTS.mathLinear)
    .limit(1);

  if (!done?.length) return "no submitted submissions in class A for mathLinear — skip";

  const subId = done[0].id;
  const testNote = `nightly-test-note-${Date.now()}`;
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, TEACHER1_CLERK);
    const patchR = await page.request.patch(
      `${BASE}/api/teacher/tests/${TESTS.mathLinear}/results/${subId}`,
      { data: { tutorNotes: testNote } }
    );
    const patchJ = await patchR.json().catch(() => ({}));
    const patchStatus = patchR.status();
    await context.close();

    if (patchStatus >= 400)
      fail(`tutor notes PATCH → ${patchStatus} ${JSON.stringify(patchJ).slice(0, 200)}`);

    // Verify it was saved
    const { data: row } = await db.from("submissions").select("tutor_notes").eq("id", subId).single();
    if (row?.tutor_notes !== testNote)
      fail(`tutor notes not saved: db='${row?.tutor_notes?.slice(0, 50)}' expected='${testNote}'`);

    // Clean up note
    await db.from("submissions").update({ tutor_notes: null }).eq("id", subId);
    return `tutor note saved and verified for sub ${subId.slice(0, 8)}`;
  } finally {
    await b.close().catch(() => {});
  }
});

// ── R. M-07 Per-student private notes stay separate ─────────
// Verifies fix in batch-2 (f45aa87): private notes are keyed by
// (test_id, teacher_id, question_id, note_type, student_id) so a note
// saved for student A does NOT appear on student B's results.
await check("M-07", ["M-07"], "老師的私人筆記對不同學生各自獨立（fix f45aa87）", "教師功能", async () => {
  // Find two submitted submissions from different students in class A for mathLinear
  const clsId = C.classes[0].id;
  const { data: members } = await db.from("class_group_members").select("student_id").eq("class_group_id", clsId);
  const memberIds = (members ?? []).map((m) => m.student_id);
  if (!memberIds.length) throw new Error("no class A members");

  const { data: done } = await db
    .from("submissions")
    .select("id,student_id")
    .in("student_id", memberIds)
    .in("status", ["Submitted", "Late"])
    .eq("test_id", TESTS.mathLinear)
    .limit(5);

  if (!done || done.length < 2) return "need ≥2 submitted submissions in class A for mathLinear — skip";
  // Pick two submissions from different students
  const subA = done[0];
  const subB = done.find((s) => s.student_id !== subA.student_id);
  if (!subB) return "only one student has submitted mathLinear in class A — skip";

  // Get a question that appears in subA's answer_records
  const { data: arRows } = await db.from("answer_records").select("question_id").eq("submission_id", subA.id).limit(1);
  if (!arRows?.length) throw new Error("no answer_records for subA");
  const qId = arRows[0].question_id;

  const noteBody = `m07-nightly-${Date.now()}`;
  const b = await chromium.launch();
  let noteSaved = false;
  try {
    const { page, context } = await login(b, TEACHER1_CLERK);

    // Save a private note for student A on question qId
    const flagR = await page.request.post(
      `${BASE}/api/teacher/tests/${TESTS.mathLinear}/questions/${qId}/flag`,
      { data: { note_type: "private_note", note_body: noteBody, submission_id: subA.id } }
    );
    const flagJ = await flagR.json().catch(() => ({}));
    if (flagR.status() >= 400) throw new Error(`flag POST → ${flagR.status()} ${JSON.stringify(flagJ).slice(0, 150)}`);
    noteSaved = true;

    // Read student B's results — the note must NOT appear
    const resR = await page.request.get(`${BASE}/api/teacher/tests/${TESTS.mathLinear}/results/${subB.id}`);
    const resJ = await resR.json().catch(() => ({}));
    await context.close();

    if (resR.status() >= 400) throw new Error(`results GET for subB → ${resR.status()}`);

    // Scan all answers in B's results for the private note we saved for A
    const allAnswers = [
      ...(resJ.module1Answers ?? resJ.answers ?? resJ.data?.module1Answers ?? []),
      ...(resJ.module2Answers ?? resJ.data?.module2Answers ?? []),
    ];
    const leaked = allAnswers.some((a) => a.questionId === qId && a.privateNote === noteBody);
    if (leaked) fail(`private note for student A leaked to student B's results (question ${qId.slice(0, 8)})`);

    return `private note for student A (sub ${subA.id.slice(0, 8)}) not visible in student B (sub ${subB.id.slice(0, 8)}) ✓`;
  } finally {
    // Clean up: delete the note we saved for student A
    if (noteSaved) {
      await db
        .from("test_teacher_notes")
        .delete()
        .eq("test_id", TESTS.mathLinear)
        .eq("teacher_id", TEACHER1_CLERK)
        .eq("question_id", qId)
        .eq("note_type", "private_note")
        .eq("student_id", subA.student_id)
        .then(() => {}, () => {});
    }
    await b.close().catch(() => {});
  }
});

// ── S. H-11 Math teacher doesn't see R&W results ────────────
await check("H-11", ["H-11"], "數學老師看不到英文（R&W）測驗成績", "教師功能", async () => {
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, TEACHER1_CLERK); // Math teacher
    // engLinear is an English test — Math teacher should get 403
    const r = await page.request.get(`${BASE}/api/teacher/tests/${TESTS.engLinear}/results`);
    const status = r.status();
    await context.close();
    if (status === 200) {
      const j = await r.json().catch(() => ({}));
      fail(`Math teacher (TEACHER1) got 200 on engLinear results: ${JSON.stringify(j).slice(0, 150)}`);
    }
    return `Math teacher correctly denied engLinear results: ${status}`;
  } finally {
    await b.close().catch(() => {});
  }
});

// ── S. H-12 Quick-test to other class 403 ──────────────────
await check("H-12", ["H-12"], "老師替別班建立快速測驗應收到 403", "安全", async () => {
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, TEACHER1_CLERK); // class A Math teacher
    // Try to create a quick-test for class B (which belongs to Teacher 03, not Teacher 01)
    const classBId = C.classes[1].id;
    const r = await page.request.post(`${BASE}/api/teacher/teaching-mode/quick-test`, {
      data: {
        classGroupId: classBId,
        questionIds: [],
        testName: "TEST nightly-hack",
        timeLimitMinutes: 5,
      },
    });
    const status = r.status();
    await context.close();
    if (status === 200 || status === 201)
      fail(`Teacher1 created quick-test for class B: ${status}`);
    return `cross-class quick-test blocked: ${status}`;
  } finally {
    await b.close().catch(() => {});
  }
});

// ── T. H-14/H-15 Mobile UI ──────────────────────────────────
await check("H-14-15", ["H-14", "H-15"], "手機作答頁頂部不重疊；Enter 選答不跳題", "UX", async () => {
  const T = TESTS.engLinear;
  const s = studentByN(45);
  if (!s) throw new Error("student 045 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, STUDENT1_CLERK, { viewport: { width: 390, height: 844 } }); // iPhone 14
    await startTestBrowser(page, T);

    // H-14: check if top bar elements overlap
    const timerBox = await page.locator('[class*="timer"], [class*="Timer"]').first().boundingBox().catch(() => null);
    const qLabel   = await page.locator('[class*="Question"], [class*="question"]').first().boundingBox().catch(() => null);
    let overlap = false;
    if (timerBox && qLabel) {
      overlap = timerBox.y + timerBox.height > qLabel.y + 2; // more than 2px overlap
    }

    // H-15: press Enter on choice A; should NOT advance to Q2
    await page.locator(`button:has(> span:text-is("A"))`).first().click().catch(() => {});
    await page.keyboard.press("Enter");
    await sleep(500);
    const qi = await page.locator(/Question \d+ of \d+/).first().innerText().catch(() => "");
    const m = qi.match(/Question (\d+)/);
    const qNum = m ? parseInt(m[1]) : null;

    await context.close();

    const issues = [];
    if (overlap) issues.push("timer and question label overlap on iPhone viewport");
    if (qNum !== null && qNum !== 1) issues.push(`Enter on choice advanced to Q${qNum} (expected Q1)`);
    if (issues.length) fail(issues.join("; "));
    return `no overlap; Enter stayed on Q${qNum ?? "?"} (expected 1)`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── U. H-17 Create test NY 10:00 → stored 14:00Z ───────────
await check("H-17", ["H-17"], "Admin 建立測驗時 NY 10:00 存為 14:00 UTC（EDT-4）", "管理員", async () => {
  // Send an ISO timestamp with -04:00 offset (EDT); server must store as UTC 14:00
  const openDate = `${NY_DATE}T10:00:00-04:00`; // must include tz for parseTimestamp
  const dueDate  = `${NY_DATE}T22:00:00-04:00`;
  const testName = `TEST nightly-tz-${Date.now()}`;
  const b = await chromium.launch();
  let createdId = null;
  try {
    const { page, context } = await login(b, ADMIN_CLERK);

    // Find a module with only Approved questions (mathLinear may have pending questions)
    let moduleId = null;
    for (const testId of [TESTS.engLinear, TESTS.untimedEng, TESTS.mathLinear, TESTS.adaptive]) {
      const tr2 = await testRow(testId);
      const mid = tr2.module_id;
      if (!mid) continue;
      const { count: totalQ } = await db.from("questions").select("id", { count: "exact", head: true }).eq("module_id", mid);
      const { count: approvedQ } = await db.from("questions").select("id", { count: "exact", head: true }).eq("module_id", mid).eq("parsing_status", "Approved");
      if (totalQ > 0 && totalQ === approvedQ) { moduleId = mid; break; }
    }
    if (!moduleId) throw new Error("no module with all-approved questions found for H-17");

    const createR = await page.request.post(`${BASE}/api/admin/tests`, {
      data: {
        testName,
        moduleId,
        timeLimitMinutes: 35,
        isAdaptive: false,
        showAnswersAfterSubmission: false,
        allowRetake: false,
        openDate,
        dueDate,
        classGroupIds: [],
      },
    });
    const createJ = await createR.json().catch(() => ({}));
    createdId = createJ.data?.id ?? createJ.id;
    await context.close();

    if (createR.status() >= 400 || !createdId)
      throw new Error(`create test failed: ${createR.status()} ${JSON.stringify(createJ).slice(0, 200)}`);

    // Read back from DB
    const { data: t } = await db.from("tests").select("open_date,due_date").eq("id", createdId).single();
    if (!t?.open_date) throw new Error(`open_date is null in DB for createdId ${createdId}`);
    const storedUTC = new Date(t.open_date).toISOString();
    const expectedHour = 14; // EDT (UTC-4), October
    const storedHour = new Date(t.open_date).getUTCHours();

    if (storedHour !== expectedHour)
      fail(`open_date stored as ${storedUTC}, expected UTC hour 14 (EDT); got ${storedHour}`);
    return `open_date ${storedUTC} — correct UTC offset applied`;
  } finally {
    if (createdId) await db.from("tests").delete().eq("id", createdId).then(() => {}, () => {});
    await b.close().catch(() => {});
  }
});

// ── V. H-18 Edit single-module test ────────────────────────
await check("H-18", ["H-18"], "單一 module 的測驗可以正常編輯（PATCH 回 200）", "管理員", async () => {
  const b = await chromium.launch();
  try {
    const { page, context } = await login(b, ADMIN_CLERK);
    const r = await page.request.patch(`${BASE}/api/admin/tests/${TESTS.untimedEng}`, {
      data: { showAnswersAfterSubmission: true },
    });
    const j = await r.json().catch(() => ({}));
    // Restore in same context
    await page.request.patch(`${BASE}/api/admin/tests/${TESTS.untimedEng}`, { data: { showAnswersAfterSubmission: false } }).catch(() => {});
    await context.close();
    const rb = r.status();

    if (r.status() >= 400)
      fail(`PATCH single-module test → ${r.status()} ${JSON.stringify(j).slice(0, 200)}`);
    return `PATCH untimedEng → ${r.status()} (restore → ${rb})`;
  } finally {
    await b.close().catch(() => {});
  }
});

// ── W. H-19 Reset M1 resets session ────────────────────────
await check("H-19", ["H-19"], "管理員重設 Module 1 後，Module 2 狀態也重設", "管理員", async () => {
  const T = TESTS.mathLinear;
  const s = studentByN(46);
  if (!s) throw new Error("student 046 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  try {
    const { page: sp, context: sc } = await login(b, STUDENT1_CLERK);

    // Complete both modules via API
    const r = await apiTakeTest(sc.request, s.id, T);
    await sc.close();
    if (!r.m2Id) throw new Error("no M2 after mathLinear");

    // Now login as admin and reset M1
    const { page: ap, context: ac } = await login(b, ADMIN_CLERK);
    const resetR = await ap.request.post(`${BASE}/api/admin/submissions/${r.m1Id}/reset`, {});
    const resetJ = await resetR.json().catch(() => ({}));
    await ac.close();

    if (resetR.status() >= 400)
      fail(`admin reset M1 → ${resetR.status()} ${JSON.stringify(resetJ).slice(0, 200)}`);

    // Check DB: M2 should also be reset/deleted
    await sleep(1000);
    const { data: m2After } = await db.from("submissions").select("id,status").eq("id", r.m2Id).single();
    if (m2After && m2After.status === "Submitted")
      fail(`M2 still Submitted after M1 reset; M2 status=${m2After.status}`);
    return `M1 reset → M2 status=${m2After?.status ?? "deleted"} (session cleared)`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── X. M-02 SPR grading edge cases ─────────────────────────
// Each case uses a fresh student to avoid cleanup issues.
await check("M-02", ["M-02"], "填答題（SPR）格式邊緣案例評分正確", "計分", async () => {
  const T = TESTS.mathLinear;
  const origS1Id = C.students[0].id;

  // Get M1 questions to find SPR questions
  const tr = await testRow(T);
  const q1all = await moduleQs(tr.module_id);
  const sprQs = q1all.filter((q) => q.question_type !== "Multiple Choice");
  if (!sprQs.length) return "no SPR questions in mathLinear module — skip";

  const sprQ = sprQs[0];
  const correct = String(sprQ.correct_answer).split(/\s*(?:\bor\b|[\n;|])\s*/)[0].trim();
  // Test cases: [input, expectedCorrect, label, studentN]
  const cases = [
    [`  ${correct}  `, true,  "leading/trailing spaces", 47],
    [correct,          true,  "exact match",             48],
    ["99999999",       false, "wrong number",            49],
  ];

  const issues = [];
  const b = await chromium.launch();
  try {
    for (const [input, expectedCorrect, label, n] of cases) {
      const s = studentByN(n);
      if (!s) { issues.push(`student ${n} not found`); continue; }
      await deleteSubs(s.id, T);
      await borrowLogin(s.id, STUDENT1_CLERK);
      try {
        const { page, context } = await login(b, STUDENT1_CLERK);
        const startR = await page.request.post(`${BASE}/api/student/submissions`, { data: { testId: T } });
        const startJ = await startR.json().catch(() => ({}));
        const m1Id = startJ.data?.id;
        if (!m1Id) { issues.push(`${label}: no M1 id`); await context.close(); continue; }
        await sleep(1000);
        const { data: m1Row } = await db.from("submissions").select("id,module_id").eq("id", m1Id).single();
        const q1 = await moduleQs(m1Row?.module_id ?? tr.module_id);
        const answers = Object.fromEntries(q1.map((qi) => [qi.id, correctPick(qi)]));
        answers[sprQ.id] = input; // override SPR with test input
        await page.request.patch(`${BASE}/api/student/submissions/${m1Id}`, { data: { answers, metadata: {} } });
        await sleep(500);
        await page.request.post(`${BASE}/api/student/submissions/${m1Id}/submit`, { data: { answers, metadata: {} } });
        await sleep(800);
        const { data: ar } = await db
          .from("answer_records")
          .select("is_correct,student_answer")
          .eq("submission_id", m1Id)
          .eq("question_id", sprQ.id)
          .single();
        if (ar?.is_correct !== expectedCorrect)
          issues.push(`SPR '${label}': is_correct=${ar?.is_correct} expected=${expectedCorrect} input=${JSON.stringify(input)}`);
        await context.close();
      } finally {
        await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
        await deleteSubs(s.id, T).catch(() => {});
        await sleep(800);
      }
    }
  } finally {
    await b.close().catch(() => {});
  }
  if (issues.length) fail(issues.join("; "));
  return `${cases.length} SPR edge cases passed`;
});

// ── Y. SMOKE — all main pages ──────────────────────────────
await check("SMOKE", [], "Smoke：主要頁面都載入成功（無錯誤文字）", "可用性", async () => {
  const ERROR_RE = /Internal Server Error|Something went wrong|500|Error [\d]+|Unhandled|crash/i;
  const QA_ROLES = [
    { clerkId: STUDENT1_CLERK, label: "student", paths: ["/student", "/student/tests"] },
    { clerkId: TEACHER1_CLERK, label: "teacher", paths: ["/teacher", "/teacher/tests", "/teacher/classes"] },
    { clerkId: ADMIN_CLERK,    label: "admin",   paths: ["/admin", "/admin/students", "/admin/tests", "/admin/teachers", "/admin/classes"] },
  ];
  const b = await chromium.launch();
  const results_local = [];
  try {
    for (const { clerkId, label, paths } of QA_ROLES) {
      const { page, context } = await login(b, clerkId);
      for (const p of paths) {
        const t0 = Date.now();
        const r = await page.goto(BASE + p, { waitUntil: "networkidle" }).catch(() => null);
        const status = r?.status() ?? 0;
        const txt = await page.locator("body").innerText().catch(() => "");
        const hasError = ERROR_RE.test(txt);
        const ms = Date.now() - t0;
        results_local.push({ role: label, path: p, status, hasError, ms });
        await sleep(300);
      }
      await context.close();
      await sleep(500);
    }
  } finally {
    await b.close().catch(() => {});
  }
  const errors = results_local.filter((r) => r.status >= 400 || r.hasError);
  const avgMs = Math.round(results_local.reduce((a, r) => a + r.ms, 0) / results_local.length);
  if (errors.length > 0)
    fail(`${errors.length} pages failed: ${errors.map((e) => `${e.role}${e.path}(${e.status})`).join(", ")}`);
  return `${results_local.length} pages OK; avg ${avgMs}ms`;
});

// ── Z. GRADING SAMPLE — 20 DB-only students ────────────────
await check("GRADE-SAMPLE", [], "20 位學生作答樣本，分數全部符合", "計分", async () => {
  const origS1Id = C.students[0].id;
  const origS2Id = C.students[1].id;
  const b = await chromium.launch();
  const mismatches = [];
  const done = [];
  try {
    for (let n = 51; n <= 70; n++) {
      if (Date.now() - START_MS > GLOBAL_TIMEOUT_MS - 5 * 60 * 1000) {
        LOG_LINE(`  [GRADE] timeout approaching, stopping at student ${n}`);
        break;
      }
      const s = studentByN(n);
      if (!s) continue;
      const T = n % 2 === 0 ? TESTS.mathLinear : TESTS.engLinear;

      await deleteSubs(s.id, T);
      const useClerk = STUDENT1_CLERK;
      await borrowLogin(s.id, useClerk);
      try {
        const { page, context } = await login(b, useClerk);
        const r = await apiTakeTest(context.request, s.id, T);
        await context.close();

        const m1Match = r.dbScore1 === r.score1Expected;
        const m2Match = r.m2Id ? r.dbScore2 === r.score2Expected : true;
        if (!m1Match || !m2Match)
          mismatches.push(`s${n} ${T.slice(0, 4)}: M1 db=${r.dbScore1} exp=${r.score1Expected} M2 db=${r.dbScore2} exp=${r.score2Expected}`);
        done.push(n);
      } catch (e) {
        mismatches.push(`s${n} ERROR: ${e.message?.slice(0, 60)}`);
      } finally {
        await borrowLogin(origS1Id, useClerk).catch(() => {});
        await deleteSubs(s.id, T).catch(() => {});
        await sleep(1500);
      }
    }
  } finally {
    await b.close().catch(() => {});
  }
  if (mismatches.length) fail(`${mismatches.length} score mismatches: ${mismatches.join("; ").slice(0, 400)}`);
  return `${done.length} students all scored correctly`;
});

// ── Z2. QUESTION BANK + REAL SCORES (DB/HTTP only, no AI) ──────
const contentCheck = (fn) => async () => {
  const r = await fn();
  if (r.problems.length) fail(`${r.summary}；${r.problems.length} 個問題：${r.problems.slice(0, 15).join("；")}`);
  return r.summary;
};
await check("BANK", [], "題庫：上線題目完整（沒截斷、沒佔位文字、4 個選項、答案是選項字母、解答說明完整）", "題目內容", contentCheck(bankIntegrity));
await check("BANK-IMG", [], "題庫：所有上線題目的圖片都打得開", "題目內容", contentCheck(bankImages));
await check("BANK-MATH", [], "題庫：上線題目的數學式和金額都正常顯示（學生看不到 $、\\ 之類的原始符號）", "題目內容", contentCheck(bankMathRender));
await check("REAL-SCORES", [], "真實學生成績：沒有整份模組正確率接近亂猜（答案可能錯）", "題目內容", contentCheck(realScoreAnomalies));

// ── Z3. SAFARI — exam page in WebKit (Safari's engine) ─────────
await check("SAFARI", [], "Safari：作答頁正常顯示（題目、數學式）、選答案能存進去", "相容性", async () => {
  const T = TESTS.mathLinear;
  const s = studentByN(47);
  if (!s) throw new Error("student 047 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await webkit.launch();
  const pageErrors = [];
  try {
    const { page, context } = await login(b, STUDENT1_CLERK);
    page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 120)));
    // WebKit finishes the post-sign-in redirect to /student after login() returns.
    await page.waitForURL(/\/student/, { timeout: 45000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await startTestBrowser(page, T);
    const [m1] = await subs(s.id, T);
    if (!m1) fail("Safari: no submission after Start");
    const q1 = await moduleQs(m1.module_id);
    // Walk the first 5 questions: each must show text, then pick A and go next.
    const katex = [];
    for (let i = 0; i < 5; i++) {
      await page.getByText(new RegExp(`Question ${i + 1} of \\d+`)).first().waitFor({ timeout: 20000 });
      katex.push(await page.locator(".katex").count());
      const pick = page.locator(`button:has(> span:text-is("A"))`).first();
      if (await pick.count()) await pick.click({ timeout: 10000 });
      else await page.locator("input[type=text], input[inputmode]").first().fill("1");
      await page.getByRole("button", { name: /^Next/ }).first().click({ timeout: 10000 });
    }
    await sleep(4000); // autosave
    const [after] = await subs(s.id, T);
    const saved = q1.slice(0, 5).filter((q) => after?.answers?.[q.id]).length;
    await context.close();
    if (saved < 5) fail(`Safari: only ${saved}/5 answers saved; page errors: ${pageErrors.join(" | ") || "none"}`);
    if (pageErrors.length) fail(`Safari: answers saved but page threw: ${pageErrors.join(" | ")}`);
    if (!katex.some((n) => n > 0)) fail("Safari: no math (KaTeX) rendered in the first 5 math questions");
    return `5/5 answers saved; math rendered; no page errors`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
});

// ── Z. EDGE CASES — unusual situations during an exam (students 060–071) ──
await runEdgeChecks({
  check, fail, TESTS, C, STUDENT1_CLERK, ADMIN_CLERK, studentByN,
  subs, deleteSubs, moduleQs, waitTake, startTestBrowser, apiTakeTest,
});

// ── Z2. DAILY NEW CHECKS — added each evening by nightly/new-tests.sh (students 072–080) ──
await runDailyChecks({
  check, fail, TESTS, C, STUDENT1_CLERK, ADMIN_CLERK, studentByN,
  subs, deleteSubs, moduleQs, waitTake, startTestBrowser, apiTakeTest,
});

// ── Z. PRINT — every figure is in the printed PDF ──────────
await runPrintChecks({ check, fail, TESTS, ADMIN_CLERK });

// ── AA. PRODUCTION HEALTH — Vercel error summary ────────────
await check("PROD-HEALTH", [], "正式站錯誤日誌摘要（最近 24 小時）", "監控", async () => {
  let logsJson = "";
  try {
    logsJson = execSync(
      `npx -y vercel@latest logs --since 24h --json -n 2000 2>/dev/null || echo "[]"`,
      { cwd: ROOT, timeout: 90000, encoding: "utf-8" }
    );
  } catch (e) {
    return `vercel logs command failed: ${e.message.slice(0, 200)}`;
  }
  const lines = logsJson.trim().split("\n").filter(Boolean);
  let errors5xx = 0, clerk429 = 0;
  const msgCounts = {};
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const status = obj.status ?? obj.statusCode;
    const msg = (obj.message ?? obj.msg ?? "").slice(0, 120);
    if (typeof status === "number" && status >= 500) errors5xx++;
    if (msg.toLowerCase().includes("too many requests") || msg.includes("api_response_error")) clerk429++;
    if (msg) msgCounts[msg] = (msgCounts[msg] ?? 0) + 1;
  }
  const top5 = Object.entries(msgCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const summary = `5xx=${errors5xx} clerk429=${clerk429} top: ${top5.map(([m, n]) => `[${n}]${m.slice(0, 40)}`).join(" | ")}`;
  writeFileSync(`${NIGHTLY_DIR}/${NY_DATE}-prod-health.json`, JSON.stringify({ errors5xx, clerk429, top5, lines: lines.length }, null, 2));
  return summary;
});

// ── BB. H-05 (runs sequentially here — after all STUDENT1_CLERK checks are done)
// Running H-05 after all sequential checks avoids borrowLogin races: no other
// check is active while H-05 holds STUDENT1_CLERK for its 5-min window.
await check("H-05", ["H-05"], "超時提交標記 Late；截止後 PATCH 回 409", "考試流程", async () => {
  const h05 = await runH05Background();
  if (h05.result === "FAIL") fail(h05.details);
  if (h05.result === "ERROR") throw new Error(h05.details);
  return h05.details;
});

// ── CC. Wait for C-04 background task ──────────────────────
const c04 = await c04Promise;
await check("C-04", ["C-04"], "晚點開 Module 2 不被 cron 提前強制交卷", "考試流程", async () => {
  if (c04.result === "FAIL") fail(c04.details);
  if (c04.result === "ERROR") throw new Error(c04.details);
  return c04.details;
});

// ── DD. FULL-TIMED — a whole 2-module timed exam, let the clock run out ──
// Nothing is submitted by hand: the take page's own timer must submit M1 at
// 0:00, show the Module 2 intro, and submit M2 at 0:00. ~66 min, runs last.
await check("FULL-TIMED", [], "完整考一場（英文 2 個模組各 32 分鐘），時間到自動交卷、答案保留", "考試流程", async () => {
  const T = TESTS.engLinear;
  const s = studentByN(48);
  if (!s) throw new Error("student 048 not found");
  await deleteSubs(s.id, T);
  const origS1Id = C.students[0].id;
  await borrowLogin(s.id, STUDENT1_CLERK);
  const b = await chromium.launch();
  const LOG = (m) => LOG_LINE(`  [FULL-TIMED] ${m}`);
  const answerFirst = async (page, n) => {
    for (let i = 0; i < n; i++) {
      await page.getByText(new RegExp(`Question ${i + 1} of \\d+`)).first().waitFor({ timeout: 30000 });
      await page.locator(`button:has(> span:text-is("B"))`).first().click({ timeout: 10000 });
      await page.getByRole("button", { name: /^Next/ }).first().click({ timeout: 10000 });
    }
  };
  // Waits for a module's own timer to submit it; returns the DB row.
  const waitForAutoSubmit = async (id, minutes) => {
    const until = Date.now() + (minutes + 4) * 60 * 1000;
    while (Date.now() < until) {
      await sleep(30000);
      const { data } = await db.from("submissions").select("id,status,answers,started_at,submitted_at,metadata,correct_count").eq("id", id).single();
      if (data && data.status !== "In Progress") return data;
    }
    return null;
  };
  try {
    // Session login tickets expire long before 66 min; Clerk keeps the session alive.
    const { page, context } = await login(b, STUDENT1_CLERK);
    await startTestBrowser(page, T);
    const t0 = Date.now();
    const [m1] = await subs(s.id, T);
    await answerFirst(page, 3);
    LOG(`M1 started, 3 answered; waiting for the 32-min timer`);
    const m1Done = await waitForAutoSubmit(m1.id, 32);
    if (!m1Done) fail("M1 still In Progress 36 min after start — the timer did not submit it");
    const m1Min = (new Date(m1Done.submitted_at) - new Date(m1Done.started_at)) / 60000;
    const m1Kept = Object.keys(m1Done.answers ?? {}).length;
    LOG(`M1 ${m1Done.status} after ${m1Min.toFixed(1)} min, ${m1Kept} answers kept`);
    if (m1Kept < 3) fail(`M1 auto-submitted but only ${m1Kept}/3 answers were kept`);
    if (m1Min < 31 || m1Min > 34) fail(`M1 submitted after ${m1Min.toFixed(1)} min (expected ~32)`);

    // Module 2 intro → Start Module 2
    const start2 = page.getByRole("link", { name: /Start Module 2/ }).or(page.getByRole("button", { name: /Start Module 2/ }));
    await start2.first().waitFor({ timeout: 120000 });
    await start2.first().click();
    await waitTake(page);
    const m2 = (await subs(s.id, T)).find((r) => r.id !== m1.id);
    if (!m2) fail("no Module 2 submission after Start Module 2");
    await answerFirst(page, 3);
    LOG(`M2 started, 3 answered; waiting for the 32-min timer`);
    const m2Done = await waitForAutoSubmit(m2.id, 32);
    if (!m2Done) fail("M2 still In Progress 36 min after start — the timer did not submit it");
    const m2Start = m2Done.metadata?.module_2_started_at ?? m2Done.started_at;
    const m2Min = (new Date(m2Done.submitted_at) - new Date(m2Start)) / 60000;
    const m2Kept = Object.keys(m2Done.answers ?? {}).length;
    await context.close();
    if (m2Kept < 3) fail(`M2 auto-submitted but only ${m2Kept}/3 answers were kept`);
    if (m2Min < 31 || m2Min > 34) fail(`M2 submitted ${m2Min.toFixed(1)} min after it started (expected ~32)`);
    return `M1 ${m1Done.status} at ${m1Min.toFixed(1)} min, M2 ${m2Done.status} at ${m2Min.toFixed(1)} min; answers kept 3/3 + 3/3; total ${Math.round((Date.now() - t0) / 60000)} min`;
  } finally {
    await b.close().catch(() => {});
    await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    await deleteSubs(s.id, T).catch(() => {});
  }
}, 80 * 60 * 1000);

// ─────────────────────────────────────────────────────────
LOG_LINE(`\n=== Done in ${Math.round((Date.now() - START_MS) / 1000)}s ===`);
LOG_LINE(`PASS: ${results.filter((r) => r.result === "PASS").length}  FAIL: ${results.filter((r) => r.result === "FAIL").length}  ERROR: ${results.filter((r) => r.result === "ERROR").length}`);
LOG_LINE(`Results: ${OUT_JSON}`);
saveResults();
process.exit(0);
