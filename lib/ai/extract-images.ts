// ────────────────────────────────────────────
// Question image extraction
// ────────────────────────────────────────────
//
// Given a PDF (as base64) and the parser's per-question bounding boxes,
// render each referenced PDF page once with pdfjs-dist + @napi-rs/canvas,
// crop every region with sharp, and upload the cropped PNGs to a PUBLIC
// Vercel Blob store so students can render them in <img> tags without
// signed-URL juggling.
//
// Returns a Map keyed by original_question_number → list of public URLs.
// Bounding boxes that fall outside the page or have non-positive area
// are silently skipped so a single bad bbox cannot fail the whole parse.

import { put } from "@vercel/blob";
import sharp from "sharp";
import type { ParsedQuestion } from "./parse-pdf";
import { clampToZones, figureExclusionZones, overlapsCheckMark, readPrintoutLayout, type Rect } from "@/lib/printout-layout";

// Render each PDF page at this DPI before cropping. 200 DPI gives crisp
// graphs/tables without bloating cold-start memory.
const RENDER_DPI = 200;
const PDF_BASE_DPI = 72;
const RENDER_SCALE = RENDER_DPI / PDF_BASE_DPI;

export interface ExtractedImage {
  questionNumber: number;
  url: string;
  alt: string;
}

type ChoiceLabel = "A" | "B" | "C" | "D";

export interface ExtractImagesResult {
  /**
   * urls/alts = the question's own figures (→ questions.image_urls). Regions
   * tagged with a choice_label (graph answer choices) land in choiceUrls
   * instead, one crop per choice (→ choices[i].image_url).
   */
  byQuestion: Map<number, { urls: string[]; alts: string[]; choiceUrls: Partial<Record<ChoiceLabel, string>> }>;
  /** Questions with a crop that still overlaps a ✓ answer mark → Needs Review. */
  checkMarkLeaks: Set<number>;
  totalUploaded: number;
  errors: string[];
}

/**
 * Renders the requested PDF pages to PNG buffers using pdfjs-dist + the
 * @napi-rs/canvas factory pdfjs-dist v5 ships with native node support for.
 */
