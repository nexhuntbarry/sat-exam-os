// harness/nightly/print-checks.mjs — paper copies keep every diagram.
// Generates real PDFs (Chromium page.pdf, Letter, print media) and compares
// the figures on the page with the image XObjects inside the PDF; plus a
// WebKit (Safari engine) print-media check, since WebKit has no page.pdf().
// Read-only: QA admin, QA tests and QA submissions only.
// Called from run.mjs: await runPrintChecks({ check, fail, TESTS, ADMIN_CLERK })
// Standalone: node nightly/print-checks.mjs   (QA_BASE=http://localhost:3000 for a local build)
import { chromium, webkit } from "playwright";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { login, db, BASE } from "../lib.mjs";

const require = createRequire(new URL("../../../../package.json", import.meta.url));
const { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFRef } = require("pdf-lib");
const OUT = new URL("../../nightly/print-pdfs/", import.meta.url).pathname;

/** Image XObjects drawn on each page (through nested Form XObjects). */
export async function pdfImageStats(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const perPage = [];
  const pagesOf = new Map(); // ref → set of page numbers
  const blank = new Set();
  doc.getPages().forEach((page, pi) => {
    const seen = new Set();
    const walk = (resources, depth) => {
      if (!(resources instanceof PDFDict) || depth > 6) return;
      const xo = resources.lookup(PDFName.of("XObject"));
      if (!(xo instanceof PDFDict)) return;
      for (const [, v] of xo.entries()) {
        const ref = v instanceof PDFRef ? v.toString() : null;
        const obj = ctx.lookup(v);
        if (!(obj instanceof PDFRawStream)) continue;
        const sub = obj.dict.lookup(PDFName.of("Subtype"))?.toString();
        if (sub === "/Image") {
          const key = ref ?? `inline${pi}`;
          seen.add(key);
          const w = Number(obj.dict.lookup(PDFName.of("Width"))?.toString() ?? 0);
          const h = Number(obj.dict.lookup(PDFName.of("Height"))?.toString() ?? 0);
          // A figure that never loaded is not embedded at all; a degenerate
          // one (tiny / empty stream) counts as blank.
          if (w < 8 || h < 8 || obj.contents.length < 64) blank.add(key);
        } else if (sub === "/Form") {
          walk(obj.dict.lookup(PDFName.of("Resources")), depth + 1);
        }
      }
    };
    walk(page.node.Resources(), 0);
    perPage.push(seen.size);
    for (const k of seen) pagesOf.set(k, new Set([...(pagesOf.get(k) ?? []), pi + 1]));
  });
  // Chromium re-emits an image on every page it spans: >1 page = cut across a page break.
  const split = [...pagesOf].filter(([, p]) => p.size > 1).map(([k, p]) => `${k} on pages ${[...p].join("+")}`);
  return { pages: perPage.length, images: pagesOf.size, blank: blank.size, split };
}

const figuresOnPage = (page) =>
  page.evaluate(() => {
    const imgs = [...document.images].filter((i) => i.src.includes("/api/blob-image"));
    const shown = imgs.filter((i) => getComputedStyle(i).display !== "none" && i.getClientRects().length > 0);
    return {
      total: new Set(shown.map((i) => i.src)).size,
      broken: shown.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.alt),
      graphChoiceWidthsIn: shown.filter((i) => /^Choice/.test(i.alt)).map((i) => +(i.getBoundingClientRect().width / 96).toFixed(2)),
    };
  });

