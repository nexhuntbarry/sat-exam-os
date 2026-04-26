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

export interface ExtractImagesResult {
  byQuestion: Map<number, { urls: string[]; alts: string[] }>;
  totalUploaded: number;
  errors: string[];
}

/**
 * Renders the requested PDF pages to PNG buffers using pdfjs-dist + the
 * @napi-rs/canvas factory pdfjs-dist v5 ships with native node support for.
 */
async function renderPdfPages(
  pdfBase64: string,
  pageNumbers: Set<number>,
): Promise<Map<number, { png: Buffer; widthPx: number; heightPx: number }>> {
  // pdfjs-dist v5 ships its node-friendly entry as `pdf.mjs`. Importing the
  // top-level package picks the correct build automatically.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // Disable the worker — Node.js can run the parser inline.
  // (Not setting workerSrc would log a noisy warning.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfjs as any).GlobalWorkerOptions.workerSrc = "";

  const data = Uint8Array.from(Buffer.from(pdfBase64, "base64"));
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  });
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
async function cropRegion(
  pagePng: Buffer,
  widthPx: number,
  heightPx: number,
  region: { x_pct: number; y_pct: number; w_pct: number; h_pct: number },
): Promise<Buffer | null> {
  const left = Math.max(0, Math.floor(region.x_pct * widthPx));
  const top = Math.max(0, Math.floor(region.y_pct * heightPx));
  const width = Math.min(widthPx - left, Math.ceil(region.w_pct * widthPx));
  const height = Math.min(heightPx - top, Math.ceil(region.h_pct * heightPx));
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
  const byQuestion = new Map<number, { urls: string[]; alts: string[] }>();

  // Collect every unique page referenced by any image_region.
  const pageSet = new Set<number>();
  for (const q of questions) {
    for (const r of q.image_regions ?? []) {
      if (Number.isFinite(r.page) && r.page >= 1) pageSet.add(Math.floor(r.page));
    }
  }
  if (pageSet.size === 0) {
    return { byQuestion, totalUploaded: 0, errors };
  }

  // Public store for question images. Falls back to the same token used for
  // the private PDF store if the dedicated public token isn't configured —
  // the upload itself still uses access:"public" so the resulting URL is
  // freely readable, but operators are encouraged to provision a separate
  // store via BLOB_READ_WRITE_TOKEN_PUBLIC for cleaner billing/lifecycle.
  const publicToken =
    process.env.BLOB_READ_WRITE_TOKEN_PUBLIC ??
    process.env.BLOB_READ_WRITE_TOKEN;
  if (!publicToken) {
    errors.push("No Vercel Blob token configured for image uploads");
    return { byQuestion, totalUploaded: 0, errors };
  }

  let renderedPages: Map<number, { png: Buffer; widthPx: number; heightPx: number }>;
  try {
    renderedPages = await renderPdfPages(pdfBase64, pageSet);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[extract-images] PDF render failed:", err);
    errors.push(`PDF render failed: ${msg}`);
    return { byQuestion, totalUploaded: 0, errors };
  }

  let totalUploaded = 0;
  for (const q of questions) {
    const regions = q.image_regions ?? [];
    if (regions.length === 0) continue;
    const urls: string[] = [];
    const alts: string[] = [];
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
      try {
        const blob = await put(
          `images/${moduleId}/${q.original_question_number}-${i}.png`,
          cropped,
          {
            access: "public",
            addRandomSuffix: true,
            contentType: "image/png",
            token: publicToken,
          },
        );
        urls.push(blob.url);
        alts.push(region.alt ?? "");
        totalUploaded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[extract-images] upload failed for q${q.original_question_number}#${i}: ${msg}`,
        );
        errors.push(`q${q.original_question_number}#${i}: ${msg}`);
      }
    }
    if (urls.length > 0) {
      byQuestion.set(q.original_question_number, { urls, alts });
    }
  }

  return { byQuestion, totalUploaded, errors };
}