export async function renderPdfPages(
  pdfBase64: string,
  pageNumbers: Set<number>,
): Promise<Map<number, { png: Buffer; widthPx: number; heightPx: number }>> {
  // pdfjs-dist v5 references DOMMatrix at module-evaluation time but
  // some Vercel function runtimes (the smaller image used for short
  // routes) don't ship the global. Pre-load the DOMMatrix from
  // @napi-rs/canvas (which we already depend on for rendering) so
  // the pdfjs import doesn't throw "ReferenceError: DOMMatrix is
  // not defined" before we get a chance to use it.
  if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === "undefined") {
    try {
      const canvasModule = await import("@napi-rs/canvas");
      (globalThis as { DOMMatrix?: unknown }).DOMMatrix =
        (canvasModule as { DOMMatrix?: unknown }).DOMMatrix;
    } catch {
      // No napi canvas — proceed and let pdfjs throw a clearer
      // error than the original "DOMMatrix is not defined".
    }
  }

  // pdfjs-dist v5 ships its node-friendly entry as `pdf.mjs`. Importing the
  // top-level package picks the correct build automatically.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // pdfjs' fake worker loads its code with a dynamic `import(workerSrc)` off
  // a COMPUTED path, which Next's file tracer can't follow — so on Vercel the
  // package's own pdf.worker.mjs gets dropped from the function bundle and the
  // cropper dies with "Cannot find module …/pdf.worker.mjs". We vendor the
  // worker into the repo (lib/ai/pdf-worker.mjs) and point workerSrc at it via
  // `new URL(rel, import.meta.url)` — a pattern Next/webpack recognise and emit
  // as a real asset next to the compiled function, so the file always ships.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsAny = pdfjs as any;
  pdfjsAny.GlobalWorkerOptions.workerSrc = new URL(
    "./pdf-worker.mjs",
    import.meta.url,
  ).href;

  const data = Uint8Array.from(Buffer.from(pdfBase64, "base64"));
  // Vercel serverless doesn't bundle pdf.worker.mjs into the function
  // tarball — the dynamic import("pdfjs-dist/legacy/build/pdf.worker.mjs")
  // inside pdfjs fails with "Cannot find module …/pdf.worker.mjs"
  // and the cropper reports "PDF render failed: Setting up fake
  // worker failed". `disableWorker: true` tells pdfjs to do all
  // parsing on the main thread inline — slower per-page but the
  // tradeoff is the only path that works without bundling the
  // worker as a static asset.
  // The pdfjs `DocumentInitParameters` type ships without
  // `disableWorker` but the runtime accepts it; cast through unknown
  // to silence the type checker without losing the rest of the param
  // shape.
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableWorker: true,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await loadingTask.promise;

  // pdfjs-dist v5 auto-selects its built-in NodeCanvasFactory (powered by
  // @napi-rs/canvas) when running in Node, and `PDFDocumentProxy.canvasFactory`
  // exposes the live instance. We use it directly to allocate a canvas per
  // page so we can encode the result to PNG ourselves.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvasFactory = (doc as any).canvasFactory as {
    create(width: number, height: number): {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      canvas: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      context: any;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    destroy(arg: any): void;
  };

  const out = new Map<number, { png: Buffer; widthPx: number; heightPx: number }>();
  for (const pageNum of pageNumbers) {
    if (pageNum < 1 || pageNum > doc.numPages) continue;
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const widthPx = Math.ceil(viewport.width);
    const heightPx = Math.ceil(viewport.height);

    const canvasAndContext = canvasFactory.create(widthPx, heightPx);
    await page.render({
      canvas: canvasAndContext.canvas,
      canvasContext: canvasAndContext.context,
      viewport,
    }).promise;

    // @napi-rs/canvas exposes encode("png") returning a Buffer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const png: Buffer = await (canvasAndContext.canvas as any).encode("png");
    out.set(pageNum, { png, widthPx, heightPx });

    canvasFactory.destroy(canvasAndContext);
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

/**
 * Crop a single bounding box (fractions of page) out of the rendered page
 * PNG using sharp. Returns null if the bbox is invalid or zero-area.
 */
const DEFAULT_PAD = 0.015;

async function cropRegion(
  pagePng: Buffer,
  widthPx: number,
  heightPx: number,
  region: { x_pct: number; y_pct: number; w_pct: number; h_pct: number; pad?: number },
): Promise<Buffer | null> {
  // Pad the AI's bbox by ~1.5% of the page on every side, clamped to the
  // page, so a slightly-tight box doesn't clip the figure (e.g. the bottom
  // of a graph). Was 2.5% — on top of the model's own slack that pulled in
  // the previous question's last choice (with its ✓ answer mark) and the
  // page header; boxes are now also clamped to the question's own region
  // from the PDF text layer (see clampRegions). Regions measured from the
  // PDF itself (lib/printout-parser.ts) are exact and carry their own pad.
  const PAD_PCT = region.pad ?? DEFAULT_PAD;
  const padX = PAD_PCT * widthPx;
  const padY = PAD_PCT * heightPx;
  const left = Math.max(0, Math.floor(region.x_pct * widthPx - padX));
  const top = Math.max(0, Math.floor(region.y_pct * heightPx - padY));
  const right = Math.min(
    widthPx,
    Math.ceil((region.x_pct + region.w_pct) * widthPx + padX),
  );
  const bottom = Math.min(
    heightPx,
    Math.ceil((region.y_pct + region.h_pct) * heightPx + padY),
  );
  const width = right - left;
  const height = bottom - top;
  if (width <= 4 || height <= 4) return null;
  try {
    return await sharp(pagePng)
      .extract({ left, top, width, height })
      .png({ compressionLevel: 8 })
      .toBuffer();
  } catch (err) {
    console.warn("[extract-images] crop failed:", err);
    return null;
  }
}

// A GFM table needs a header row of pipes AND a dash separator row
// (| --- | --- |). A single line with pipes is not enough.
export function hasMarkdownTable(text: string | null | undefined): boolean {
  if (!text) return false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue;
    const sep = lines[i + 1].trim();
    if (/^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(sep)) return true;
  }
  return false;
}

