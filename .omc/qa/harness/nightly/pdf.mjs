#!/usr/bin/env node
// harness/nightly/pdf.mjs — plain-language PDF of a nightly run (no code, no jargon)
// Usage: node nightly/pdf.mjs [YYYY-MM-DD]  → prints the PDF path
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../node_modules/playwright");

const NIGHTLY_DIR = new URL("../../nightly", import.meta.url).pathname;
const date = process.argv[2] ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const run = JSON.parse(readFileSync(`${NIGHTLY_DIR}/${date}.json`, "utf-8"));
const extra = (() => { try { return JSON.parse(readFileSync(`${NIGHTLY_DIR}/${date}-extra.json`, "utf-8")); } catch { return null; } })();

// What each check means, in words a non-engineer can follow.
const PLAIN = {
  "ISO-01":          ["隱私", "測試帳號產生的測驗，真實管理員和老師看不到"],
  "C-01":            ["穩定", "登入系統沒有因為人多被擋（沒有「請求太多」錯誤）"],
  "C-02":            ["計分", "每份交卷的總題數 = 實際上線的題數"],
  "C-03":            ["安全", "沒登入的人拿不到任何學生資料"],
  "C-05":            ["安全", "被停權或還沒審核的學生不能開始考試"],
  "HP-MATH":         ["考試流程", "數學測驗從頭考到尾，分數算對"],
  "HP-ADAPTIVE-HARD":["考試流程", "第一模組考得好，第二模組正確分到「難」的版本，分數算對"],
  "HP-UNTIMED":      ["考試流程", "不計時的英文單模組練習，分數算對"],
  "H-01":            ["考試流程", "選完答案馬上重新整理網頁，答案還在"],
  "H-02":            ["考試流程", "考試中斷網，網路恢復後答案自動補存"],
  "H-03":            ["考試流程", "第二模組考到一半離開，回來可以繼續考"],
  "H-04":            ["考試流程", "同時開兩個分頁作答，答案不會互相蓋掉"],
  "H-05":            ["考試流程", "時間到會擋住繼續作答，超時交卷標記為「遲交」"],
  "C-04":            ["考試流程", "晚一點才開始第二模組，系統不會提早幫學生交卷"],
  "H-06":            ["安全", "沒被指派、或還沒開放的測驗，學生進不去"],
  "H-08":            ["老師功能", "老師的「我的測驗」看得到指派給班上的測驗"],
  "H-09":            ["老師功能", "題目分析頁的平均分 = 成績頁的平均分"],
  "H-10":            ["老師功能", "老師寫的輔導筆記能存進去"],
  "M-07":            ["老師功能", "老師給 A 學生的私人筆記，不會出現在 B 學生那裡"],
  "H-11":            ["老師功能", "數學老師看不到英文測驗成績"],
  "H-12":            ["安全", "老師不能幫別人的班級建立測驗"],
  "H-14-15":         ["介面", "手機作答頁上方不重疊；按 Enter 選答案不會跳題"],
  "H-17":            ["管理員", "設定紐約時間早上 10 點開考，存進去的時間正確"],
  "H-18":            ["管理員", "只有一個模組的測驗可以正常編輯"],
  "H-19":            ["管理員", "管理員重設第一模組時，第二模組也一起重設"],
  "M-02":            ["計分", "填空題的各種寫法（分數、小數、負號）都判對"],
  "SMOKE":           ["網站", "主要頁面全部打得開、沒有錯誤訊息"],
  "GRADE-SAMPLE":    ["計分", "抽 20 位學生的作答重新計分，全部和系統分數一致"],
  "PROD-HEALTH":     ["網站", "正式網站最近 24 小時沒有伺服器錯誤"],
  "BANK":            ["題目內容", "所有上線題目都完整：題目沒被截斷、沒有佔位文字、有 4 個選項、答案是選項字母、有解答說明"],
  "BANK-IMG":        ["題目內容", "所有上線題目的圖片都打得開"],
  "BANK-MATH":       ["題目內容", "上線題目的數學式和金額都正常顯示，學生看不到原始符號"],
  "REAL-SCORES":     ["題目內容", "真實學生的成績沒有整份接近亂猜（那通常代表答案整份錯）；全班都錯的題目會列出來"],
  "PRINT-PDF":       ["列印", "列印考卷（空白卷、含答案卷）和學生作答：產生的 PDF 裡每張圖都在、沒有空白圖、圖沒有被切成兩半"],
  "PRINT-RESULT":    ["列印", "列印學生的作答結果：預覽、下載的 PDF 都有每張圖，分數和成績頁一樣，成績 CSV 也一樣"],
  "PRINT-WEBKIT":    ["列印", "用 Safari 的引擎列印考卷和學生作答結果：每張圖都有載入、有顯示，沒有被頁面切掉"],
  "PRINT-SESSION":   ["列印", "登入憑證剛好過期時列印：圖片第一次載入被拒也會自動重試，PDF 裡每張圖都在"],
  "PRINT-ALL":       ["列印", "「列印全部學生」：所有學生作答裡的每張圖都在 PDF 裡，沒有被頁面切掉"],
  "PRINT-REAL":      ["列印", "每一份真實已發布測驗的空白卷都能開出列印預覽（不卡住），每張圖和圖形選項都在 PDF 裡"],
  "PRINT-STUDENT":   ["列印", "學生在自己的成績頁按 Ctrl/Cmd+P：每一題和每張圖都印出來"],
  "SAFARI":          ["相容性", "用 Safari 的引擎考試：題目和數學式正常顯示、選的答案存得進去"],
  "FULL-TIMED":      ["考試流程", "完整考一場英文（2 個模組各 32 分鐘），不按交卷，時間到自動交卷、答案都在"],  "EDGE-DOUBLE-SUBMIT":["特殊狀況", "交卷按兩下、或交卷請求重複送出：只會有一份考卷、一個第二模組"],
  "EDGE-RAPID-CHANGE": ["特殊狀況", "同一題快速換答案（A→C→B），存到的是最後選的"],
  "EDGE-BLANK":        ["特殊狀況", "完全沒作答就交卷：0 分不當機，第二模組分到簡單版，成績頁正常"],
  "EDGE-NAV":          ["特殊狀況", "跳著作答、標記稍後再看、從題號列表跳題：答案和標記都在"],
  "EDGE-BACK":         ["特殊狀況", "考到一半按瀏覽器「上一頁」再回來：答案和剩餘時間都對"],
  "EDGE-AFTER-SUBMIT": ["特殊狀況", "交卷後再打開考試網址、或重送存檔：不能重考，答案不會被改"],
  "EDGE-CLOCK":        ["特殊狀況", "學生電腦時鐘快 2 小時、時區在台灣：倒數時間正確、不會提早交卷"],
  "EDGE-SLOW-NET":     ["特殊狀況", "網路很慢（模擬 3G）：還是開得了考試、答案存得進去"],
  "EDGE-SAVE-RETRY":   ["特殊狀況", "存檔時伺服器出錯（連續 3 次）：自動重試，答案不會掉"],
  "EDGE-RELOGIN":      ["特殊狀況", "考到一半被登出、再重新登入：回到原本的題目，登出時選的答案也補存"],
  "EDGE-SMALL-SCREEN": ["特殊狀況", "小筆電螢幕和放大 200%：題目、選項、下一題、交卷按鈕都看得到、按得到"],
  "EDGE-TEACHER-EDIT": ["特殊狀況", "考試中管理員改測驗名稱、關閉或取消指派：考到一半的學生還能存答案、交卷，準時考完不算遲交"],
};
// Checks added by the evening new-tests job describe themselves here.
const ADDED = (() => { try { return JSON.parse(readFileSync(new URL("./added-tests.json", import.meta.url), "utf-8")); } catch { return []; } })();
for (const a of ADDED) PLAIN[a.id] ??= [a.area, a.zh];

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const ny = (iso) => iso ? new Date(iso).toLocaleString("zh-TW", { timeZone: "America/New_York", hour12: false }) : "";
const mins = Math.floor((run.total_ms ?? 0) / 60000), secs = Math.round(((run.total_ms ?? 0) % 60000) / 1000);
const bad = run.counts.FAIL + run.counts.ERROR;

