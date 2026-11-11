#!/usr/bin/env node
// harness/nightly/report.mjs — SAT Exam OS nightly report sender
// Usage:
//   node nightly/report.mjs            # sends via Telegram
//   node nightly/report.mjs --dry      # prints to stdout only
//
// Reads:  .omc/qa/nightly/<YYYY-MM-DD>.json  (today, NY time)
// Token:  ~/.claude/channels/telegram/.env   TELEGRAM_BOT_TOKEN
// Chat:   2110834874

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const DRY = process.argv.includes("--dry");
const CHAT_ID = 2110834874;
const NY_DATE = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const NIGHTLY_DIR = new URL("../../nightly", import.meta.url).pathname;

// ─── load today's result file ─────────────────────────────
function findResultFile(date) {
  const path = `${NIGHTLY_DIR}/${date}.json`;
  if (existsSync(path)) return path;
  return null;
}

const todayFile = findResultFile(NY_DATE);
if (!todayFile) {
  console.error(`No result file for ${NY_DATE} at ${NIGHTLY_DIR}/${NY_DATE}.json`);
  process.exit(1);
}
const today = JSON.parse(readFileSync(todayFile, "utf-8"));

// ─── find yesterday's file ────────────────────────────────
function prevDate(d) {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
const yesterdayFile = findResultFile(prevDate(NY_DATE));
const yesterday = yesterdayFile ? JSON.parse(readFileSync(yesterdayFile, "utf-8")) : null;

// ─── compare with yesterday ───────────────────────────────
function checkMap(run) {
  const m = {};
  for (const c of run?.checks ?? []) m[c.id] = c;
  return m;
}
const todayMap = checkMap(today);
const yMap     = checkMap(yesterday);

// SKIP (a check that can't run yet, e.g. fixtures missing) is neither a pass nor a failure.
const bad         = (c) => c?.result === "FAIL" || c?.result === "ERROR";
const newFails    = today.checks.filter((c) => bad(c) && !bad(yMap[c.id]));
const newlyFixed  = today.checks.filter((c) => c.result === "PASS"  && bad(yMap[c.id]));
const stillFail   = today.checks.filter(bad);
const skipped     = today.checks.filter((c) => c.result === "SKIP");
// A check that passed yesterday and is skipped today lost coverage: list it.
const lostCoverage = skipped.filter((c) => yMap[c.id]?.result === "PASS");

// ─── Vercel error summary ─────────────────────────────────
let prodSummary = "";
const prodHealthCheck = todayMap["PROD-HEALTH"];
if (prodHealthCheck) {
  prodSummary = prodHealthCheck.details ?? "N/A";
}

// ─── build message parts ──────────────────────────────────
function esc(s) {
  // Telegram MarkdownV2 escape
  return String(s ?? "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

const runMs   = today.total_ms ?? 0;
const runMin  = Math.floor(runMs / 60000);
const runSec  = Math.round((runMs % 60000) / 1000);
const overall = today.counts.FAIL + today.counts.ERROR === 0 ? "✅ PASS" : "🔴 FAIL";

const lines = [];
lines.push(`*SAT Exam OS 每日回歸測試 — ${esc(NY_DATE)}*`);
lines.push(`${overall}  PASS ${today.counts.PASS} / FAIL ${today.counts.FAIL} / ERROR ${today.counts.ERROR}${skipped.length ? ` / SKIP ${skipped.length}` : ""}`);
lines.push(`執行時間：${runMin}m ${runSec}s`);
lines.push("");

if (newFails.length > 0) {
  lines.push(`*🔴 今天新增失敗（${newFails.length}）*`);
  for (const c of newFails) {
    const findings = c.finding_ids?.join(", ") ?? "";
    lines.push(`• ${esc(c.id)} ${esc(c.title_zh)} ${findings ? `\\[${esc(findings)}\\]` : ""}`);
    if (c.details) lines.push(`  ${esc(c.details.slice(0, 80))}`);
  }
  lines.push("");
}

if (newlyFixed.length > 0) {
  lines.push(`*✅ 今天修好（${newlyFixed.length}）*`);
  for (const c of newlyFixed) {
    const yResult = yMap[c.id]?.result ?? "?";
    lines.push(`• ${esc(c.id)} ${esc(c.title_zh)} \\(昨天 ${yResult}\\)`);
  }
  lines.push("");
}

if (stillFail.length > 0) {
  lines.push(`*⚠️ 全部失敗項目（${stillFail.length}）*`);
  for (const c of stillFail) {
    const findings = c.finding_ids?.join(", ") ?? "";
    lines.push(`• \\[${esc(c.result)}\\] ${esc(c.id)}${findings ? ` ${esc(findings)}` : ""} — ${esc(c.details?.slice(0, 70) ?? "")}`);
  }
  lines.push("");
}

if (skipped.length > 0) {
  lines.push(`*⏭️ 略過（${skipped.length}）*`);
  lines.push(esc(`${skipped.map((c) => c.id).join(", ")} — ${skipped[0].details?.slice(0, 90) ?? ""}`));
  if (lostCoverage.length) lines.push(esc(`⚠️ 昨天通過、今天略過：${lostCoverage.map((c) => `${c.id}（${c.details?.slice(0, 60) ?? ""}）`).join("；")}`));
  lines.push("");
}

// Production health
lines.push(`*📊 正式站錯誤摘要（24h）*`);
lines.push(esc(prodSummary.slice(0, 200)));

// Account / API health: Clerk dev instance caps at 100 users (warn at 85),
// and AI parsing stops when the Anthropic credit balance runs out.
function readEnv(name) {
  try {
    const env = readFileSync(new URL("../../../../.env.local", import.meta.url), "utf-8");
    return env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1].trim().replace(/^"|"$/g, "") ?? null;
  } catch { return null; }
}
const statusPlain = [];
const st = (t) => { statusPlain.push(t); return t; };
lines.push("");
lines.push(`*🔑 帳號與 API 狀態*`);
try {
  const res = await fetch("https://api.clerk.com/v1/users/count", { headers: { Authorization: `Bearer ${readEnv("CLERK_SECRET_KEY")}` } });
  const n = (await res.json()).total_count;
  if (typeof n !== "number") throw new Error(`HTTP ${res.status}`);
  lines.push(esc(st(n >= 85
    ? `⚠️ Clerk 帳號 ${n}/100，已到 85，該升級 Clerk 了（上限 100，滿了新學生無法註冊）`
    : `Clerk 帳號 ${n}/100（85 時提醒升級）`)));
} catch (e) {
  lines.push(esc(st(`Clerk 帳號數查詢失敗：${e.message}`)));
}
try {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": readEnv("ANTHROPIC_API_KEY") ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
  });
  const j = await res.json();
  if (res.ok) lines.push(esc(st("Anthropic API 正常")));
  else if (/credit balance/i.test(j?.error?.message ?? "")) lines.push(esc(st("⚠️ Anthropic API 額度用完：上傳 PDF 解析與 AI 解釋會失敗，請儲值")));
  else lines.push(esc(st(`⚠️ Anthropic API 錯誤：${j?.error?.message ?? res.status}`)));
} catch (e) {
  lines.push(esc(st(`Anthropic API 檢查失敗：${e.message}`)));
}

