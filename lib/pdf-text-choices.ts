// lib/pdf-text-choices.ts
//
// Deterministic A/B/C/D choice extraction from a PDF's TEXT LAYER (no AI).
//
// Why: the AI parser reads the whole PDF in one pass and, on printouts where a
// question's stem sits at the bottom of page N and its boxed choices continue
// on page N+1 (after the URL footer + date header), it binds the choices
// printed at the TOP of a page to the stem printed BELOW them on that same
// page — i.e. the previous question's choices. The result is an off-by-one
// shift (Q2 gets Q1's choices, Q3 gets Q2's, …) or a splice where one option
// comes from the neighbour. The text layer preserves reading order across the
// page break, so walking it linearly gives the true question → choices
// binding, plus the checked answer on printouts that mark it with a
// check-circle glyph.
//
// Only "reliable" results are returned: a question must have exactly four
// labelled, non-empty choices in A→D order. Scanned PDFs (no text layer) or
// layouts this walker doesn't understand simply yield an empty / sparse map,
// and callers must treat a missing entry as "unknown", never as a mismatch.

export type ChoiceLabel = "A" | "B" | "C" | "D";

export interface PdfTextQuestion {
  number: number;
  choices: { label: ChoiceLabel; text: string }[];
  /** Label of the choice marked with a checkmark glyph, if any. */
  checked: ChoiceLabel | null;
  /** 1-indexed page where the stem ("N. …") starts. */
  stemPage: number;
  /** 1-indexed page where choice D ends (differs from stemPage on a page break). */
  choicesPage: number;
}

export interface PdfTextChoices {
  /** question number (as printed) → reliable extraction */
  byNumber: Map<number, PdfTextQuestion>;
  /** count of distinct question starts found (reliable or not) */
  questionsSeen: number;
  hasTextLayer: boolean;
}

const LABELS: ChoiceLabel[] = ["A", "B", "C", "D"];

// FontAwesome check icons (check-circle U+F058 as used by the "Survey: print
// page" printouts, check-circle-o, check, check-square[-o]) plus the common
// Unicode check marks.
const CHECK_GLYPH = /[\uf058\uf05d\uf00c\uf046\uf14a\u2713\u2714\u2705\u2611]/g;

// Browser print header/footer: "10/24/26, 4:59 PM   Survey: print page | …"
// and "https://… 1/36". These interrupt a question that spans a page break.
const HEADER_FOOTER = [
  /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}\s*(AM|PM)?\b/i,
  /^https?:\/\/\S+(\s+\d+\s*\/\s*\d+)?$/i,
  /^\d+\s*\/\s*\d+$/,
];

interface Line {
  page: number;
  text: string;
  checked: boolean;
}