// Alt text is shown to students; never let it carry an answer hint
// ("Graph C … (correct answer)", "✓").
export function sanitizeFigureAlt(alt: string | null | undefined): string {
  return (alt ?? "")
    .replace(/\(?\s*\b(the\s+)?(correct|right|wrong|incorrect)\s+(answer|choice|option)\b\s*\)?/gi, "")
    .replace(/\(?\s*\b(marked|checked)\s+(as\s+)?(correct|the answer)\b\s*\)?/gi, "")
    .replace(/[\u2713\u2714\u2705\u2611]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

/**
 * Model-drawn regions (no explicit `pad`) are approximate. When the PDF has a
 * text layer, clamp each one to its question's own area: never across a
 * question-number bar, a ✓ answer line / answered frame, or the page
 * header/footer. Exact regions measured from the PDF are left alone. Then
 * check EVERY region's final crop box: one that still overlaps a ✓ answer
 * mark is reported (question numbers) so the caller can send it to review.
 */
async function clampRegions(pdfBase64: string, questions: ParsedQuestion[]): Promise<Set<number>> {
  const leaks = new Set<number>();
  let layout;
  try {
    layout = await readPrintoutLayout(pdfBase64);
  } catch (err) {
    console.warn("[extract-images] text layer unreadable, regions not clamped:", err);
    return leaks;
  }
  if (layout.pages.length === 0) return leaks; // scanned PDF — no text layer
  const zones = figureExclusionZones(layout);
  for (const q of questions) {
    for (const r of q.image_regions ?? []) {
      const page = Math.floor(r.page);
      const dims = layout.pages[page - 1];
      if (!dims) continue;
      const zonesHere = zones.filter((z) => z.page === page);
      // The box the cropper will actually cut (region + its pad).
      const pad = r.pad ?? DEFAULT_PAD;
      const box: Rect = {
        x0: Math.max(0, r.x_pct - pad) * dims.width,
        y0: Math.max(0, r.y_pct - pad) * dims.height,
        x1: Math.min(1, r.x_pct + r.w_pct + pad) * dims.width,
        y1: Math.min(1, r.y_pct + r.h_pct + pad) * dims.height,
      };
      let final = box;
      if (r.pad == null) {
        final = clampToZones(box, zonesHere);
        if (final !== box) {
          r.x_pct = final.x0 / dims.width;
          r.w_pct = (final.x1 - final.x0) / dims.width;
          r.y_pct = final.y0 / dims.height;
          r.h_pct = (final.y1 - final.y0) / dims.height;
          r.pad = 0;
        }
      }
      if (overlapsCheckMark(final, zonesHere)) leaks.add(q.original_question_number);
    }
  }
  return leaks;
}

const TABLE_ALT = /\btable\b/i;
const NON_TABLE_FIGURE_ALT = /\b(graph|plot|scatter|diagram|figure|chart|number line|triangle|circle|rectangle|polygon|geometr|coordinate|histogram|bar|curve|parabola|map|drawing|photo|image of)/i;
const FULL_PAGE_FALLBACK_ALT = /full-page fallback/i;

/**
 * True when a region would just screenshot a table the parser already rebuilt
 * as a Markdown table in the stem — the student would see the table twice.
 * Real figures (graphs/diagrams) on the same question are kept.
 */
export function isRedundantTableRegion(
  q: Pick<ParsedQuestion, "question_text" | "has_image">,
  region: { alt?: string | null },
): boolean {
  if (!hasMarkdownTable(q.question_text)) return false;
  const alt = region.alt ?? "";
  if (TABLE_ALT.test(alt) && !NON_TABLE_FIGURE_ALT.test(alt)) return true;
  // Full-page fallback stamped only because of has_table → the table is in the text.
  return FULL_PAGE_FALLBACK_ALT.test(alt) && !q.has_image;
}

/**
 * Main entry. Renders + crops + uploads in one pass.
 *
 * `moduleId` is used as the Blob path prefix so a delete-module flow can
 * later sweep the corresponding `images/${moduleId}/*` objects.
 */
export async function extractAndUploadQuestionImages(
  pdfBase64: string,
  questions: ParsedQuestion[],
  moduleId: string,
): Promise<ExtractImagesResult> {
  const errors: string[] = [];
  const byQuestion: ExtractImagesResult["byQuestion"] = new Map();

  // Drop regions that only re-screenshot a table already in the stem as
  // Markdown, then collect every unique page referenced by any image_region.
  // (A graph-choice crop is never a stem table screenshot.)
  const regionsFor = (q: ParsedQuestion) =>
    (q.image_regions ?? []).filter((r) => r.choice_label || !isRedundantTableRegion(q, r));
  const pageSet = new Set<number>();
  for (const q of questions) {
    for (const r of regionsFor(q)) {
      if (Number.isFinite(r.page) && r.page >= 1) pageSet.add(Math.floor(r.page));
    }
  }
  if (pageSet.size === 0) {
    return { byQuestion, totalUploaded: 0, errors, checkMarkLeaks: new Set() };
  }
  const checkMarkLeaks = await clampRegions(pdfBase64, questions);

  // Public store for question images. Falls back to the same token used for
  // the private PDF store if the dedicated public token isn't configured —
  // the upload itself still uses access:"public" so the resulting URL is
  // freely readable, but operators are encouraged to provision a separate
  // store via PUBLIC_BLOB_READ_WRITE_TOKEN for cleaner billing/lifecycle.
  const publicToken =
    process.env.PUBLIC_BLOB_READ_WRITE_TOKEN ??
    process.env.BLOB_READ_WRITE_TOKEN;
  if (!publicToken) {
    errors.push("No Vercel Blob token configured for image uploads");
    return { byQuestion, totalUploaded: 0, errors, checkMarkLeaks };
  }

  let renderedPages: Map<number, { png: Buffer; widthPx: number; heightPx: number }>;
  try {
    renderedPages = await renderPdfPages(pdfBase64, pageSet);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[extract-images] PDF render failed:", err);
    errors.push(`PDF render failed: ${msg}`);
    return { byQuestion, totalUploaded: 0, errors, checkMarkLeaks };
  }

  let totalUploaded = 0;
  for (const q of questions) {
    const regions = regionsFor(q);
    if (regions.length === 0) continue;
    const urls: string[] = [];
    const alts: string[] = [];
    const choiceUrls: Partial<Record<ChoiceLabel, string>> = {};
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      const rendered = renderedPages.get(Math.floor(region.page));
      if (!rendered) continue;
      const cropped = await cropRegion(
        rendered.png,
        rendered.widthPx,
        rendered.heightPx,
        region,
      );
      if (!cropped) continue;
      // Try public first (preferred — students render <img> tags directly).
      // If the configured Blob store is provisioned as private (which it is
      // in this project today), the API rejects access:"public" — fall back
      // to access:"private" so the upload still succeeds. The solver passes
      // the bearer token when fetching, and a server-side proxy route can
      // sign URLs for the student renderer.
      const choiceLabel = region.choice_label ?? null;
      const blobKey = choiceLabel
        ? `images/${moduleId}/${q.original_question_number}-choice-${choiceLabel}.png`
        : `images/${moduleId}/${q.original_question_number}-${i}.png`;
      let uploadedUrl: string | null = null;
      let lastErr: unknown = null;
      for (const access of ["public", "private"] as const) {
        try {
          const blob = await put(blobKey, cropped, {
            access,
            addRandomSuffix: true,
            contentType: "image/png",
            token: publicToken,
          });
          uploadedUrl = blob.url;
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          // Only retry as private when the store-config error fires — every
          // other error (network, auth, quota) should bail immediately.
          if (!/private store|public access/i.test(msg)) break;
        }
      }
      if (uploadedUrl) {
        if (choiceLabel) {
          // One crop per choice; a duplicate box for the same choice is dropped.
          choiceUrls[choiceLabel] ??= uploadedUrl;
        } else {
          urls.push(uploadedUrl);
          alts.push(sanitizeFigureAlt(region.alt));
        }
        totalUploaded++;
      } else {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        console.warn(
          `[extract-images] upload failed for q${q.original_question_number}#${i}: ${msg}`,
        );
        errors.push(`q${q.original_question_number}#${i}: ${msg}`);
      }
    }
    if (urls.length > 0 || Object.keys(choiceUrls).length > 0) {
      byQuestion.set(q.original_question_number, { urls, alts, choiceUrls });
    }
  }

  if (totalUploaded === 0) {
    const expected = questions.filter(
      (q) => (q.image_regions?.length ?? 0) > 0,
    ).length;
    console.warn(
      `[extract-images] WARNING: 0 images uploaded for module ${moduleId} (${expected} questions had image_regions; ${errors.length} errors). First 3 errors: ${errors.slice(0, 3).join(" | ")}`,
    );
  } else {
    console.log(
      `[extract-images] uploaded ${totalUploaded} images across ${byQuestion.size} questions for module ${moduleId}`,
    );
  }

  return { byQuestion, totalUploaded, errors, checkMarkLeaks };
}
