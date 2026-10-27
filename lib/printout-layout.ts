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
