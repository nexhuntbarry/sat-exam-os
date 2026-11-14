// Premier watermark on printouts (Premier ticket 961ed023): the laurel "P"
// badge, centred on every printed page at half the page width, behind the
// text and figures, in one flat gray at low opacity so it prints evenly in
// black and white. It is a real element on each page (inline SVG, vector —
// never an <img>, so the figure checks and image waits don't see it), not a
// CSS background, so it prints with default browser settings and lands in
// the server's PDF. Placed after Paged.js has laid the pages out and
// absolutely positioned, so it never changes the page count.
import { BADGE_PATH, BADGE_VIEWBOX } from "@/lib/brand";
import type { PreviewOption } from "@/components/print/PrintPreview";

/** Fill and opacity of the mark: ≈4–5 % gray on paper. */
export const WATERMARK_FILL = "#6b6b6b";
export const WATERMARK_OPACITY = 0.07;
/** Width of the mark as a share of the page width. */
export const WATERMARK_WIDTH = 0.5;

/**
 * Whether a printout carries the watermark. Only admins may turn it off
 * (`wm=0`); everyone else always gets it, whatever the URL says.
 */
export function watermarkOn(role: string | null | undefined, wm: string | null | undefined): boolean {
  return role !== "admin" || wm !== "0";
}

/** id of the one <symbol> holding the mark; every page references it. */
export const WATERMARK_SYMBOL_ID = "pw";

/**
 * The mark's definition, once per document: a zero-size SVG holding a
 * <symbol> (one path, the badge's viewBox). Zero-size rather than
 * display:none so nothing can hide its contents from the <use> copies.
 */
export function watermarkSymbol(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">` +
    `<symbol id="${WATERMARK_SYMBOL_ID}" viewBox="0 0 ${BADGE_VIEWBOX.width} ${BADGE_VIEWBOX.height}">` +
    `<path fill="${WATERMARK_FILL}" fill-opacity="${WATERMARK_OPACITY}" d="${BADGE_PATH}"/></symbol></svg>`
  );
}

/** One page's mark: a reference to the symbol, sized by the badge's viewBox. */
export function watermarkSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BADGE_VIEWBOX.width} ${BADGE_VIEWBOX.height}" aria-hidden="true" focusable="false">` +
    `<use href="#${WATERMARK_SYMBOL_ID}" width="${BADGE_VIEWBOX.width}" height="${BADGE_VIEWBOX.height}"/></svg>`
  );
}

/** CSS for the per-page mark (inside the Paged.js sheet) and the plain-document fallback. */
export const WATERMARK_CSS = `
/* The sheet is the mark's stacking context: z-index -1 paints it above the
   page's own background but below everything laid out on the page. */
.print-preview-pages .pagedjs_sheet { isolation: isolate; }
.print-preview-pages .print-watermark {
  position: absolute; inset: 0; z-index: -1;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none; user-select: none;
}
.print-preview-pages .print-watermark svg { width: ${WATERMARK_WIDTH * 100}%; height: auto; display: block; }
/* Wrappers painted white on screen would hide it; paper is white anyway. */
.print-preview-pages .pagedjs_page_content .bg-white { background-color: transparent !important; }
/* Printing the plain document (the layout failed, or Ctrl/Cmd+P before it
   finished): a fixed element repeats on every printed page. z-index -1
   puts it behind the in-flow content (root stacking context), so the
   backgrounds above it are cleared — paper is white anyway. */
.print-watermark-fallback { display: none; }
@media print {
  html:not([data-print-ready]) .print-watermark-fallback {
    display: flex; position: fixed; inset: 0; z-index: -1;
    align-items: center; justify-content: center; pointer-events: none;
  }
  html:not([data-print-ready]) .print-watermark-fallback svg { width: ${WATERMARK_WIDTH * 100}vw; height: auto; }
  html:not([data-print-ready]) body,
  html:not([data-print-ready]) .bg-cream,
  html:not([data-print-ready]) .print-source .bg-white { background-color: transparent !important; }
}
`;

/** The admin's "Watermark" switch in the print preview (URL param `wm`). */
export function watermarkOption(on: boolean): PreviewOption {
  return {
    param: "wm",
    label: "Watermark",
    value: on ? "1" : "0",
    choices: [
      { value: "1", label: "On" },
      { value: "0", label: "Off" },
    ],
  };
}
