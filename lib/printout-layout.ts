// lib/printout-layout.ts
//
// Geometry reader for text-layer PDFs: every text line, embedded image, thin
// rule (underline) and box (choice / answer frame) on every page, in PDF
// points with a TOP-LEFT origin. Used by lib/printout-parser.ts to rebuild
// questions structurally instead of asking a model to read the whole PDF.

import { loadPdfDocument } from "@/lib/pdf-text-choices";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LayoutLine extends Rect {
  kind: "text";
  page: number;
  /** Line text; underlined runs wrapped in <u>…</u>. */
  text: string;
  /** Same text without markup. */
  plain: string;
  /** A check-mark glyph sits on this line. */
  checked: boolean;
  /** A drawn bullet dot sits just left of this line (list item start). */
  bullet: boolean;
  fontSize: number;
}

export interface LayoutImage extends Rect {
  kind: "image";
  page: number;
}

export type LayoutElement = LayoutLine | LayoutImage;

export interface PrintoutLayout {
  pages: { width: number; height: number }[];
  /** Text lines + images, per page top→bottom, pages in order. */
  elements: LayoutElement[];
  /** Framed boxes (choice boxes, SPR answer box) per page. */
  boxes: (Rect & { page: number })[];
}

// FontAwesome check icons (check-circle U+F058, check-circle-o, check,
// check-square[-o]) + common Unicode check marks.
export const CHECK_GLYPH = /[\uf058\uf05d\uf00c\uf046\uf14a\u2713\u2714\u2705\u2611]/g;

// Browser-print page chrome: the "date, time   Survey: print page | …" header
// and the URL + "n/m" footer.
const PAGE_CHROME = [
  /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}\s*(AM|PM)?\b/i,
  /^https?:\/\/\S+(\s+\d+\s*\/\s*\d+)?$/i,
  /survey:\s*print page/i,
];

export interface ExclusionZone extends Rect {
  page: number;
  /**
   * line = header/footer; check = ✓ line; label = a choice's A–D letter box;
   * bar = question-number bar; answer = frame holding a ✓ (correct choice /
   * answer box); choice = any other choice frame (has an A–D letter box).
   */
  kind: "line" | "check" | "label" | "bar" | "answer" | "choice";
}

/**
 * Areas on each page that never belong to a question's figure: page
 * header/footer lines, question-number bars, check-mark (answer) lines, and
 * the choice / answer frames that carry a check mark. Used to clamp an
 * approximate (model-drawn) figure box to its own question so the crop can't
 * leak the neighbouring question's choices, the ✓ that marks the answer, the
 * Student-Produced-Response answer box or the page header.
 */
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });

export function figureExclusionZones(layout: PrintoutLayout): ExclusionZone[] {
  const zones: ExclusionZone[] = [];
  const lines = layout.elements.filter((e): e is LayoutLine => e.kind === "text");
  const chrome = (l: LayoutLine) => PAGE_CHROME.some((re) => re.test(l.plain));
  for (const l of lines) {
    // (Glyph boxes are tight to the text; the drawn badge is a bit bigger.)
    if (l.checked) zones.push({ ...grow(l, 3), page: l.page, kind: "check" });
    else if (chrome(l)) zones.push({ ...l, kind: "line" });
  }
  // A question number = a lone "N" whose next element (page chrome skipped)
  // is the question's stem: a "N." line or the stem image. Same rule the
  // printout segmenter uses — a number in a table row or a bar-chart bar is
  // followed by more data, not by a stem.
  const numberLines = new Set<LayoutLine>();
  const els = layout.elements.filter((e) => !(e.kind === "text" && !e.checked && chrome(e)));
  els.forEach((e, i) => {
    if (e.kind !== "text" || e.checked || !/^\d{1,3}$/.test(e.plain)) return;
    const next = els[i + 1];
    if (next && (next.kind === "image" || /^\d{1,3}\.(\s|$)/.test(next.plain))) numberLines.add(e);
  });
  for (const b of layout.boxes) {
    const pageW = layout.pages[b.page - 1]?.width ?? 612;
    if (b.x1 - b.x0 >= pageW * 0.8) continue; // page border
    const inBox = (l: LayoutLine) => {
      const cx = (l.x0 + l.x1) / 2;
      const cy = (l.y0 + l.y1) / 2;
      return l.page === b.page && cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1;
    };
    const held = lines.filter(inBox);
    // Thin wide bar holding exactly one line, a question number.
    if (b.y1 - b.y0 <= 28 && b.x1 - b.x0 >= pageW * 0.4 && held.length === 1 && numberLines.has(held[0])) {
      zones.push({ ...b, kind: "bar" });
      continue;
    }
    // The choice's letter box sits in the frame's top-left corner — a lone
    // A–D there is the label, not a point label of the figure.
    const labels = held.filter((l) => /^[A-D]$/.test(l.plain) && l.x0 - b.x0 < 30 && l.y0 - b.y0 < 25);
    for (const l of labels) zones.push({ ...grow(l, 5), page: l.page, kind: "label" });
    // A frame holding a check mark = the correct choice / the answer box;
    // every other lettered frame is a plain choice frame. Both are treated
    // alike so the correct choice's crop never looks different.
    if (held.some((l) => l.checked)) zones.push({ ...b, kind: "answer" });
    else if (labels.length > 0) zones.push({ ...b, kind: "choice" });
  }
  return zones;
}

