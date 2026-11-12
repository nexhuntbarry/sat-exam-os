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

/**
 * The paginated preview (Paged.js) — what Print and the server PDF print.
 * Every figure of the hidden source must be on a page, loaded, and inside
 * its page's content area (a keep-together block taller than a page is
 * clipped by Paged.js, losing its bottom). printFailed = images the page
 * itself gave up on after its retries.
 */
export const pagedFigures = (page) =>
  page.evaluate(() => {
    const src = [...document.querySelectorAll(".print-source img")];
    const paged = [...document.querySelectorAll(".print-preview-pages img")];
    const notLoaded = [], clipped = [];
    for (const i of paged) {
      if (!(i.complete && i.naturalWidth > 0)) { notLoaded.push(i.alt); continue; }
      const area = i.closest(".pagedjs_page_content")?.getBoundingClientRect();
      const r = i.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) notLoaded.push(`${i.alt} (0 size)`);
      else if (area && (r.bottom > area.bottom + 1 || r.right > area.right + 1)) clipped.push(`${i.alt} (${Math.round(Math.max(r.bottom - area.bottom, r.right - area.right))}px outside the page)`);
    }
    return {
      src: src.length,
      srcDistinct: new Set(src.map((i) => i.getAttribute("src"))).size,
      paged: paged.length,
      notLoaded,
      clipped,
      failed: document.documentElement.dataset.printFailed ?? "",
      pages: Number(document.documentElement.dataset.printReady ?? 0),
    };
  });

/** Problems in a preview's figures (a pagedFigures result), worded for the report. */
export function pagedProblems(name, f) {
  const p = [];
  if (f.failed) p.push(`${name}: the page gave up on figures (${f.failed.slice(0, 200)})`);
  if (f.paged < f.src) p.push(`${name}: ${f.src - f.paged} of ${f.src} figures didn't make it onto the printed pages`);
  if (f.notLoaded.length) p.push(`${name}: figures not loaded on the printed pages (${f.notLoaded.slice(0, 5).join(", ")})`);
  if (f.clipped.length) p.push(`${name}: figure cut off at the page edge (${f.clipped.slice(0, 5).join(", ")})`);
  return p;
}