// Checks the evening new-tests job added for tonight
try {
  const fresh = JSON.parse(readFileSync(new URL("./added-tests.json", import.meta.url), "utf-8")).filter((a) => a.added === NY_DATE);
  if (fresh.length) {
    lines.push("");
    lines.push(`*🆕 今天新加的測試（${fresh.length} 項）*`);
    for (const a of fresh) {
      const c = today.checks.find((x) => x.id === a.id);
      lines.push(esc(`${c ? (c.result === "PASS" ? "✅" : "🔴") : "⚪"} ${a.zh}`));
    }
  }
} catch {}

// Load test (only on nights it ran)
const loadFile = `${NIGHTLY_DIR}/${NY_DATE}-load.json`;
if (existsSync(loadFile)) {
  const L = JSON.parse(readFileSync(loadFile, "utf-8"));
  lines.push("");
  lines.push(`*👥 ${L.n} 人同時考試測試*`);
  lines.push(esc(`${L.result === "PASS" ? "✅" : "🔴"} ${L.summary.students_ok}/${L.n} 人順利考完；自動存檔 ${L.summary.autosaves} 次，一般 ${L.summary.autosave_p50_ms} ms、最慢 5% ${L.summary.autosave_p95_ms} ms；失敗 ${L.summary.failed_calls} 次`));
  for (const pr of L.problems.slice(0, 5)) lines.push(esc(`• ${pr}`));
}

const fullMessage = lines.join("\n");

// ─── Telegram sender ──────────────────────────────────────
async function sendTelegram(text, opts = {}) {
  const envPath = `${process.env.HOME}/.claude/channels/telegram/.env`;
  const envContent = readFileSync(envPath, "utf-8");
  const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/);
  if (!tokenMatch) throw new Error("TELEGRAM_BOT_TOKEN not found in " + envPath);
  const token = tokenMatch[1].trim();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "MarkdownV2",
      ...opts,
    }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`Telegram error: ${JSON.stringify(j)}`);
  return j;
}

