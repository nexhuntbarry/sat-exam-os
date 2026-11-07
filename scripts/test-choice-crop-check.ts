// scripts/test-choice-crop-check.ts
//
// Graph-choice crop guard (lib/choice-crop-check.ts): blank crops, ink cut at
// the border, light-grey (scanned) text cut at the border, and a crop box
// that runs into another question. No network / DB.
//
//   npx tsx scripts/test-choice-crop-check.ts
import sharp from "sharp";
import { checkChoiceCropPixels, checkGreyPixels, choiceCropProblems, cropHasOtherQuestion, figureMayContinue } from "../lib/choice-crop-check";
import type { ExclusionZone } from "../lib/printout-layout";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

/** White W×H canvas; `draw` paints grey values. */
function canvas(w: number, h: number, draw: (set: (x: number, y: number, v: number) => void) => void): Uint8Array {
  const g = new Uint8Array(w * h).fill(255);
  draw((x, y, v) => {
    if (x >= 0 && y >= 0 && x < w && y < h) g[y * w + x] = v;
  });
  return g;
}
const hLine = (set: (x: number, y: number, v: number) => void, x0: number, x1: number, y: number, v = 0, t = 3) => {
  for (let x = x0; x <= x1; x++) for (let d = 0; d < t; d++) set(x, y + d, v);
};
const vLine = (set: (x: number, y: number, v: number) => void, x: number, y0: number, y1: number, v = 0, t = 3) => {
  for (let y = y0; y <= y1; y++) for (let d = 0; d < t; d++) set(x + d, y, v);
};

async function main() {
  const W = 300;
  const H = 300;

  // A complete graph: axes + a diagonal line, margins on every side; light grid lines touch the edges.
  const good = canvas(W, H, (set) => {
    for (let k = 0; k < W; k += 30) {
      vLine(set, k, 0, H - 1, 225, 2); // light grid, reaches the border
      hLine(set, 0, W - 1, k, 225, 2);
    }
    hLine(set, 20, 280, 150);
    vLine(set, 150, 20, 280);
    for (let i = 30; i < 270; i++) set(i, 300 - i, 0);
    for (let x = 160; x < 280; x++) for (let y = 160; y < 280; y++) set(x, y, 200); // grey shading to the frame
  });
  const g = checkGreyPixels(good, W, H);
  check("complete graph: not blank, no cut edge (grid + shading ignored)", !g.blank && g.cutEdges.length === 0, g);

  const blank = canvas(W, H, (set) => set(5, 5, 0));
  check("blank crop is blank", checkGreyPixels(blank, W, H).blank);

  // Axes and a line run off the left edge (old Q6 A / C crops).
  const cutLeft = canvas(W, H, (set) => {
    hLine(set, 0, 280, 150);
    vLine(set, 150, 20, 280);
    for (let i = 0; i < 270; i++) set(i, 280 - i, 0);
    for (let i = 0; i < 270; i++) set(i, 281 - i, 0);
  });
  const cl = checkGreyPixels(cutLeft, W, H);
  check("ink touching the left border → cut left", cl.cutEdges.includes("left") && !cl.cutEdges.includes("right"), cl);

  // Light-grey scanned text cut at the right edge (old T21 Q21 C / D crops).
  const greyText = canvas(W, 60, (set) => {
    for (let x = 10; x < W; x += 12) vLine(set, x, 15, 45, 150, 4);
  });
  const gt = checkGreyPixels(greyText, W, 60);
  check("grey text running off the right border → cut right", gt.cutEdges.includes("right") && !gt.blank, gt);

  // Same through the PNG path (sharp decode).
  const png = await sharp(Buffer.from(cutLeft), { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  const viaPng = await checkChoiceCropPixels(png);
  check("PNG path agrees with raw path", JSON.stringify(viaPng) === JSON.stringify(cl), viaPng);

  // Text layer: a box that runs into the next question's number bar / stem line.
  const zones: ExclusionZone[] = [{ page: 5, kind: "bar", x0: 100, y0: 600, x1: 500, y1: 620 }];
  const lines = [{ page: 5, plain: "7. In the equation given below, a is a constant.", x0: 100, y0: 630, x1: 500, y1: 642 }];
  check("box inside its own frame → no other question", !cropHasOtherQuestion({ x0: 100, y0: 300, x1: 400, y1: 590 }, 5, zones, lines));
  check("box over the next question's bar → other question", cropHasOtherQuestion({ x0: 100, y0: 300, x1: 400, y1: 610 }, 5, zones, lines));
  check("box over a stem line → other question", cropHasOtherQuestion({ x0: 100, y0: 300, x1: 400, y1: 640 }, 5, [], lines));
  check("same box on another page → fine", !cropHasOtherQuestion({ x0: 100, y0: 300, x1: 400, y1: 640 }, 4, zones, lines));
  check("tick label '4' is not a stem line", !cropHasOtherQuestion({ x0: 0, y0: 0, x1: 600, y1: 800 }, 5, [], [{ page: 5, plain: "4", x0: 10, y0: 10, x1: 20, y1: 20 }]));

  const p = choiceCropProblems("B", { blank: true, cutEdges: [] }, true);
  check("problems: blank + other question", p.length === 2 && /blank/.test(p[0]) && /another question/.test(p[1]), p);
  check("problems: none for a good crop", choiceCropProblems("A", g, false).length === 0);

  // Page-break rule: Q12's bar is the last on p9, p10 starts with an image (the figure's continuation).
  const bar = (page: number, y: number): ExclusionZone => ({ page, kind: "bar", x0: 100, y0: y, x1: 500, y1: y + 20 });
  const num = (page: number, n: number, y: number) => ({ kind: "text" as const, page, plain: String(n), text: String(n), x0: 105, y0: y + 3, x1: 120, y1: y + 17, checked: false, bullet: false, fontSize: 10 });
  const pages = Array.from({ length: 10 }, () => ({ width: 612, height: 792 }));
  const ownImg = (y1: number) => ({ kind: "image" as const, page: 9, x0: 100, y0: 540, x1: 400, y1 });
  const layout = {
    pages,
    elements: [num(9, 11, 100), num(9, 12, 500), ownImg(780), { kind: "image" as const, page: 10, x0: 100, y0: 60, x1: 400, y1: 300 }, num(10, 13, 400)],
  };
  const zones2 = [bar(9, 100), bar(9, 500), bar(10, 400)];
  check("page break: last question on its page + image atop next page → may continue", figureMayContinue(layout, zones2, 9, 12));
  check("page break: stored page_number off by one still finds the bar", figureMayContinue(layout, zones2, 8, 12));
  check("page break: a question followed by another on the same page → no", !figureMayContinue(layout, zones2, 9, 11));
  check("page break: unknown question number → no", !figureMayContinue(layout, zones2, 9, 99));
  const ends = { ...layout, elements: layout.elements.map((e) => (e.kind === "image" && e.page === 9 ? ownImg(650) : e)) };
  check("page break: own figure ends well above the page bottom → no", !figureMayContinue(ends, zones2, 9, 12));
  const choiceZone: ExclusionZone = { page: 10, kind: "choice", x0: 90, y0: 50, x1: 450, y1: 320 };
  check("page break: next page's top image is an answer choice → no", !figureMayContinue(layout, [...zones2, choiceZone], 9, 12));

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