/** Wait for the preview to finish. A frozen tab (main thread never answers) is reported as such. */
export async function waitPreview(page, timeout = 90000) {
  // Raced with a timer of our own: on a frozen tab Playwright's own timeout never fires.
  const ok = await Promise.race([
    page.waitForFunction(() => document.documentElement.dataset.printReady || document.documentElement.dataset.printFailed, null, { timeout, polling: 500 })
      .then(() => true).catch(() => false),
    new Promise((r) => setTimeout(() => r(false), timeout + 5000)),
  ]);
  if (ok) return null;
  const status = await Promise.race([
    page.evaluate(() => document.querySelector("[aria-live]")?.textContent ?? "?").catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);
  return status == null ? "the print preview tab froze (its main thread stopped responding)" : `the print preview never finished ("${status}")`;
}

/** Distinct figure + graph-choice image URLs of a submission's whole attempt (all modules). */
export async function figureUrlsInAttempt(submissionId) {
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
  return urls;
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
  return (await figureUrlsInAttempt(submissionId)).size;
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

export async function runPrintChecks({ check, fail, TESTS, ADMIN_CLERK, REAL_ADMIN_CLERK = null, STUDENT1_CLERK = null, C = null }) {
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
          const name = `test-${id.slice(0, 8)}-${key ? "key" : "blank"}`;
          const r = await pdfVsPage(page, name, { viaButton: /^Print$|Loading images/ });
          problems.push(...r.problems); notes.push(r.note);
          problems.push(...pagedProblems(name, await pagedFigures(page)));
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
      const stuck = await waitPreview(page);
      if (stuck) fail(`result preview: ${stuck}`);
      const previewPages = Number(await page.evaluate(() => document.documentElement.dataset.printReady));
      problems.push(...pagedProblems("result preview", await pagedFigures(page)));
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

  // The image proxy is authorised by Clerk's 60-second session cookie; an
  // <img> fetched while it has lapsed (laptop waking up, resumed tab) gets
  // 401 and is never asked for again. Simulate exactly that: the first
  // request of every figure answers 401. The page must retry (after a
  // session refresh) and still print every figure.
  await check("PRINT-SESSION", [], "登入憑證剛好過期時列印（每張圖第一次載入都被拒）：預覽會自動重試，PDF 裡每一張圖都在", "列印", async () => {
    const b = await chromium.launch();
    const problems = [], notes = [];
    try {
      const { page, context } = await login(b, ADMIN_CLERK);
      await page.waitForLoadState("networkidle").catch(() => {});
      const seen = new Set();
      let refused = 0, retried = 0;
      await context.route(/\/api\/blob-image\?/, (route) => {
        const u = new URL(route.request().url());
        if (u.searchParams.has("_retry")) { retried++; return route.continue(); }
        const key = u.searchParams.get("u");
        if (!seen.has(key)) { seen.add(key); refused++; return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Unauthenticated"}' }); }
        return route.continue();
      });
      for (const [name, url] of [["test", `/print/tests/${TESTS.mathLinear}`], ["test-graph-choices", `/print/tests/${TESTS.shortTimer}`]]) {
        seen.clear();
        await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
        const stuck = await waitPreview(page);
        if (stuck) { problems.push(`${name}: ${stuck}`); break; } // a frozen tab can't be reused
        const f = await pagedFigures(page);
        problems.push(...pagedProblems(name, f));
        await page.emulateMedia({ media: "print" });
        const pdf = await pdfImageStats(await page.pdf({ path: `${OUT}session-${name}.pdf`, preferCSSPageSize: true }));
        await page.emulateMedia({ media: null });
        if (pdf.images < f.srcDistinct) problems.push(`${name}: ${f.srcDistinct - pdf.images} of ${f.srcDistinct} figures missing from the PDF after a refused first load`);
        notes.push(`${name} ${pdf.images}/${f.srcDistinct} figures`);
      }
      if (refused === 0) problems.push("no figure request was seen (nothing tested)");
      notes.push(`${refused} first loads refused, ${retried} retries`);
    } finally {
      await b.close().catch(() => {});
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 6 * 60 * 1000);

  // Print all: every finished QA attempt on the math test in one preview —
  // the union of their figures must all be in the PDF, none cut at a page edge.
  await check("PRINT-ALL", [], "「列印全部學生」預覽：所有學生作答裡的每一張圖都在 PDF 裡，沒有被頁面切掉", "列印", async () => {
    const b = await chromium.launch();
    const problems = [], notes = [];
    try {
      const { page } = await login(b, ADMIN_CLERK);
      await page.waitForLoadState("networkidle").catch(() => {});
      const T = TESTS.mathLinear;
      const list = await page.request.get(`${BASE}/api/print/results/${T}/students`);
      const { students = [] } = list.ok() ? await list.json() : {};
      const pick = students.slice(0, 12);
      if (pick.length < 2) fail(`need 2+ finished QA attempts to print together (students API ${list.status()}, ${students.length})`);
      const want = new Set();
      for (const s of pick) for (const u of await figureUrlsInAttempt(s.submissionId)) want.add(u);
      await page.goto(`${BASE}/print/results/${T}?subs=${pick.map((s) => s.submissionId).join(",")}`, { waitUntil: "domcontentloaded" });
      const stuck = await waitPreview(page, 180000);
      if (stuck) fail(`Print all (${pick.length} students): ${stuck}`);
      const f = await pagedFigures(page);
      problems.push(...pagedProblems("Print all", f));
      await page.emulateMedia({ media: "print" });
      const pdf = await pdfImageStats(await page.pdf({ path: `${OUT}result-all-${T.slice(0, 8)}.pdf`, preferCSSPageSize: true }));
      await page.emulateMedia({ media: null });
      if (pdf.images < want.size) problems.push(`Print all PDF: ${want.size - pdf.images} of ${want.size} figures missing`);
      if (pdf.pages !== f.pages) problems.push(`Print all: preview shows ${f.pages} pages but prints ${pdf.pages}`);
      notes.push(`${pick.length} students, ${pdf.images}/${want.size} figures (${f.paged} placed), ${pdf.pages}p`);
    } finally {
      await b.close().catch(() => {});
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 8 * 60 * 1000);

  // Real tests (read-only, the owner's admin view): every published test with
  // figures or graph answer choices. QA fixtures only hold a few copies; the
  // live tests carry the real figure sizes, names and lengths (a test name
  // with a double space froze this preview for two live tests in Nov 2026).
  if (REAL_ADMIN_CLERK) await check("PRINT-REAL", [], "真實已發布測驗的空白卷列印（唯讀）：每份都能開出預覽（不卡住），每張圖、圖形選項都在 PDF 裡，沒有被頁面切掉", "列印", async () => {
    const b = await chromium.launch();
    const problems = [], notes = [];
    try {
      const { context } = await login(b, REAL_ADMIN_CLERK);
      let page = context.pages()[0];
      await page.waitForLoadState("networkidle").catch(() => {});
      const { data: tests } = await db.from("tests").select("id, test_name, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, test_kind").eq("status", "Published").not("test_name", "ilike", "TEST %");
      let printed = 0;
      for (const t of tests ?? []) {
        if (t.test_kind === "fl_section") continue; // printed through its full-length parent
        const mods = [t.module_id, t.module_2_id, t.module_1_id, t.module_2_easy_id, t.module_2_hard_id].filter(Boolean);
        if (t.test_kind !== "full_length") {
          const { data: qs } = await db.from("questions").select("image_urls, choices").in("module_id", mods).eq("parsing_status", "Approved");
          if (!(qs ?? []).some((q) => (q.image_urls ?? []).length || (q.choices ?? []).some((c) => c?.image_url))) continue;
        }
        const name = `real-${t.id.slice(0, 8)}`;
        await page.goto(`${BASE}/print/tests/${t.id}`, { waitUntil: "domcontentloaded" });
        const stuck = await waitPreview(page, 60000);
        if (stuck) {
          problems.push(`"${t.test_name}": ${stuck}`);
          // A frozen tab can't be reused (and may not even close quickly).
          await Promise.race([page.close({ runBeforeUnload: false }).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
          page = await context.newPage();
          continue;
        }
        const f = await pagedFigures(page);
        problems.push(...pagedProblems(`"${t.test_name}"`, f));
        await page.emulateMedia({ media: "print" });
        const pdf = await pdfImageStats(await page.pdf({ preferCSSPageSize: true }));
        await page.emulateMedia({ media: null });
        if (pdf.images < f.srcDistinct) problems.push(`"${t.test_name}": ${f.srcDistinct - pdf.images} of ${f.srcDistinct} figures missing from the PDF`);
        if (pdf.blank) problems.push(`"${t.test_name}": ${pdf.blank} blank image(s) in the PDF`);
        printed++;
        notes.push(`${name} ${pdf.images}/${f.srcDistinct} ${pdf.pages}p`);
      }
      if (printed === 0 && problems.length === 0) problems.push("no published test with figures found");
    } finally {
      await b.close().catch(() => {});
    }
    if (problems.length) fail(`${problems.slice(0, 10).join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 15 * 60 * 1000);

  // The student's own result page (closed <details> rows), Ctrl/Cmd+P.
  if (STUDENT1_CLERK && C) await check("PRINT-STUDENT", [], "學生自己的成績頁按 Ctrl/Cmd+P：每一題都印出來，每張圖都在 PDF 裡", "列印", async () => {
    const T = TESTS.mathLinear;
    const { data: subRows } = await db.from("submissions").select("id, student_id").eq("test_id", T).in("status", ["Submitted", "Late"]).order("submitted_at", { ascending: false }).limit(20);
    const ids = new Set(C.students.map((s) => s.id));
    const sub = (subRows ?? []).find((s) => ids.has(s.student_id));
    if (!sub) fail("no finished QA student attempt on the math test");
    const expected = await figuresInAttempt(sub.id);
    const origS1Id = C.students[0].id;
    const { borrowLogin } = await import("../lib.mjs");
    await borrowLogin(sub.student_id, STUDENT1_CLERK);
    const b = await chromium.launch();
    const problems = [], notes = [];
    try {
      const { page } = await login(b, STUDENT1_CLERK);
      await page.goto(`${BASE}/student/tests/${T}/result`, { waitUntil: "networkidle" });
      // Answers not released to students on this test: nothing of the review prints (by design).
      if ((await page.locator("details[data-print-open]").count()) === 0) return "answer review not released to students on this test; nothing to print";
      const r = await pdfVsPage(page, `student-result-${sub.id.slice(0, 8)}-ctrlP`, { viaButton: null, expected });
      problems.push(...r.problems); notes.push(r.note);
      // Ctrl/Cmd+P before the page's script runs (slow load): no beforeprint
      // handler, so only print CSS can open the closed question rows. DOM
      // sizes don't show this (content-visibility), only the PDF does.
      const raw = await b.newContext({ storageState: await page.context().storageState(), javaScriptEnabled: false });
      const rp = await raw.newPage();
      await rp.goto(`${BASE}/student/tests/${T}/result`, { waitUntil: "load" });
      await rp.emulateMedia({ media: "print" });
      const pdf = await pdfImageStats(await rp.pdf({ path: `${OUT}student-result-${sub.id.slice(0, 8)}-nojs.pdf`, format: "Letter" }));
      if (pdf.images < expected) problems.push(`Ctrl/Cmd+P before the page finished loading: ${expected - pdf.images} of ${expected} figures missing (${pdf.pages} pages)`);
      notes.push(`before-load print ${pdf.images}/${expected} figures ${pdf.pages}p`);
      await raw.close();
    } finally {
      await b.close().catch(() => {});
      await borrowLogin(origS1Id, STUDENT1_CLERK).catch(() => {});
    }
    if (problems.length) fail(`${problems.join("; ")}. ${notes.join("; ")}`);
    return notes.join("; ");
  }, 5 * 60 * 1000);

  await check("PRINT-WEBKIT", [], "用 Safari 的引擎列印考卷：列印模式下每一張圖都有載入、有顯示", "列印", async () => {
    const b = await webkit.launch();
    const problems = [], notes = [];
    try {
      const { page } = await login(b, ADMIN_CLERK);
      await page.waitForLoadState("networkidle").catch(() => {});
      // Blank tests, a graph-choice test, and a student's result printout (Paged.js pages in WebKit).
      const list = await page.request.get(`${BASE}/api/print/results/${TESTS.mathLinear}/students`);
      const { students = [] } = list.ok() ? await list.json() : {};
      const urls = [TESTS.mathLinear, TESTS.adaptive, TESTS.shortTimer].map((id) => [id.slice(0, 8), `/print/tests/${id}`]);
      if (students[0]) urls.push([`result-${students[0].submissionId.slice(0, 8)}`, `/print/results/${TESTS.mathLinear}?subs=${students[0].submissionId}`]);
      for (const [id, path] of urls) {
        // The post-login redirect can still be in flight: retry an interrupted navigation once.
        await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" })
          .catch(() => page.goto(`${BASE}${path}`, { waitUntil: "networkidle" }));
        const stuck = await waitPreview(page);
        if (stuck) { problems.push(`${id}: ${stuck}`); break; } // a frozen tab can't be reused
        problems.push(...pagedProblems(id, await pagedFigures(page)));
        const want = await page.evaluate(() => new Set([...document.querySelectorAll(".print-source img")].map((i) => i.src)).size);
        await page.emulateMedia({ media: "print" });
        const dom = await figuresOnPage(page);
        if (dom.total < want) problems.push(`${id}: only ${dom.total} of ${want} figures on the printed pages`);
        const hidden = await page.evaluate(() => [...document.images].filter((i) => i.src.includes("/api/blob-image") && !i.closest(".print-source"))
          .filter((i) => { const r = i.getBoundingClientRect(); return r.width < 20 || r.height < 20; }).map((i) => i.alt));
        await page.emulateMedia({ media: null });
        if (dom.broken.length) problems.push(`${id}: not loaded ${dom.broken.join(", ")}`);
        if (hidden.length) problems.push(`${id}: not shown in print ${hidden.join(", ")}`);
        notes.push(`${id} ${dom.total}/${want} figures`);
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
  const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
  const check = async (id, _f, title, _a, fn) => {
    if (only.length && !only.includes(id)) return;
    try { console.log(`PASS ${id}: ${await fn()}`); }
    catch (e) { failed++; console.log(`${e.__fail ? "FAIL" : "ERROR"} ${id}: ${e.__details ?? e.stack}`); }
  };
  const fail = (d) => { const e = new Error(d); e.__fail = true; e.__details = d; throw e; };
  const C = cast();
  await runPrintChecks({
    check, fail, TESTS, C,
    ADMIN_CLERK: C.admins[0].clerkId,
    STUDENT1_CLERK: C.students[0].clerkId,
    REAL_ADMIN_CLERK: "user_3LvAA5udwaB4iYPlyTQvxdaokHL", // read-only, as in run.mjs
  });
  process.exit(failed ? 1 : 0);
}