/**
 * Shrink `r` (PDF points, top-left origin) so it no longer overlaps any
 * exclusion zone. Each overlapping zone is cut away from whichever side
 * keeps more of the box (a header or bar → top/bottom, a ✓ at the frame's
 * right edge → right). A choice/answer frame that CONTAINS the box centre is
 * the graph choice's own frame: the box is clamped to its interior (border
 * inset) instead, so nothing outside the frame leaks in. Returns the original box
 * when clamping would leave too little of it — a wrong clamp must never eat
 * the figure.
 */
export function clampToZones(r: Rect, zones: (Rect & { kind?: ExclusionZone["kind"] })[]): Rect {
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const out = { ...r };
  const INSET = 2;
  for (const z of zones) {
    if ((z.kind !== "answer" && z.kind !== "choice") || !(cx > z.x0 && cx < z.x1 && cy > z.y0 && cy < z.y1)) continue;
    out.x0 = Math.max(out.x0, z.x0 + INSET);
    out.y0 = Math.max(out.y0, z.y0 + INSET);
    out.x1 = Math.min(out.x1, z.x1 - INSET);
    out.y1 = Math.min(out.y1, z.y1 - INSET);
  }
  // Biggest zones first: once a frame or bar is cut away, the small ✓ /
  // header lines inside or beyond it no longer overlap and cost nothing.
  const bySize = [...zones].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  for (const z of bySize) {
    if (z.x1 <= out.x0 || z.x0 >= out.x1 || z.y1 <= out.y0 || z.y0 >= out.y1) continue;
    if (cx > z.x0 && cx < z.x1 && cy > z.y0 && cy < z.y1) continue;
    const w = out.x1 - out.x0;
    const h = out.y1 - out.y0;
    // Remaining area for each way of cutting the zone off.
    const vert = (z.y0 + z.y1) / 2 < cy ? { y0: Math.max(out.y0, z.y1 + 1) } : { y1: Math.min(out.y1, z.y0 - 1) };
    const horz = (z.x0 + z.x1) / 2 < cx ? { x0: Math.max(out.x0, z.x1 + 1) } : { x1: Math.min(out.x1, z.x0 - 1) };
    const vArea = w * (("y0" in vert ? out.y1 - vert.y0! : vert.y1! - out.y0));
    const hArea = h * (("x0" in horz ? out.x1 - horz.x0! : horz.x1! - out.x0));
    Object.assign(out, vArea >= hArea ? vert : horz);
  }
  if (out.y1 - out.y0 < Math.max(20, (r.y1 - r.y0) * 0.25) || out.x1 - out.x0 < Math.max(20, (r.x1 - r.x0) * 0.25)) return r;
  return out;
}

/** The box overlaps a ✓ (answer check-mark) line. */
export function overlapsCheckMark(r: Rect, zones: (Rect & { kind?: ExclusionZone["kind"] })[]): boolean {
  return zones.some((z) => z.kind === "check" && z.x0 < r.x1 && z.x1 > r.x0 && z.y0 < r.y1 && z.y1 > r.y0);
}