/** Print the current page to PDF the way the Print button does (waits for figures), compare counts. */
async function pdfVsPage(page, name, { viaButton, expected = null }) {
  if (viaButton) {
    // Click as soon as React has wired the button (images still loading).
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => Object.keys(b).some((k) => k.startsWith("__reactProps"))), null, { timeout: 30000 });
    await page.evaluate(() => { window.__printed = new Promise((r) => { window.print = () => r(true); }); });
    await page.getByRole("button", { name: viaButton }).first().click();
    await Promise.race([page.evaluate(() => window.__printed), page.waitForTimeout(45000)]);
  } else {
    // Ctrl/Cmd+P: beforeprint fires in a real browser, not in page.pdf().
    await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  }
  await page.emulateMedia({ media: "print" });
  const dom = await figuresOnPage(page);
  const bytes = await page.pdf({ path: `${OUT}${name}.pdf`, format: "Letter", preferCSSPageSize: true });
  await page.emulateMedia({ media: null });
  const pdf = await pdfImageStats(bytes);
  const problems = [];
  // The page itself can lose figures (rows not rendered): compare with the DB too.
  if (expected != null && dom.total < expected) problems.push(`${name}: only ${dom.total} of ${expected} figures are on the printed page`);
  if (expected != null && pdf.images < expected) problems.push(`${name}: ${expected - Math.min(pdf.images, expected)} of ${expected} figures missing from the PDF`);
  else if (pdf.images < dom.total) problems.push(`${name}: ${dom.total - pdf.images} of ${dom.total} figures missing from the PDF`);
  if (pdf.blank) problems.push(`${name}: ${pdf.blank} blank image(s) in the PDF`);
  if (dom.broken.length) problems.push(`${name}: figures didn't load (${dom.broken.join(", ")})`);
  if (pdf.split.length) problems.push(`${name}: figure cut across a page break (${pdf.split.join("; ")})`);
  const small = dom.graphChoiceWidthsIn.filter((w) => w < 1.5);
  if (small.length) problems.push(`${name}: graph answer choices print only ${small.join(", ")}in wide`);
  return { problems, note: `${name} ${pdf.images}/${expected ?? dom.total} figures, ${pdf.pages}p` };
}

/** Distinct figure + graph-choice images in a submission's whole attempt (all modules). */
export async function figuresInAttempt(submissionId) {
  const { data: sub } = await db.from("submissions").select("id, session_id").eq("id", submissionId).single();
  const ids = sub.session_id
    ? ((await db.from("submissions").select("id, status").eq("session_id", sub.session_id)).data ?? []).filter((r) => ["Submitted", "Late"].includes(r.status)).map((r) => r.id)
    : [sub.id];
  const { data: recs } = await db.from("answer_records").select("questions!inner(image_urls, choices)").in("submission_id", ids);
  const urls = new Set();
  for (const r of recs ?? []) {
    for (const u of r.questions.image_urls ?? []) urls.add(u);
    for (const c of r.questions.choices ?? []) if (c?.image_url) urls.add(c.image_url);
  }
  return urls.size;
}

/** QA tests to print: the two QA math tests with the most figures, plus any with graph answer choices. */
async function pickTests(TESTS) {
  const ids = [TESTS.mathLinear, TESTS.adaptive];
  const { data: qaTests } = await db.from("tests").select("id, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, status").in("id", Object.values(TESTS));
  for (const t of qaTests ?? []) {
    const mods = [t.module_id, t.module_2_id, t.module_1_id, t.module_2_easy_id, t.module_2_hard_id].filter(Boolean);
    const { data: qs } = await db.from("questions").select("choices").in("module_id", mods);
    if ((qs ?? []).some((q) => (q.choices ?? []).some((c) => c?.image_url)) && !ids.includes(t.id)) ids.push(t.id);
  }
  return ids;
}