/** Open a PDF with pdfjs in-process (no worker), Node-safe. Shared with lib/printout-parser.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPdfDocument(pdfBase64: string): Promise<{ doc: any; pdfjs: any }> {
  if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === "undefined") {
    try {
      const canvasModule = await import("@napi-rs/canvas");
      (globalThis as { DOMMatrix?: unknown }).DOMMatrix =
        (canvasModule as { DOMMatrix?: unknown }).DOMMatrix;
    } catch {
      // fall through — pdfjs will throw a clearer error
    }
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Same vendored worker as lib/ai/extract-images.ts (see the comment there).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfjs as any).GlobalWorkerOptions.workerSrc = new URL("./ai/pdf-worker.mjs", import.meta.url).href;
  const data = Uint8Array.from(Buffer.from(pdfBase64, "base64"));
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableWorker: true,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
  return { doc, pdfjs };
}

async function loadPdfLines(pdfBase64: string): Promise<{ lines: Line[]; hasTextLayer: boolean }> {
  const { doc } = await loadPdfDocument(pdfBase64);

  const lines: Line[] = [];
  let textChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group text items into visual lines by baseline y (PDF y grows upward).
    const rows: { y: number; items: { x: number; str: string }[] }[] = [];
    for (const it of content.items as { str?: string; transform?: number[] }[]) {
      if (typeof it.str !== "string" || !it.transform) continue;
      if (!it.str.trim()) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({ x, str: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      const raw = r.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
      const checked = CHECK_GLYPH.test(raw);
      CHECK_GLYPH.lastIndex = 0;
      const text = raw.replace(CHECK_GLYPH, "").trim();
      textChars += text.length;
      if (text && HEADER_FOOTER.some((re) => re.test(text))) continue;
      if (!text && !checked) continue;
      lines.push({ page: p, text, checked });
    }
    page.cleanup();
  }
  await doc.destroy();
  return { lines, hasTextLayer: textChars > 200 };
}

/** Walk the text layer and bind each numbered stem to the A–D choices that follow it. */
export async function extractChoicesFromPdfText(pdfBase64: string): Promise<PdfTextChoices> {
  const { lines, hasTextLayer } = await loadPdfLines(pdfBase64);
  const byNumber = new Map<number, PdfTextQuestion>();
  if (!hasTextLayer) return { byNumber, questionsSeen: 0, hasTextLayer };

  interface Cur {
    number: number;
    stemPage: number;
    choicesPage: number;
    choices: { label: ChoiceLabel; text: string }[];
    checked: ChoiceLabel | null;
    broken: boolean;
    /** Started from a bare number box; the "N." stem line is still to come. */
    awaitingStem: boolean;
  }
  let cur: Cur | null = null;
  let lastNum = 0;
  let questionsSeen = 0;

  const flush = () => {
    if (!cur) return;
    const ok =
      !cur.broken &&
      cur.choices.length === 4 &&
      cur.choices.every((c, i) => c.label === LABELS[i] && c.text.trim().length > 0);
    if (ok && !byNumber.has(cur.number)) {
      byNumber.set(cur.number, {
        number: cur.number,
        choices: cur.choices.map((c) => ({ label: c.label, text: c.text.trim() })),
        checked: cur.checked,
        stemPage: cur.stemPage,
        choicesPage: cur.choicesPage,
      });
    }
    cur = null;
  };

  for (const line of lines) {
    const t = line.text;
    // Question start: "N. text" where N continues the sequence.
    const qm = t.match(/^(\d{1,3})\.(?:\s+\S|$)/);
    if (qm) {
      // The stem line of a question already opened by its number box. Trust
      // the box: printouts occasionally carry a stale stem number
      // (box "17", stem "20. …").
      if (cur?.awaitingStem) {
        cur.awaitingStem = false;
        cur.stemPage = line.page;
        continue;
      }
      const n = Number(qm[1]);
      if (lastNum === 0 ? n >= 1 : n > lastNum && n <= lastNum + 2) {
        flush();
        cur = { number: n, stemPage: line.page, choicesPage: line.page, choices: [], checked: null, broken: false, awaitingStem: false };
        lastNum = n;
        questionsSeen++;
        continue;
      }
    }

    // Bare number box for the NEXT question ("5" above "5. Archaeologists…")
    // — only once the current question's choices are complete, so a numeric
    // choice ("D" → "5") is never mistaken for a box.
    if (/^\d{1,3}$/.test(t) && Number(t) === lastNum + 1) {
      const done = !cur || (cur.choices.length === 4 && !!cur.choices[3].text);
      if (done) {
        if (line.checked && cur && cur.choices.length > 0) cur.checked = cur.choices[cur.choices.length - 1].label;
        flush();
        const n = Number(t);
        cur = { number: n, stemPage: line.page, choicesPage: line.page, choices: [], checked: null, broken: false, awaitingStem: true };
        lastNum = n;
        questionsSeen++;
        continue;
      }
    }
    if (!cur) continue;
    const c: Cur = cur;
    const expected = LABELS[c.choices.length];

    // Label alone on its line: "A", "(A)", "A)", "A."
    const solo = t.match(/^\(?([A-D])\)?[.)]?$/);
    // Inline label: "A) text", "(A) text", "A. text"
    const inline = t.match(/^\(?([A-D])\)\s+(.+)$/) ?? t.match(/^([A-D])\.\s+(.+)$/);
    if (solo && expected && solo[1] === expected) {
      c.choices.push({ label: expected, text: "" });
      c.choicesPage = line.page;
      if (line.checked) c.checked = expected;
      continue;
    }
    if (inline && expected && inline[1] === expected) {
      c.choices.push({ label: expected, text: inline[2] });
      c.choicesPage = line.page;
      if (line.checked) c.checked = expected;
      continue;
    }
    if (solo && c.choices.length > 0 && solo[1] !== expected) {
      // Out-of-order label → layout we don't understand.
      c.broken = true;
      continue;
    }

    if (c.choices.length === 0) {
      // Still in the stem. A checkmark here is meaningless.
      c.awaitingStem = false;
      continue;
    }
    const last = c.choices[c.choices.length - 1];
    if (t) {
      last.text = last.text ? `${last.text} ${t}` : t;
      c.choicesPage = line.page;
    }
    if (line.checked) c.checked = last.label;
  }
  flush();
  return { byNumber, questionsSeen, hasTextLayer };
}