const rows = run.checks.map((c, i) => {
  const [area, what] = PLAIN[c.id] ?? [c.area ?? "", c.title_zh ?? c.id];
  const ok = c.result === "PASS";
  if (c.result === "SKIP") return `<tr><td class="n">${i + 1}</td><td>${esc(area)}</td><td>${esc(what)}<div class="note">略過：${esc(c.details)}</div></td><td class="r">⏭️ 略過</td></tr>`;
  const note = ok && /[\u4e00-\u9fff]/.test(c.details ?? "") ? `<div class="note">${esc(c.details)}</div>` : "";
  return `<tr class="${ok ? "" : "bad"}"><td class="n">${i + 1}</td><td>${esc(area)}</td><td>${esc(what)}${note}${ok ? "" : `<div class="why">問題：${esc(c.details)}</div>`}</td><td class="r">${ok ? "✅ 正常" : "❌ 有問題"}</td></tr>`;
}).join("");

const load = (() => { try { return JSON.parse(readFileSync(`${NIGHTLY_DIR}/${date}-load.json`, "utf-8")); } catch { return null; } })();
const loadHtml = load ? `<h2>${load.n} 人同時考試測試</h2>
<div class="box ${load.result === "PASS" ? "ok" : "no"}">${load.result === "PASS" ? "✅" : "❌"} ${load.summary.students_ok}/${load.n} 位測試學生同時開始、作答、交卷，${load.result === "PASS" ? "全部正常" : "有問題"}</div>
<ul>
<li>登入：最慢的 5% 花 ${(load.summary.signin_p95_ms / 1000).toFixed(1)} 秒</li>
<li>按「開始考試」到看到第一題：最慢的 5% 花 ${(load.summary.start_p95_ms / 1000).toFixed(1)} 秒</li>
<li>答案自動存檔 ${load.summary.autosaves} 次：一般 ${load.summary.autosave_p50_ms} 毫秒，最慢的 5% ${load.summary.autosave_p95_ms} 毫秒（3 秒內算正常）</li>
<li>失敗的存檔或交卷：${load.summary.failed_calls} 次</li>
${load.problems.map((p) => `<li class="why">${esc(p)}</li>`).join("")}
</ul>` : "";
const fresh = ADDED.filter((a) => a.added === date);
const freshHtml = fresh.length ? `<h2>今天新加的測試（${fresh.length} 項）</h2><ul>${fresh.map((a) => {
  const c = run.checks.find((x) => x.id === a.id);
  return `<li>${esc(a.zh)}：${c ? (c.result === "PASS" ? "✅ 正常" : `❌ 有問題（${esc(c.details)}）`) : "這次沒有跑到"}</li>`;
}).join("")}</ul>` : "";
const statusLines = (extra?.status ?? []).map((s) => `<li>${esc(s)}</li>`).join("");