export async function runPrintChecks({ check, fail, TESTS, ADMIN_CLERK }) {
  mkdirSync(OUT, { recursive: true });

  await check("PRINT-PDF", [], "列印考卷（空白卷、含答案卷）和學生作答列印：PDF 裡每一張圖都在，沒有空白圖，圖沒有被切到兩頁", "列印", async () => {
    const b = await chromium.launch();
    const problems = [], notes = [];
    try {
      const { page } = await login(b, ADMIN_CLERK);
      await page.waitForLoadState("networkidle").catch(() => {});
      for (const id of await pickTests(TESTS)) {
        for (const key of [false, true]) {
          // Cold page, Print pressed at once: the button must wait for every figure.
          await page.goto(`${BASE}/print/tests/${id}${key ? "?key=1" : ""}`, { waitUntil: "domcontentloaded" });
          const r = await pdfVsPage(page, `test-${id.slice(0, 8)}-${key ? "key" : "blank"}`, { viaButton: /^Print$|Loading images/ });
          problems.push(...r.problems); notes.push(r.note);
        }
      }
      // A student's submitted test, as a teacher/admin prints it.
      const { data: sub } = await db.from("submissions").select("id, test_id").eq("test_id", TESTS.mathLinear).in("status", ["Submitted", "Late"]).order("submitted_at", { ascending: false }).limit(1).maybeSingle();
      if (!sub) problems.push("no submitted QA attempt on the math test to print");
      else {
        const url = `${BASE}/teacher/tests/${sub.test_id}/results/${sub.id}`;
        const expected = await figuresInAttempt(sub.id);
        await page.goto(url, { waitUntil: "networkidle" });
        let r = await pdfVsPage(page, `submission-${sub.id.slice(0, 8)}-ctrlP`, { viaButton: null, expected });
        problems.push(...r.problems); notes.push(r.note);
        // (The Print link opens the result printout preview: PRINT-RESULT.)
      }
    } finally {
      await b.close().catch(() => {});
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 10 * 60 * 1000);

  await check("PRINT-RESULT", [], "列印學生作答結果（預覽、下載 PDF、成績 CSV）：每張圖都在、分數和畫面上一樣、PDF 頁數和預覽一樣", "列印", async () => {
    const b = await chromium.launch();
    const problems = [], notes = [];
    try {
      const { page } = await login(b, ADMIN_CLERK);
      await page.waitForLoadState("networkidle").catch(() => {});
      const T = TESTS.mathLinear;
      const list = await page.request.get(`${BASE}/api/print/results/${T}/students`);
      const { students = [] } = list.ok() ? await list.json() : {};
      if (!students.length) fail(`no finished QA attempt to print (students API ${list.status()})`);
      const s = students[0];
      const expected = await figuresInAttempt(s.submissionId);
      // Preview (what Print prints).
      await page.goto(`${BASE}/print/results/${T}?subs=${s.submissionId}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.documentElement.dataset.printReady, null, { timeout: 90000 });
      const previewPages = Number(await page.evaluate(() => document.documentElement.dataset.printReady));
      const shown = await page.evaluate(() => {
        const sum = document.querySelector(".print-preview-pages .result-summary");
        return sum ? sum.textContent : "";
      });
      await page.emulateMedia({ media: "print" });
      const bytes = await page.pdf({ path: `${OUT}result-${s.submissionId.slice(0, 8)}-preview.pdf`, preferCSSPageSize: true });
      await page.emulateMedia({ media: null });
      const pdf = await pdfImageStats(bytes);
      if (pdf.images < expected) problems.push(`preview PDF: ${expected - pdf.images} of ${expected} figures missing`);
      if (pdf.split.length) problems.push(`preview PDF: figure cut across pages (${pdf.split.join("; ")})`);
      if (pdf.pages !== previewPages) problems.push(`preview shows ${previewPages} pages but prints ${pdf.pages}`);
      // Numbers = the admin results screen.
      await page.goto(`${BASE}/admin/tests/${T}/submissions`, { waitUntil: "networkidle" });
      const row = await page.locator("tr", { hasText: s.studentName }).first().innerText().catch(() => "");
      const sat = (row.match(/\b([2-8]\d0)\b/) ?? [])[1];
      const mods = (row.match(/M1 \d+\/\d+ · M2 \d+\/\d+|\b\d+\/\d+\b/) ?? [])[0];
      if (!sat || !shown.includes(sat)) problems.push(`SAT score on paper doesn't match the results screen (${sat ?? "none"} on screen)`);
      if (!mods || !shown.replace(/\s+/g, " ").includes(mods)) problems.push(`module counts on paper don't match the results screen (${mods ?? "none"} on screen)`);
      // Server PDF download = same document.
      const r = await page.request.get(`${BASE}/api/print/results/${T}/pdf?sub=${s.submissionId}`, { timeout: 120000 });
      if (!r.ok()) problems.push(`PDF download failed: HTTP ${r.status()}`);
      else {
        const dl = await pdfImageStats(await r.body());
        if (dl.images < expected) problems.push(`downloaded PDF: ${expected - dl.images} of ${expected} figures missing`);
        if (dl.pages !== previewPages) problems.push(`downloaded PDF has ${dl.pages} pages, preview ${previewPages}`);
        notes.push(`download ${dl.images}/${expected} figures ${dl.pages}p`);
      }
      // CSV summary carries the same score.
      const csv = await page.request.get(`${BASE}/api/print/results/${T}/summary?subs=${s.submissionId}`);
      const text = csv.ok() ? await csv.text() : "";
      if (!text.startsWith("\uFEFF") || !text.includes(s.studentName) || (sat && !text.includes(`,${sat},`))) problems.push(`score CSV doesn't match (HTTP ${csv.status()})`);
      notes.push(`${s.studentName}: preview ${pdf.images}/${expected} figures ${previewPages}p, SAT ${sat}, ${mods}`);
    } finally {
      await b.close().catch(() => {});
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 6 * 60 * 1000);

  await check("PRINT-WEBKIT", [], "用 Safari 的引擎列印考卷：列印模式下每一張圖都有載入、有顯示", "列印", async () => {
    const b = await webkit.launch();
    const problems = [], notes = [];
    try {
      const { page } = await login(b, ADMIN_CLERK);
      await page.waitForLoadState("networkidle").catch(() => {});
      for (const id of [TESTS.mathLinear, TESTS.adaptive]) {
        // The post-login redirect can still be in flight: retry an interrupted navigation once.
        await page.goto(`${BASE}/print/tests/${id}`, { waitUntil: "networkidle" })
          .catch(() => page.goto(`${BASE}/print/tests/${id}`, { waitUntil: "networkidle" }));
        await page.waitForFunction(() => document.documentElement.dataset.printReady, null, { timeout: 90000 }).catch(() => {});
        const want = await page.evaluate(() => new Set([...document.querySelectorAll(".print-source img")].map((i) => i.src)).size);
        await page.emulateMedia({ media: "print" });
        const dom = await figuresOnPage(page);
        if (dom.total < want) problems.push(`${id.slice(0, 8)}: only ${dom.total} of ${want} figures on the printed pages`);
        const hidden = await page.evaluate(() => [...document.images].filter((i) => i.src.includes("/api/blob-image") && !i.closest(".print-source"))
          .filter((i) => { const r = i.getBoundingClientRect(); return r.width < 20 || r.height < 20; }).map((i) => i.alt));
        await page.emulateMedia({ media: null });
        if (dom.broken.length) problems.push(`${id.slice(0, 8)}: not loaded ${dom.broken.join(", ")}`);
        if (hidden.length) problems.push(`${id.slice(0, 8)}: not shown in print ${hidden.join(", ")}`);
        notes.push(`${id.slice(0, 8)} ${dom.total}/${want} figures`);
      }
    } finally {
      await b.close().catch(() => {});
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 5 * 60 * 1000);
}

// Standalone run.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const { cast } = await import("../lib.mjs");
  const TESTS = JSON.parse(readFileSync(new URL("../../tests.json", import.meta.url), "utf-8"));
  let failed = 0;
  const check = async (id, _f, title, _a, fn) => {
    try { console.log(`PASS ${id}: ${await fn()}`); }
    catch (e) { failed++; console.log(`${e.__fail ? "FAIL" : "ERROR"} ${id}: ${e.__details ?? e.stack}`); }
  };
  const fail = (d) => { const e = new Error(d); e.__fail = true; e.__details = d; throw e; };
  await runPrintChecks({ check, fail, TESTS, ADMIN_CLERK: cast().admins[0].clerkId });
  process.exit(failed ? 1 : 0);
}