/**
 * Look up a question by its STORED (1..N) number. The parse route shifts
 * booklet-sliced numbering (e.g. 137–163) down to 1..N, so apply the same
 * offset here: the lowest printed number maps to 1.
 */
export function lookupPdfTextQuestion(pdfText: PdfTextChoices, storedNumber: number): PdfTextQuestion | null {
  if (pdfText.byNumber.size === 0) return null;
  const offset = Math.min(...pdfText.byNumber.keys()) - 1;
  // Only shift when the module clearly starts past 1 (a missed Q1 shouldn't shift everything).
  const shift = offset >= 3 ? offset : 0;
  return pdfText.byNumber.get(storedNumber + shift) ?? null;
}

/**
 * True when enough of the module was walked to trust the text layer as a
 * reference (guards against layouts the walker only half-understands).
 */
export function isTextLayerReliable(pdfText: PdfTextChoices, expectedQuestions: number): boolean {
  return pdfText.hasTextLayer && expectedQuestions > 0 && pdfText.byNumber.size >= Math.ceil(expectedQuestions * 0.6);
}

// ── Comparison ──────────────────────────────────────────────────────

/** Strip LaTeX / HTML / punctuation so "$\\frac{1}{2}$" and stored text compare on content. */
export function normalizeChoiceText(s: string): string {
  return (s || "")
    .normalize("NFKC")
    .replace(/<\/?u>/gi, "")
    .replace(/\\(text|mathrm|textbf|mathbf|dfrac|frac|sqrt|left|right|cdot|times|le|ge|leq|geq|pi|circ)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function letters(s: string): number {
  return (s.match(/[a-z]/g) ?? []).length;
}

/**
 * True when two choice texts plausibly say the same thing. Lenient on purpose:
 * we only want to catch a choice that came from a DIFFERENT question.
 */
export function choiceTextsAgree(stored: string, pdf: string): boolean {
  const a = normalizeChoiceText(stored);
  const b = normalizeChoiceText(pdf);
  if (a === b) return true;
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.includes(short) && short.length / long.length >= 0.8) return true;
  // The text layer can run past the last choice into content with no "N."
  // marker (a following table, an answer-key page). A long shared prefix
  // means it's the same choice plus spill.
  if (short.length >= 12 && long.startsWith(short)) return true;
  // Character-bigram Dice similarity — tolerant of hyphenation/ligatures.
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  const dice = (2 * inter) / Math.max(1, a.length - 1 + b.length - 1);
  return dice >= 0.85;
}

/**
 * Whether a choice is comparable via the text layer. Math choices (stacked
 * fractions, radicals, symbols) don't survive text extraction faithfully, so
 * only compare choices whose PDF text carries real words.
 */
export function isComparableChoice(pdfText: string): boolean {
  return letters(normalizeChoiceText(pdfText)) >= 3;
}

export interface ChoiceDiff {
  label: string;
  stored: string;
  pdf: string;
}

/** Compare stored choices to the text-layer ones. Returns per-choice mismatches (comparable choices only). */
export function diffChoices(
  stored: unknown,
  pdf: { label: ChoiceLabel; text: string }[],
): { comparable: number; diffs: ChoiceDiff[] } {
  const arr = Array.isArray(stored) ? (stored as { label?: string; text?: string }[]) : [];
  const diffs: ChoiceDiff[] = [];
  let comparable = 0;
  for (const p of pdf) {
    if (!isComparableChoice(p.text)) continue;
    comparable++;
    const s = arr.find((c) => (c?.label ?? "").trim().toUpperCase() === p.label);
    const sText = s?.text ?? "";
    if (!choiceTextsAgree(sText, p.text)) diffs.push({ label: p.label, stored: sText, pdf: p.text });
  }
  return { comparable, diffs };
}

/** "A) x | B) y | …" — compact form for parsing_notes. */
export function formatChoices(choices: { label: string; text: string }[]): string {
  return choices.map((c) => `${c.label}) ${c.text}`).join(" | ");
}

/**
 * Two MCQs whose four choices are identical are almost always a parser
 * misalignment (a stem reusing the neighbouring question's choices).
 */
export function sameChoiceSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  const key = (arr: unknown[]) =>
    arr.map((c) => normalizeChoiceText((c as { text?: string })?.text ?? String(c))).join("|");
  const ka = key(a);
  return ka.replace(/\|/g, "").length > 0 && ka === key(b);
}

