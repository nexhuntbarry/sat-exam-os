// lib/choice-crop-check.ts
//
// Checks a graph answer-choice crop (choices[i].image_url) can be shown as is:
//   - blank: (almost) no ink, e.g. a box that missed the graph;
//   - edge cut: dark ink (axis, boundary line, label) touches the crop border,
//     so part of the graph is probably cut off (light grid lines and grey
//     shading don't count);
//   - other question: the crop box (PDF text layer) runs into a question-number
//     bar or another question's "N. …" stem line.
// Used by the cropper (lib/ai/extract-images.ts → parse route notes) and the
// graph-choice audit (lib/figure-compare.ts auditGraphChoices).

import sharp from "sharp";
import type { ExclusionZone, LayoutLine, PrintoutLayout, Rect } from "@/lib/printout-layout";

export type CropEdge = "top" | "bottom" | "left" | "right";

export interface CropPixelCheck {
  blank: boolean;
  cutEdges: CropEdge[];
}

/** Luminance below this is ink (black lines / text); grid lines and grey shading are lighter. */
const INK = 100;
/** Anything darker than this is a mark (light-grey scanned text counts; paper doesn't). */
const MARK = 200;
/** Border strip checked on each side, px. */
const STRIP = 2;

/** Pure: pixel checks on a greyscale image (one byte per pixel, row-major). */
export function checkGreyPixels(grey: Uint8Array | Buffer, width: number, height: number): CropPixelCheck {
  let marks = 0;
  for (let i = 0; i < grey.length; i++) if (grey[i] < MARK) marks++;
  // A real graph has axes, lines and labels: well over 0.2% of the pixels.
  const blank = width * height === 0 || marks / (width * height) < 0.002;
  const cutEdges: CropEdge[] = [];
  if (!blank) {
    // Light-grey scans (e.g. greyed-out choice text) never reach black: ink is
    // anything near the image's own darkest marks.
    let darkest = 255;
    for (let i = 0; i < grey.length; i++) if (grey[i] < darkest) darkest = grey[i];
    const ink = Math.max(INK, Math.min(MARK - 10, darkest + 50));
    const count = (xs: [number, number], ys: [number, number]) => {
      let n = 0;
      for (let y = ys[0]; y < ys[1]; y++) for (let x = xs[0]; x < xs[1]; x++) if (grey[y * width + x] < ink) n++;
      return n;
    };
    // Ink must cross the strip in a few pixels per line, not a stray speck.
    const min = (len: number) => Math.max(6, Math.round(len * STRIP * 0.004));
    const s = Math.min(STRIP, Math.floor(width / 2), Math.floor(height / 2));
    if (count([0, width], [0, s]) >= min(width)) cutEdges.push("top");
    if (count([0, width], [height - s, height]) >= min(width)) cutEdges.push("bottom");
    if (count([0, s], [0, height]) >= min(height)) cutEdges.push("left");
    if (count([width - s, width], [0, height]) >= min(height)) cutEdges.push("right");
  }
  return { blank, cutEdges };
}

/** Pixel checks on a PNG/JPEG crop. */
export async function checkChoiceCropPixels(img: Buffer): Promise<CropPixelCheck> {
  const { data, info } = await sharp(img).flatten({ background: "#ffffff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return checkGreyPixels(data, info.width, info.height);
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const STEM_LINE = /^\d{1,3}\.\s+\S/;

/**
 * Pure: the crop box (PDF points, top-left origin) on `page` runs into another
 * question — a question-number bar, or a question's "N. …" stem line.
 */
export function cropHasOtherQuestion(
  box: Rect,
  page: number,
  zones: ExclusionZone[],
  lines: Pick<LayoutLine, "page" | "plain" | "x0" | "y0" | "x1" | "y1">[],
): boolean {
  if (zones.some((z) => z.page === page && z.kind === "bar" && overlaps(z, box))) return true;
  return lines.some((l) => l.page === page && STEM_LINE.test(l.plain) && overlaps(l, box));
}

/** Plain-language problems for one choice crop ([] = fine). */
export function choiceCropProblems(label: string, px: CropPixelCheck | null, otherQuestion: boolean): string[] {
  const out: string[] = [];
  if (px?.blank) out.push(`graph choice ${label} image is blank`);
  else if (px && px.cutEdges.length > 0) out.push(`graph choice ${label} image looks cut off (${px.cutEdges.join("/")} edge)`);
  if (otherQuestion) out.push(`graph choice ${label} image includes another question`);
  return out;
}

/**
 * Pure (text layer): question `questionNumber`'s figure may run across a page
 * break — the question is the last one on its page (found by its number bar;
 * `page` = the stored page, a hint), its own image reaches the bottom of that
 * page, and the next page starts with an image before its first
 * question-number bar. `zones` =
 * figureExclusionZones(layout).
 */
export function figureMayContinue(
  layout: Pick<PrintoutLayout, "elements" | "pages">,
  zones: ExclusionZone[],
  page: number,
  questionNumber: number,
): boolean {
  const bars = zones.filter((z) => z.kind === "bar");
  const numberIn = (b: ExclusionZone) =>
    layout.elements.some(
      (e) => e.kind === "text" && e.page === b.page && e.plain === String(questionNumber) && (e.x0 + e.x1) / 2 > b.x0 && (e.x0 + e.x1) / 2 < b.x1 && (e.y0 + e.y1) / 2 > b.y0 && (e.y0 + e.y1) / 2 < b.y1,
    );
  // The stored page_number is sometimes off (it can point at the previous
  // question's page), so find the question's own number bar on any page;
  // `page` only breaks a tie.
  const mine = bars.filter(numberIn);
  const own = mine.find((b) => b.page === page) ?? mine[0];
  if (!own) return false;
  const p = own.page;
  if (bars.some((b) => b.page === p && b.y0 > own.y1)) return false; // another question follows on the same page
  // The question's own figure must run to the bottom of its page (a break cut it there).
  const pageH = layout.pages[p - 1]?.height ?? 792;
  if (!layout.elements.some((e) => e.kind === "image" && e.page === p && e.y0 > own.y0 && e.y1 >= pageH * 0.88)) return false;
  const nextBarY = Math.min(Infinity, ...bars.filter((b) => b.page === p + 1).map((b) => b.y0));
  // An image inside an answer-choice frame is a choice, not the figure's continuation.
  const inChoice = (e: { page: number; x0: number; y0: number; x1: number; y1: number }) =>
    zones.some((z) => (z.kind === "choice" || z.kind === "answer") && z.page === e.page && (e.x0 + e.x1) / 2 > z.x0 && (e.x0 + e.x1) / 2 < z.x1 && (e.y0 + e.y1) / 2 > z.y0 && (e.y0 + e.y1) / 2 < z.y1);
  return layout.elements.some((e) => e.kind === "image" && e.page === p + 1 && e.y0 < nextBarY && !inChoice(e));
}