type M = [number, number, number, number, number, number];
const mul = (m: M, c: M): M => [
  m[0] * c[0] + m[1] * c[2],
  m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2],
  m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4],
  m[4] * c[1] + m[5] * c[3] + c[5],
];
const apply = (m: M, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function bboxOf(m: M, x0: number, y0: number, x1: number, y1: number) {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

interface Item {
  str: string;
  x: number;
  w: number;
  base: number; // baseline y, PDF space (bottom-left origin)
  size: number;
}

export async function readPrintoutLayout(pdfBase64: string): Promise<PrintoutLayout> {
  const { doc, pdfjs } = await loadPdfDocument(pdfBase64);
  const OPS = pdfjs.OPS as Record<string, number>;
  const pages: PrintoutLayout["pages"] = [];
  const elements: LayoutElement[] = [];
  const boxes: PrintoutLayout["boxes"] = [];

  // Cheap early exit for scanned / image-only PDFs: no text on the first two
  // pages means there is no skeleton to read — skip the operator-list pass.
  let probeChars = 0;
  for (let p = 1; p <= Math.min(2, doc.numPages); p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    for (const it of tc.items as { str?: string }[]) probeChars += (it.str ?? "").trim().length;
  }
  if (probeChars < 40) {
    await doc.destroy();
    return { pages, elements, boxes };
  }

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width;
    const H = vp.height;
    pages.push({ width: W, height: H });

    // ── Graphics: images, thin rules, boxes (CTM-tracked) ─────────────
    const ol = await page.getOperatorList();
    let ctm: M = [1, 0, 0, 1, 0, 0];
    const stack: M[] = [];
    const rules: { minX: number; maxX: number; y: number }[] = [];
    const dots: { x: number; y: number }[] = [];
    const pageImages: LayoutImage[] = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i];
      const args = ol.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(args as M, ctm);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        const fm = args?.[0] as ArrayLike<number> | null | undefined;
        if (fm && fm.length === 6) ctm = mul(Array.from(fm) as M, ctm);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        const b = bboxOf(ctm, 0, 0, 1, 1);
        const w = b.maxX - b.minX;
        const h = b.maxY - b.minY;
        // Skip decorations (icons, the check badge) — real content images are big.
        if (w < 12 || h < 8) continue;
        pageImages.push({ kind: "image", page: p, x0: b.minX, x1: b.maxX, y0: H - b.maxY, y1: H - b.minY });
      } else if (fn === OPS.constructPath) {
        const mm = args?.[2];
        if (!mm) continue;
        const v = Array.from(mm as ArrayLike<number>);
        if (v.length < 4 || !v.every(Number.isFinite)) continue;
        const b = bboxOf(ctm, v[0], v[1], v[2], v[3]);
        const w = b.maxX - b.minX;
        const h = b.maxY - b.minY;
        if (h <= 2.5 && w >= 3) rules.push({ minX: b.minX, maxX: b.maxX, y: b.minY });
        else if (w >= 1.5 && w <= 9 && h >= 1.5 && h <= 9) dots.push({ x: b.maxX, y: H - (b.minY + b.maxY) / 2 });
        else if (w >= 60 && h >= 14 && w < W * 0.98) {
          boxes.push({ page: p, x0: b.minX, x1: b.maxX, y0: H - b.maxY, y1: H - b.minY });
        }
      }
    }

    // ── Text: group items into lines by baseline ──────────────────────
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      if (typeof it.str !== "string" || !it.transform || it.str === "") continue;
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      items.push({ str: it.str, x: it.transform[4], w: it.width ?? 0, base: it.transform[5], size });
    }
    const rows: Item[][] = [];
    for (const it of items.sort((a, b) => b.base - a.base || a.x - b.x)) {
      const row = rows.find((r) => Math.abs(r[0].base - it.base) < Math.max(2, r[0].size * 0.3));
      if (row) row.push(it);
      else rows.push([it]);
    }
    const lines: LayoutLine[] = [];
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      const size = Math.max(...row.map((r) => r.size));
      let text = "";
      let plain = "";
      let inU = false;
      let prevEnd: number | null = null;
      for (const it of row) {
        if (prevEnd !== null && it.x - prevEnd > size * 0.12 && !/\s$/.test(plain) && !/^\s/.test(it.str)) {
          // Keep a space that sits between two underlined runs inside the tag.
          text += " ";
          plain += " ";
        }
        const n = it.str.length;
        for (let k = 0; k < n; k++) {
          const ch = it.str[k];
          const cx = it.x + (it.w * (k + 0.5)) / Math.max(1, n);
          const under =
            ch.trim() !== "" &&
            rules.some((r) => cx >= r.minX && cx <= r.maxX && r.y <= it.base + 1 && r.y >= it.base - size * 0.35);
          if (under && !inU) {
            text += "<u>";
            inU = true;
          } else if (!under && inU && ch.trim() !== "") {
            text = text.replace(/(\s*)$/, "</u>$1");
            inU = false;
          }
          text += ch;
          plain += ch;
        }
        prevEnd = it.x + it.w;
      }
      if (inU) text = text.replace(/(\s*)$/, "</u>$1");
      const checked = CHECK_GLYPH.test(plain);
      CHECK_GLYPH.lastIndex = 0;
      // Drop icon-font glyphs (private-use area: nav arrows, badges) after the
      // check mark has been detected.
      const clean = (s: string) => s.replace(CHECK_GLYPH, "").replace(/[\ue000-\uf8ff]/g, "").replace(/<u>\s*<\/u>/g, "").replace(/\s+/g, " ").trim();
      const minX = Math.min(...row.map((r) => r.x));
      const maxX = Math.max(...row.map((r) => r.x + r.w));
      const base = row[0].base;
      const top = H - (base + size * 0.8);
      const bottom = H - (base - size * 0.25);
      lines.push({
        kind: "text",
        page: p,
        text: clean(text),
        plain: clean(plain),
        checked,
        bullet: dots.some((d) => d.x < minX && minX - d.x < 30 && d.y > top && d.y < bottom),
        fontSize: size,
        x0: minX,
        x1: maxX,
        y0: H - (base + size * 0.8),
        y1: H - (base - size * 0.25),
      });
    }

    const pageEls: LayoutElement[] = [...lines.filter((l) => l.plain || l.checked), ...pageImages];
    pageEls.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    elements.push(...pageEls);
    page.cleanup();
  }
  await doc.destroy();
  return { pages, elements, boxes };
}