async function sendFile(filePath, caption) {
  const envPath = `${process.env.HOME}/.claude/channels/telegram/.env`;
  const envContent = readFileSync(envPath, "utf-8");
  const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/);
  if (!tokenMatch) throw new Error("TELEGRAM_BOT_TOKEN not found");
  const token = tokenMatch[1].trim();
  const { FormData, File } = await import("node:buffer").then(() => globalThis).catch(() => ({}));
  const url = `https://api.telegram.org/bot${token}/sendDocument`;

  const content = readFileSync(filePath);
  const fileName = filePath.split("/").at(-1);

  const body = new (await import("node:stream").then(() => globalThis.FormData ?? null).catch(() => null))();
  if (!body) {
    // Use fetch with multipart manually via Buffer
    const boundary = `----NightlyBoundary${Date.now()}`;
    const CRLF = "\r\n";
    const fieldPart = Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}${CHAT_ID}${CRLF}` +
      `--${boundary}${CRLF}Content-Disposition: form-data; name="caption"${CRLF}${CRLF}${caption ?? ""}${CRLF}` +
      `--${boundary}${CRLF}Content-Disposition: form-data; name="document"; filename="${fileName}"${CRLF}Content-Type: ${fileName.endsWith(".pdf") ? "application/pdf" : "application/json"}${CRLF}${CRLF}`
    );
    const endPart = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const multipart = Buffer.concat([fieldPart, content, endPart]);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart,
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`Telegram sendDocument error: ${JSON.stringify(j)}`);
    return j;
  }
  body.append("chat_id", String(CHAT_ID));
  if (caption) body.append("caption", caption);
  body.append("document", new File([content], fileName, { type: fileName.endsWith(".pdf") ? "application/pdf" : "application/json" }));
  const res = await fetch(url, { method: "POST", body });
  const j = await res.json();
  if (!j.ok) throw new Error(`Telegram sendDocument error: ${JSON.stringify(j)}`);
  return j;
}

// Split message if over 4000 chars
const MAX_LEN = 3900;
function splitMessages(text) {
  if (text.length <= MAX_LEN) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > MAX_LEN) {
    let cut = remaining.lastIndexOf("\n", MAX_LEN);
    if (cut < 0) cut = MAX_LEN;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut + 1);
  }
  if (remaining.trim()) parts.push(remaining);
  return parts;
}

if (DRY) {
  console.log("=== DRY RUN — would send to Telegram ===");
  console.log(fullMessage);
  console.log(`=== Message length: ${fullMessage.length} chars ===`);
  console.log(`=== JSON file: ${todayFile} ===`);
  process.exit(0);
}

// Log tonight's run on /admin/reports (.omc/devlog). Never fails the report.
try {
  const { enabled, qaRunFromNightly, writeQaRun } = await import("../../../devlog/lib.mjs");
  if (enabled()) console.log(`Dev log qa_run: ${await writeQaRun({ ...qaRunFromNightly(today), date: today.date ?? NY_DATE })}`);
} catch (e) {
  console.error(`Dev log write failed: ${e.message}`);
}

// Send
const parts = splitMessages(fullMessage);
for (let i = 0; i < parts.length; i++) {
  try {
    const r = await sendTelegram(parts[i]);
    console.log(`Sent part ${i + 1}/${parts.length} (id:${r.result?.message_id})`);
  } catch (e) {
    console.error(`Failed to send part ${i + 1}: ${e.message}`);
    process.exit(1);
  }
}

// Attach a plain-language PDF (Barry can't read the raw JSON)
try {
  const pr = prodHealthCheck?.details?.match(/5xx=(\d+) clerk429=(\d+)/);
  if (pr) statusPlain.unshift(`正式網站 24 小時：伺服器錯誤 ${pr[1]} 次、登入被限流 ${pr[2]} 次`);
  writeFileSync(`${NIGHTLY_DIR}/${NY_DATE}-extra.json`, JSON.stringify({ status: statusPlain }));
  const { execFileSync } = await import("node:child_process");
  const pdfPath = execFileSync("node", [new URL("./pdf.mjs", import.meta.url).pathname, NY_DATE], { encoding: "utf-8" }).trim();
  await sendFile(pdfPath, `${NY_DATE} 測試報告`);
  console.log("Attached PDF");
} catch (e) {
  console.error(`Failed to attach PDF: ${e.message}`);
}

console.log("Report sent.");
