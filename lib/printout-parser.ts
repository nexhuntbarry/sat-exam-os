// lib/printout-parser.ts
//
// Deterministic parser for the old-website "Survey: print page | Premier Plus
// Education" printouts (and any text-layer PDF with the same skeleton):
//
//   [number box "N"]  "N. stem…"  [A] choice  [B] choice  [C] choice ✓  [D] choice
//
// The whole-PDF AI parse bound choices to the wrong stem on these files: a
// stem at the bottom of page N has its choices at the top of page N+1, and
// the model kept giving those choices to the stem printed BELOW them (even
// with explicit prompt instructions — verified on Test #19). Here the
// structure comes from the PDF itself, so a cross-question mix-up is
// structurally impossible:
//
//   1. lib/printout-layout.ts reads every text line, image, underline and box
//      with its position; headers/footers are dropped and pages are read as
//      one continuous stream, so page breaks don't matter.
//   2. Questions are split on the number box + "N." stem line; choices are the
//      A–D labels in order; content between labels belongs to that label.
//   3. Text is taken verbatim from the text layer (underlines → <u>…</u>).
//   4. Content that is an IMAGE (Math stems/choices, R&W tables and graphs) is
//      cropped at its exact box and only that crop is transcribed by the
//      model, labelled with the slot it fills — it can't land elsewhere.
//      Tables become Markdown; graphs/diagrams stay images (image_regions with
//      exact coordinates) for BOTH Math and Reading & Writing — a figure is
//      never replaced with a "[Bar chart: …]" text description.
//   5. The checked answer is read from the check-mark glyph on the box (MC)
//      or the checked answer box (Student-Produced Response).
//
// Anything incomplete is returned with review_reasons so the parse route
// demotes it to Needs Review with a plain-language note.

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import sharp from "sharp";
import { readPrintoutLayout, type LayoutElement, type LayoutLine, type PrintoutLayout, type Rect } from "@/lib/printout-layout";
import { renderPdfPages } from "@/lib/ai/extract-images";
import { MATH_FORMAT_RULES, logUsage, type ModuleMetadata, type ParsedQuestion, type ParsedImageRegion } from "@/lib/ai/parse-pdf";
import { normalizeChoiceText } from "@/lib/pdf-text-choices";

type Label = "A" | "B" | "C" | "D";
const LABELS: Label[] = ["A", "B", "C", "D"];
const MODEL = "claude-sonnet-4-6";

// Browser print header/footer lines that interrupt a question at a page break.
const HEADER_FOOTER = [
  /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}\s*(AM|PM)?\b/i,
  /^https?:\/\/\S+(\s+\d+\s*\/\s*\d+)?$/i,
];

// ── Segmentation ─────────────────────────────────────────────────────

type Part = { kind: "text"; lines: LayoutLine[] } | { kind: "image"; page: number; rect: Rect };

export interface PrintoutQuestion {
  number: number;
  stemPage: number;
  stem: Part[];
  choices: { label: Label; parts: Part[] }[];
  checked: Label | null;
  /** Student-Produced Response answer box content (no A–D labels). */
  sprAnswer: LayoutLine[];
  sprChecked: boolean;
}

function pushPart(parts: Part[], el: LayoutElement) {
  if (el.kind === "image") {
    parts.push({ kind: "image", page: el.page, rect: el });
    return;
  }
  const last = parts[parts.length - 1];
  if (last?.kind === "text") last.lines.push(el);
  else parts.push({ kind: "text", lines: [el] });
}

function inside(el: LayoutElement, layout: PrintoutLayout): boolean {
  const cx = (el.x0 + el.x1) / 2;
  const cy = (el.y0 + el.y1) / 2;
  const pageW = layout.pages[el.page - 1]?.width ?? 612;
  // Answer frames only — not the page border or the thin number bar.
  return layout.boxes.some(
    (b) => b.page === el.page && b.x1 - b.x0 < pageW * 0.8 && b.y1 - b.y0 > 24 && cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1,
  );
}

