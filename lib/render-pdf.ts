// Server-side PDF of one of our print pages: headless Chromium opens the
// page (with a print ticket — lib/print-token), waits for the paginated
// preview to finish (html[data-print-ready]) and prints it, so the file is
// the exact document the on-screen preview shows. On Vercel the browser is
// @sparticuz/chromium (~66 MB, inside the 250 MB function limit); locally,
// PRINT_CHROME_PATH or the installed Google Chrome.
import type { Browser, Page } from "puppeteer-core";

let browser: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  const puppeteer = (await import("puppeteer-core")).default;
  // Platform, not env vars (.env.local pulled from Vercel sets VERCEL=1 locally).
  if (process.platform === "linux") {
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({
      args: puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      executablePath: await chromium.executablePath(),
      headless: "shell",
      defaultViewport: { width: 1200, height: 900 },
    });
  }
  return puppeteer.launch({
    executablePath: process.env.PRINT_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    defaultViewport: { width: 1200, height: 900 },
  });
}

/** One warm browser per function instance; relaunched if it died. */
async function getBrowser(): Promise<Browser> {
  if (browser) {
    const b = await browser.catch(() => null);
    if (b?.connected) return b;
  }
  browser = launch();
  return browser;
}

export class PdfRenderError extends Error {}

// At most this many pages render at once in one function instance; one
// shared Chromium per instance runs out of memory past that.
const MAX_OPEN_PAGES = 2;
let openPages = 0;
const waiters: (() => void)[] = [];
async function acquirePage(waitMs = 8_000): Promise<void> {
  if (openPages < MAX_OPEN_PAGES) {
    openPages++;
    return;
  }
  // The releaser hands its slot straight to us (no gap a newcomer can take).
  await new Promise<void>((res, rej) => {
    const waiter = () => {
      clearTimeout(timer);
      res();
    };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      rej(new PdfBusyError("busy"));
    }, waitMs);
    waiters.push(waiter);
  });
}
function releasePage(): void {
  const next = waiters.shift();
  if (next) next();
  else openPages--;
}

export class PdfBusyError extends Error {}

export async function renderPrintPdf(url: string, { timeoutMs = 50_000 } = {}): Promise<{ pdf: Uint8Array; pages: number }> {
  await acquirePage();
  let page: Page | null = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    // Two pages in one Chromium: only the focused one runs animation frames
    // (Paged.js), so the other would stall. Emulate focus for every page.
    await (await page.createCDPSession()).send("Emulation.setFocusEmulationEnabled", { enabled: true });
    // Question content is rendered HTML; never let it make the server's
    // browser fetch anything but our own origin (no SSRF, no exfiltration).
    const origin = new URL(url).origin;
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = r.url();
      let ok = u.startsWith("data:") || u.startsWith("blob:");
      if (!ok) {
        try {
          ok = new URL(u).origin === origin;
        } catch {
          ok = false;
        }
      }
      if (ok) r.continue().catch(() => {});
      else r.abort("blockedbyclient").catch(() => {});
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.printReady || document.documentElement.dataset.printFailed, { timeout: timeoutMs, polling: 250 });
    const { pages, failed } = await page.evaluate(() => ({
      pages: Number(document.documentElement.dataset.printReady),
      failed: document.documentElement.dataset.printFailed ?? "",
    }));
    // Never hand out a PDF that silently lacks a figure.
    if (failed) throw new PdfRenderError(failed === "layout" ? "layout" : `Images failed to load: ${failed}`);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    return { pdf, pages };
  } finally {
    await page?.close().catch(() => {});
    releasePage();
  }
}