const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><style>
body{font-family:"PingFang TC","Heiti TC",sans-serif;color:#222;margin:0;font-size:13px;line-height:1.55}
h1{font-size:22px;margin:0 0 4px}.sub{color:#666;margin-bottom:18px}
.box{border-radius:10px;padding:14px 18px;margin-bottom:18px;font-size:16px;font-weight:600}
.ok{background:#e8f6ec;color:#17643a}.no{background:#fdecea;color:#a1271b}
h2{font-size:16px;margin:22px 0 8px}
table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #e3e3e3;padding:7px 6px;text-align:left;vertical-align:top}
th{background:#f5f5f5;font-size:12px;color:#555}.n{width:24px;color:#999}.r{width:70px;white-space:nowrap}
tr.bad td{background:#fff4f2}.why{color:#a1271b;font-size:12px;margin-top:3px}.note{color:#666;font-size:12px;margin-top:3px}
ul{margin:0;padding-left:20px}
</style><body>
<h1>SAT Exam OS 每日自動測試報告</h1>
<div class="sub">${esc(date)}（紐約時間）・開始 ${esc(ny(run.started_at))}・花了 ${mins} 分 ${secs} 秒・全部用測試帳號，不動真實學生資料</div>
<div class="box ${bad ? "no" : "ok"}">${bad ? `❌ ${run.checks.length} 項中有 ${bad} 項有問題，詳見下方紅色列` : `✅ ${run.checks.length} 項全部正常`}</div>
${statusLines ? `<h2>帳號與服務狀態</h2><ul>${statusLines}</ul>` : ""}
${loadHtml}
${freshHtml}
<h2>測了什麼</h2>
<table><tr><th>#</th><th>類別</th><th>檢查內容</th><th>結果</th></tr>${rows}</table>
</body></html>`;

const htmlPath = `${NIGHTLY_DIR}/${date}-report.html`;
const pdfPath = `${NIGHTLY_DIR}/SAT每日測試報告_${date}.pdf`;
writeFileSync(htmlPath, html);
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`file://${htmlPath}`);
await p.pdf({ path: pdfPath, format: "A4", printBackground: true, margin: { top: "14mm", bottom: "14mm", left: "13mm", right: "13mm" } });
await b.close();
console.log(pdfPath);