export function segmentPrintout(layout: PrintoutLayout): PrintoutQuestion[] {
  const els = layout.elements.filter(
    (e) => !(e.kind === "text" && !e.checked && HEADER_FOOTER.some((re) => re.test(e.plain))),
  );
  const out: PrintoutQuestion[] = [];
  let cur: PrintoutQuestion | null = null;
  let awaitingStem = false;
  let lastNum = 0;

  const nextText = (i: number) => {
    for (let j = i + 1; j < els.length; j++) if (els[j].kind === "text") return els[j] as LayoutLine;
    return null;
  };

  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (el.kind === "text") {
      const t = el.plain;
      // Number box: "N" alone, followed by a "M." stem line. Trust the box
      // number (printouts occasionally carry a stale stem number).
      if (/^\d{1,3}$/.test(t) && !el.checked) {
        const n = Number(t);
        const nt = nextText(i);
        if (n > lastNum && n <= lastNum + 3 && nt && /^\d{1,3}\.(\s|$)/.test(nt.plain)) {
          cur = { number: n, stemPage: el.page, stem: [], choices: [], checked: null, sprAnswer: [], sprChecked: false };
          out.push(cur);
          lastNum = n;
          awaitingStem = true;
          continue;
        }
      }
      if (!cur) continue;
      if (awaitingStem) {
        const m = el.text.match(/^\d{1,3}\.\s*(.*)$/);
        if (m) {
          awaitingStem = false;
          cur.stemPage = el.page;
          if (m[1].trim()) pushPart(cur.stem, { ...el, text: m[1].trim(), plain: el.plain.replace(/^\d{1,3}\.\s*/, "") });
          continue;
        }
      }
      // Choice label alone on its line.
      const expected = LABELS[cur.choices.length];
      if (expected && t === expected) {
        cur.choices.push({ label: expected, parts: [] });
        if (el.checked) cur.checked = expected;
        continue;
      }
      if (el.checked && !t) {
        if (cur.choices.length > 0) cur.checked = cur.choices[cur.choices.length - 1].label;
        else cur.sprChecked = true;
        continue;
      }
    }
    if (!cur) continue;
    if (cur.choices.length > 0) {
      const c = cur.choices[cur.choices.length - 1];
      pushPart(c.parts, el);
      if (el.kind === "text" && el.checked) cur.checked = c.label;
    } else if (el.kind === "text" && inside(el, layout)) {
      // Framed text before any A–D label = the SPR answer box.
      cur.sprAnswer.push(el);
      if (el.checked) cur.sprChecked = true;
    } else {
      pushPart(cur.stem, el);
    }
  }
  return out;
}

/** True when the PDF has the printout skeleton (number boxes + "N." stems). */
export function looksLikePrintout(questions: PrintoutQuestion[]): boolean {
  if (questions.length < 5) return false;
  // Contiguous numbering 1..N.
  return questions.every((q, i) => q.number === i + 1);
}

// ── Text assembly ────────────────────────────────────────────────────