export interface ChoiceAlignmentIssue {
  questionNumber: number;
  kind: "pdf-text-mismatch" | "duplicate-of-neighbour";
  /** Human-readable parsing_notes fragment (always mentions "choices" + "misalign"). */
  note: string;
  diffs?: ChoiceDiff[];
  pdfChoices?: { label: ChoiceLabel; text: string }[];
  neighbour?: number;
}

/**
 * Find MCQs whose stored choices don't belong to their stem:
 *  1. the PDF text layer (when reliable for this module) shows different
 *     choices after this stem, or
 *  2. (no text-layer verdict) the question has the exact same four choices as
 *     the previous question — the classic off-by-one shift.
 */
export function checkChoiceAlignment(
  questions: { original_question_number: number; question_type: string | null; choices: unknown }[],
  pdfText: PdfTextChoices | null,
): Map<number, ChoiceAlignmentIssue> {
  const out = new Map<number, ChoiceAlignmentIssue>();
  const sorted = [...questions].sort((a, b) => a.original_question_number - b.original_question_number);
  const reliable = !!pdfText && isTextLayerReliable(pdfText, sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const q = sorted[i];
    if (q.question_type !== "Multiple Choice") continue;
    const n = q.original_question_number;
    const tq = reliable ? lookupPdfTextQuestion(pdfText!, n) : null;
    if (tq) {
      const { diffs } = diffChoices(q.choices, tq.choices);
      if (diffs.length > 0) {
        out.set(n, {
          questionNumber: n,
          kind: "pdf-text-mismatch",
          note: `Needs review: Choice misalignment — ${diffs.length} of the stored answer choices don't match the PDF (they may belong to a neighbouring question). PDF shows ${formatChoices(tq.choices)}`,
          diffs,
          pdfChoices: tq.choices,
        });
      }
      continue;
    }
    const prev = sorted[i - 1];
    if (prev && prev.original_question_number === n - 1 && sameChoiceSet(q.choices, prev.choices)) {
      out.set(n, {
        questionNumber: n,
        kind: "duplicate-of-neighbour",
        note: `Needs review: Choice misalignment — same four answer choices as Q${n - 1}, so the choices were likely taken from the neighbouring question. Check them against the PDF.`,
        neighbour: n - 1,
      });
    }
  }
  return out;
}