function cleanText(s: string): string {
  return s
    .replace(/ʼ/g, "’")
    .replace(/ /g, " ")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/_{3,}/g, "______")
    .replace(/<\/u>(\s*)<u>/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Join lines into paragraphs. A vertical gap, or a short sentence-ending line
 * before a page break, starts a new paragraph. Bullet items (the "student has
 * taken the following notes" list, whose dots are drawn shapes, not text) are
 * detected from those dots — or, failing that, indentation — → "- item" lines.
 */
export function linesToText(lines: LayoutLine[]): string {
  if (lines.length === 0) return "";
  const maxRight = Math.max(...lines.map((l) => l.x1));
  const baseX = Math.min(...lines.map((l) => l.x0));
  const indented = (l: LayoutLine) => l.bullet || l.x0 > baseX + 12;
  const hasDots = lines.some((l) => l.bullet);
  const short = (l: LayoutLine) => l.x1 < maxRight - l.fontSize * 6;
  type Block = { list: boolean; items: string[] };
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = lines[i - 1];
    const block = blocks[blocks.length - 1];
    if (!prev || !block) {
      blocks.push({ list: indented(l), items: [l.text] });
      continue;
    }
    const gap = l.page === prev.page ? l.y0 - prev.y1 : 0;
    const endsSentence = /[.?!:"”’)]$/.test(prev.plain);
    const newParagraph =
      (l.page === prev.page && gap > prev.fontSize * 0.6) ||
      (l.page !== prev.page && endsSentence && short(prev)) ||
      indented(l) !== block.list;
    if (newParagraph) {
      blocks.push({ list: indented(l), items: [l.text] });
      continue;
    }
    if (block.list && (hasDots ? l.bullet : short(prev))) {
      block.items.push(l.text); // next bullet item
      continue;
    }
    const last = block.items.length - 1;
    // "Albright-" + "Knox", "out-of-the-" + "way": a word split at a hyphen.
    if (/[A-Za-z0-9]-$/.test(prev.plain)) block.items[last] += l.text;
    else block.items[last] += " " + l.text;
  }
  let out = "";
  blocks.forEach((b, i) => {
    const body = b.list ? b.items.map((t) => `- ${cleanText(t)}`).join("\n") : cleanText(b.items.join(" "));
    if (i === 0) out = body;
    else out += (b.list ? "\n" : "\n\n") + body;
  });
  return out;
}

// ── Crop transcription ───────────────────────────────────────────────

const TranscribeSchema = z.object({
  parts: z.array(
    z.object({
      id: z.string().describe("The slot id exactly as given, e.g. STEM-2, A, B"),
      text: z
        .string()
        .describe(
          "All readable text/math in this piece, verbatim, in reading order, with math in $…$ and any data table as a GitHub-Flavored Markdown table. Empty string if the piece is only a figure. Never describe a figure here.",
        ),
      figures: z
        .array(
          z.object({
            alt: z.string().describe("One-line description of the figure"),
            x0: z.number().describe("Left edge as a fraction (0..1) of THIS piece's width"),
            y0: z.number().describe("Top edge as a fraction (0..1) of THIS piece's height"),
            x1: z.number().describe("Right edge as a fraction (0..1) of THIS piece's width"),
            y1: z.number().describe("Bottom edge as a fraction (0..1) of THIS piece's height"),
          }),
        )
        .describe("Graphs, charts, diagrams, geometric figures, number lines, pictures inside this piece. Empty when there are none."),
    }),
  ),
});

const TRANSCRIBE_SYSTEM = `You transcribe small pieces of ONE SAT question. Each piece is labelled with a slot id (STEM-n for parts of the question stem, A/B/C/D for the answer choices). You see only that question's pieces, so transcribe each piece exactly where it is labelled — never move content between slots.

For each IMAGE piece:
- text: every word, number and expression in the image, verbatim and in reading order (a stem image often holds a figure AND the question sentence — transcribe the sentence). Data tables you can read → a GitHub-Flavored Markdown table (header row, | --- | separator, one row per line) placed where the table sits relative to the prose; a table's title/caption goes on its own line directly above the table. Ignore watermarks.
- figures: every graph, chart, diagram, geometric figure, number line or picture — anything that cannot be faithfully written as text — with a tight bounding box (fractions of THIS piece) that includes its axis labels, tick labels, titles, legends and captions but NOT the question prose. A chart's title, axis labels, legend and any "Note: Figure not drawn to scale" caption belong to the FIGURE (inside its box), never to text. The figure is cropped and shown to the student as an image. NEVER write a figure out as prose such as "[Bar chart: …]", and do not repeat its labels in text.
This applies equally to Math and to Reading & Writing pieces.

For each TEXT piece (plain text already extracted from the PDF): return the SAME words and numbers in text, only adding the math formatting below (wrap expressions in $…$, LaTeX for fractions/exponents/roots), and figures=[]. Do not reword, add, or drop anything.

Blanks are written as exactly six underscores "______". Keep <u>…</u> underline tags that appear in text pieces.

${MATH_FORMAT_RULES}

Return one entry per slot id you were given, in the same order.`;

type Transcribed = z.infer<typeof TranscribeSchema>["parts"][number];

interface Slot {
  id: string;
  kind: "text" | "image";
  text?: string;
  png?: Buffer;
  page?: number;
  rect?: Rect;
}

async function transcribeSlots(
  questionNumber: number,
  slots: Slot[],
  callerUserId?: string,
): Promise<Map<string, Transcribed>> {
  const content: ({ type: "text"; text: string } | { type: "image"; image: Buffer; mediaType: string })[] = [
    { type: "text", text: `SAT question ${questionNumber}. Transcribe each labelled piece.` },
  ];
  for (const s of slots) {
    if (s.kind === "image" && s.png) {
      content.push({ type: "text", text: `[${s.id}] IMAGE:` });
      content.push({ type: "image", image: s.png, mediaType: "image/png" });
    } else {
      content.push({ type: "text", text: `[${s.id}] TEXT:\n${s.text ?? ""}` });
    }
  }
  const res = await generateObject({
    model: anthropic(MODEL),
    schema: TranscribeSchema,
    system: TRANSCRIBE_SYSTEM,
    messages: [{ role: "user", content }],
    maxRetries: 2,
    maxOutputTokens: 4000,
  });
  const inTok = res.usage?.inputTokens ?? 0;
  const outTok = res.usage?.outputTokens ?? 0;
  await logUsage({
    userId: callerUserId,
    route: "printout-transcribe",
    tokensInput: inTok,
    tokensOutput: outTok,
    model: MODEL,
    costCents: Math.round((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500),
    metadata: { question_number: questionNumber, slots: slots.length },
  });
  const map = new Map<string, Transcribed>();
  for (const p of res.object.parts) map.set(p.id.trim().toUpperCase(), p);
  return map;
}

/** Formatting may add $, \frac, braces — never words or digits. */
function sameContent(raw: string, formatted: string): boolean {
  const strip = (s: string) =>
    normalizeChoiceText(s.replace(/<\/?u>/g, "").replace(/\\(dfrac|tfrac|frac|sqrt|cdot|times|div|pm|le|ge|leq|geq|neq|pi|circ|degree|left|right|text|mathrm|quad|,)/g, " "));
  return strip(raw) === strip(formatted);
}

// ── Metadata (domain / skill / difficulty) ───────────────────────────

const ClassifySchema = z.object({
  questions: z.array(
    z.object({
      number: z.number(),
      domain: z.string(),
      skill: z.string(),
      concept: z.string(),
      difficulty: z.enum(["Easy", "Medium", "Hard"]),
    }),
  ),
});

async function classifyQuestions(
  qs: { number: number; text: string; choices: string[] }[],
  section: ModuleMetadata["section"],
  callerUserId?: string,
): Promise<Map<number, z.infer<typeof ClassifySchema>["questions"][number]>> {
  const domains =
    section === "Math"
      ? `"Algebra", "Advanced Math", "Problem Solving and Data Analysis", "Geometry and Trigonometry"`
      : `"Information and Ideas", "Craft and Structure", "Expression of Ideas", "Standard English Conventions"`;
  const res = await generateObject({
    model: anthropic(MODEL),
    schema: ClassifySchema,
    system: `Classify SAT ${section} questions. domain must be EXACTLY one of: ${domains}. skill = a more specific SAT skill (e.g. "Transitions", "Linear equations in one variable"); concept = finer-grained concept; difficulty Easy/Medium/Hard by typical SAT conventions (Medium when unsure). Return one entry per question number.`,
    messages: [
      {
        role: "user",
        content: qs
          .map((q) => `Q${q.number}: ${q.text.slice(0, 900)}\nChoices: ${q.choices.map((c, i) => `${LABELS[i]}) ${c.slice(0, 120)}`).join(" | ")}`)
          .join("\n\n"),
      },
    ],
    maxRetries: 2,
    maxOutputTokens: 6000,
  });
  const inTok = res.usage?.inputTokens ?? 0;
  const outTok = res.usage?.outputTokens ?? 0;
  await logUsage({
    userId: callerUserId,
    route: "printout-classify",
    tokensInput: inTok,
    tokensOutput: outTok,
    model: MODEL,
    costCents: Math.round((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500),
    metadata: { count: qs.length },
  });
  return new Map(res.object.questions.map((q) => [q.number, q]));
}

// ── Main entry ───────────────────────────────────────────────────────

export interface PrintoutParseResult {
  /** False → not this format; caller falls back to the AI parse. */
  detected: boolean;
  questions: ParsedQuestion[];
  stats: { questions: number; answersDetected: number; imagesTranscribed: number; figures: number; needsReview: number };
}

export async function parsePrintoutPdf(
  pdfBase64: string,
  meta: ModuleMetadata,
  callerUserId?: string,
): Promise<PrintoutParseResult> {
  const empty = { questions: 0, answersDetected: 0, imagesTranscribed: 0, figures: 0, needsReview: 0 };
  const layout = await readPrintoutLayout(pdfBase64);
  const segs = segmentPrintout(layout);
  if (!looksLikePrintout(segs)) return { detected: false, questions: [], stats: empty };

  const isMath = meta.section === "Math";
  const imagePages = new Set<number>();
  for (const q of segs) {
    for (const p of [...q.stem, ...q.choices.flatMap((c) => c.parts)]) if (p.kind === "image") imagePages.add(p.page);
  }
  const rendered = imagePages.size > 0 ? await renderPdfPages(pdfBase64, imagePages) : new Map();
  const cropPng = async (page: number, r: Rect): Promise<Buffer | undefined> => {
    const pg = rendered.get(page);
    const dims = layout.pages[page - 1];
    if (!pg || !dims) return undefined;
    const sx = pg.widthPx / dims.width;
    const sy = pg.heightPx / dims.height;
    const left = Math.max(0, Math.floor((r.x0 - 2) * sx));
    const top = Math.max(0, Math.floor((r.y0 - 2) * sy));
    const width = Math.min(pg.widthPx - left, Math.ceil((r.x1 - r.x0 + 4) * sx));
    const height = Math.min(pg.heightPx - top, Math.ceil((r.y1 - r.y0 + 4) * sy));
    if (width < 4 || height < 4) return undefined;
    return sharp(pg.png).extract({ left, top, width, height }).png().toBuffer();
  };
  // The model's figure box (fractions of the crop) is only approximate — it
  // tends to clip axis labels and "Figure not drawn to scale" captions. Snap
  // it to the image's actual ink: take the ink bands (rows separated by blank
  // space) it overlaps, pull in small caption/axis-label bands directly above
  // or below, and span the full horizontal ink extent of those rows.
  const snapFigure = async (page: number, r: Rect, f: { x0: number; y0: number; x1: number; y1: number }): Promise<Rect> => {
    const pg = rendered.get(page);
    const dims = layout.pages[page - 1];
    if (!pg || !dims) return r;
    const sx = pg.widthPx / dims.width;
    const sy = pg.heightPx / dims.height;
    const left = Math.max(0, Math.floor(r.x0 * sx));
    const top = Math.max(0, Math.floor(r.y0 * sy));
    const width = Math.min(pg.widthPx - left, Math.floor((r.x1 - r.x0) * sx));
    const height = Math.min(pg.heightPx - top, Math.floor((r.y1 - r.y0) * sy));
    if (width < 8 || height < 8) return r;
    const { data, info } = await sharp(pg.png).extract({ left, top, width, height }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const ink = (x: number, y: number) => data[y * W + x] < 160;
    const bands: { y0: number; y1: number }[] = [];
    let start = -1;
    for (let y = 0; y <= info.height; y++) {
      let c = 0;
      if (y < info.height) for (let x = 0; x < W && c < 2; x++) if (ink(x, y)) c++;
      if (c >= 2 && start < 0) start = y;
      if (c < 2 && start >= 0) {
        bands.push({ y0: start, y1: y });
        start = -1;
      }
    }
    const fy0 = Math.max(0, f.y0) * info.height;
    const fy1 = Math.min(1, f.y1) * info.height;
    let sel = bands.map((b, i) => ({ ...b, i })).filter((b) => b.y1 > fy0 && b.y0 < fy1);
    if (sel.length === 0) return r;
    const small = 7 * sy; // caption / axis-label height (≈7pt), smaller than a prose line
    const near = 10 * sy;
    let lo = sel[0].i;
    let hi = sel[sel.length - 1].i;
    while (hi + 1 < bands.length && bands[hi + 1].y1 - bands[hi + 1].y0 <= small && bands[hi + 1].y0 - bands[hi].y1 <= near) hi++;
    while (lo - 1 >= 0 && bands[lo - 1].y1 - bands[lo - 1].y0 <= small && bands[lo].y0 - bands[lo - 1].y1 <= near) lo--;
    sel = bands.slice(lo, hi + 1).map((b, k) => ({ ...b, i: lo + k }));
    const y0 = sel[0].y0;
    const y1 = sel[sel.length - 1].y1;
    let x0 = W;
    let x1 = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        if (ink(x, y)) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        }
      }
    }
    if (x1 <= x0) return r;
    const m = 3; // pt margin
    return {
      x0: Math.max(r.x0, r.x0 + x0 / sx - m),
      y0: Math.max(r.y0, r.y0 + y0 / sy - m),
      x1: Math.min(r.x1, r.x0 + x1 / sx + m),
      y1: Math.min(r.y1, r.y0 + y1 / sy + m),
    };
  };
  const regionOf = (page: number, r: Rect, alt: string): ParsedImageRegion => {
    const d = layout.pages[page - 1];
    return {
      page,
      x_pct: r.x0 / d.width,
      y_pct: r.y0 / d.height,
      w_pct: (r.x1 - r.x0) / d.width,
      h_pct: (r.y1 - r.y0) / d.height,
      alt,
      pad: 0.004,
    };
  };

  const stats = { ...empty, questions: segs.length };
  const built: (ParsedQuestion & { _choiceTexts: string[] })[] = new Array(segs.length);

  // Questions are independent (each call sees only its own crops), so run a
  // few at a time to keep a 22–27 question module well inside the route budget.
  const CONCURRENCY = 4;
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < segs.length) {
      const idx = nextIdx++;
      built[idx] = await buildQuestion(segs[idx]);
    }
  };
  const buildQuestion = async (q: PrintoutQuestion): Promise<ParsedQuestion & { _choiceTexts: string[] }> => {
    const reasons: string[] = [];
    const regions: ParsedImageRegion[] = [];
    const isMC = q.choices.length > 0;

    // Slots: every image needs a transcription; Math text gets $…$ formatting.
    const slots: Slot[] = [];
    const stemIds: string[] = [];
    q.stem.forEach((p, i) => {
      const id = `STEM-${i + 1}`;
      stemIds.push(id);
      if (p.kind === "image") slots.push({ id, kind: "image", page: p.page, rect: p.rect });
      else if (isMath) slots.push({ id, kind: "text", text: linesToText(p.lines) });
    });
    const choiceSlotParts = q.choices.map((c) => ({ label: c.label, parts: c.parts }));
    for (const c of choiceSlotParts) {
      const img = c.parts.find((p) => p.kind === "image");
      if (img && img.kind === "image") slots.push({ id: c.label, kind: "image", page: img.page, rect: img.rect });
      else if (isMath && c.parts.length > 0) slots.push({ id: c.label, kind: "text", text: c.parts.map((p) => (p.kind === "text" ? linesToText(p.lines) : "")).join(" ") });
    }
    for (const s of slots) if (s.kind === "image" && s.page && s.rect) s.png = await cropPng(s.page, s.rect);

    let tx = new Map<string, Transcribed>();
    if (slots.length > 0) {
      try {
        tx = await transcribeSlots(q.number, slots, callerUserId);
        stats.imagesTranscribed += slots.filter((s) => s.kind === "image").length;
      } catch (err) {
        console.error(`[printout-parser] q${q.number} transcription failed:`, err);
      }
    }
    // Snap every reported figure box to the image's real ink (see snapFigure).
    const figureRects = new Map<string, { alt: string; rect: Rect }[]>();
    for (const s of slots) {
      const t = tx.get(s.id);
      if (s.kind !== "image" || !t || !s.page || !s.rect) continue;
      const list: { alt: string; rect: Rect }[] = [];
      for (const f of t.figures ?? []) {
        const ok = [f.x0, f.y0, f.x1, f.y1].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && f.y1 - f.y0 > 0.03;
        list.push({ alt: f.alt, rect: ok ? await snapFigure(s.page, s.rect, f) : s.rect });
      }
      figureRects.set(s.id, list);
    }
    const slotText = (s: Slot | undefined, fallback: string, where: string): string => {
      if (!s) return fallback;
      const t = tx.get(s.id);
      if (s.kind === "text") {
        // Formatting only: keep the raw PDF text if the model changed content.
        return t && sameContent(fallback, t.text) ? t.text.trim() : fallback;
      }
      const figs = t?.figures ?? [];
      if (!t || (!t.text.trim() && figs.length === 0)) {
        reasons.push(`could not read the image for ${where} — check it against the PDF`);
        return "";
      }
      const isChoice = where.startsWith("choice");
      for (const f of figureRects.get(s.id) ?? []) {
        regions.push(regionOf(s.page!, f.rect, isChoice ? `Answer ${where}: ${f.alt}` : f.alt));
        stats.figures++;
      }
      const text = t.text.trim();
      return text || (isChoice && figs.length > 0 ? `Figure ${where.slice(-1)}` : "");
    };

    // Stem
    const stemPieces: string[] = [];
    q.stem.forEach((p, i) => {
      const slot = slots.find((s) => s.id === stemIds[i]);
      const raw = p.kind === "text" ? linesToText(p.lines) : "";
      const piece = slotText(slot, raw, "the question stem");
      if (piece) stemPieces.push(piece);
    });
    const questionText = cleanText(stemPieces.join("\n\n")).replace(/ ?\n\n ?/g, "\n\n");
    if (!questionText && regions.length === 0) reasons.push("the question stem is empty in the source PDF");

    // Choices
    const choices: { label: Label; text: string }[] = [];
    for (const c of q.choices) {
      const slot = slots.find((s) => s.id === c.label);
      const raw = c.parts.map((p) => (p.kind === "text" ? linesToText(p.lines) : "")).join(" ").trim();
      choices.push({ label: c.label, text: cleanText(slotText(slot, raw, `choice ${c.label}`)) });
    }
    if (isMC) {
      const missing = LABELS.filter((l) => !choices.find((c) => c.label === l && c.text));
      if (missing.length > 0) {
        reasons.push(
          `source PDF shows ${4 - missing.length} of 4 answer choices — choice${missing.length > 1 ? "s" : ""} ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing or not readable`,
        );
      }
    }

    // Answer
    let answer: string | null = null;
    if (isMC) answer = q.checked;
    else if (q.sprAnswer.length > 0 && q.sprChecked) answer = cleanText(q.sprAnswer.map((l) => l.plain).join(" "));
    else if (q.sprAnswer.length > 0) {
      // Text in an answer box without the tick could be a student's entry.
      reasons.push("the student-produced-response answer box in the source PDF isn't ticked — the answer could not be confirmed");
    }
    if (answer) stats.answersDetected++;

    if (reasons.length > 0) stats.needsReview++;
    return {
      original_question_number: q.number,
      question_text: questionText,
      choices,
      correct_answer: answer,
      explanation: null,
      difficulty: "Medium",
      domain: "",
      skill: "",
      concept: "",
      question_type: isMC ? "Multiple Choice" : "Student Produced Response",
      has_image: regions.length > 0,
      has_table: false,
      has_formula: /\$[^$]+\$/.test(questionText + choices.map((c) => c.text).join(" ")),
      page_number: q.stemPage,
      // Below the 0.9 auto-promote bar when a reason exists (the reason, not a
      // generic "low confidence" note, explains why).
      ai_confidence_score: reasons.length > 0 ? 0.75 : 0.97,
      image_regions: regions,
      review_reasons: reasons,
      _choiceTexts: choices.map((c) => c.text),
    };
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, worker));

  // Domain / skill / difficulty — text-only, one call for the module.
  try {
    const cls = await classifyQuestions(
      built.map((b) => ({ number: b.original_question_number, text: b.question_text, choices: b._choiceTexts })),
      meta.section,
      callerUserId,
    );
    for (const b of built) {
      const c = cls.get(b.original_question_number);
      if (c) Object.assign(b, { domain: c.domain, skill: c.skill, concept: c.concept, difficulty: c.difficulty });
    }
  } catch (err) {
    console.error("[printout-parser] classification failed (non-fatal):", err);
  }
  const questions: ParsedQuestion[] = built.map(({ _choiceTexts: _drop, ...b }) => ({
    ...b,
    domain: b.domain || (meta.section === "Math" ? "Algebra" : "Information and Ideas"),
    skill: b.skill || "Unclassified",
    concept: b.concept || "Unclassified",
  }));
  return { detected: true, questions, stats };
}
