// lib/post-parse-cleanup.ts
//
// Self-check pass that runs at the tail of /api/admin/modules/[id]/parse
// once the solver and answer-key reconciliation are done. Catches the
// recurring parser shapes that have shown up in production so the
// admin doesn't have to ad-hoc rerun the scripts/* equivalents after
// every new module:
//
//   1. "____ blank" parser artifact in question_text — strip the
//      literal word "blank" after a row of underscores.
//   2. R&W "function of the underlined portion" rows whose question_text
//      doesn't carry the <u>…</u> markup — re-extract the underline from
//      source_pdf_url with Claude and wrap it.
//   3. Multiple Choice rows with an empty / null choices array — re-
//      extract the A/B/C/D options from source_pdf_url with Claude.
//   4. Structural audit (10 checks) — demote anomalies to Needs Review
//      with a parsing_note that names the failed check ids.
//
// Each helper is idempotent and scoped to a single module_id. Failures
// are caught and logged; the parse response still returns success
// when post-cleanup throws so the admin's foreground flow isn't
// blocked on a network blip.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import katex from "katex";

export interface PostParseCleanupSummary {
  blanksStripped: number;
  underlinesRepaired: number;
  choicesRecovered: number;
  hasTableFlagFixed: number;
  currencyDollarsEscaped: number;
  pureNumericMathUnwrapped: number;
  blindImagesResolved: number;
  anomaliesDemoted: number;
  errors: string[];
}

async function fetchPdfBase64(url: string): Promise<string> {
  const headers: Record<string, string> = {};
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

// ── 1. Strip "____ blank" artifact ─────────────────────────────────
async function stripBlankWord(
  moduleId: string,
  db: SupabaseClient,
): Promise<number> {
  const PATTERN = /(_{2,})\s+blank\b/gi;
  const { data, error } = await db
    .from("questions")
    .select("id, question_text")
    .eq("module_id", moduleId)
    .or(
      "question_text.ilike.%__ blank%,question_text.ilike.%___ blank%,question_text.ilike.%____ blank%",
    );
  if (error) throw new Error(`stripBlankWord select: ${error.message}`);
  let patched = 0;
  for (const q of data ?? []) {
    const text: string = q.question_text ?? "";
    PATTERN.lastIndex = 0;
    if (!PATTERN.test(text)) continue;
    const next = text.replace(PATTERN, "$1");
    if (next === text) continue;
    const { error: upErr } = await db
      .from("questions")
      .update({ question_text: next })
      .eq("id", q.id);
    if (!upErr) patched++;
  }
  return patched;
}

// ── 2. Repair "underlined portion" without <u> tag ────────────────
const UnderlineSchema = z.object({
  underlined_runs: z
    .array(z.string())
    .describe(
      "Each underlined run from the passage, in reading order, verbatim character-for-character. Empty array if no underline is visible.",
    ),
});

const UNDERLINE_SYSTEM = `You are reading an SAT R&W question page. One question asks "Which choice best describes the function of the underlined portion(s)…". Return every run of text in the passage that has an actual underline drawn under it in the PDF, verbatim.

Rules:
- Copy each run character-for-character. No paraphrase, no quote normalization, no spelling fixes.
- Include leading/trailing punctuation only when underlined.
- Each underline is a separate array entry, in reading order.
- Empty array if no underline visible.

Return JSON only.`;

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function levenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    dp[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > cap) return cap + 1;
  }
  return dp[b.length];
}
function fuzzyFindSubstring(
  haystack: string,
  needle: string,
  maxEdits: number,
): { start: number; end: number; found: string } | null {
  const n = needle.length;
  let best: { start: number; end: number; dist: number } | null = null;
  for (let i = 0; i <= haystack.length - n; i++) {
    const window = haystack.slice(i, i + n);
    const d = levenshtein(window, needle, maxEdits);
    if (d <= maxEdits && (!best || d < best.dist)) {
      best = { start: i, end: i + n, dist: d };
      if (d === 0) break;
    }
  }
  if (!best) return null;
  return {
    start: best.start,
    end: best.end,
    found: haystack.slice(best.start, best.end),
  };
}
function wrapUnderlinedRuns(
  text: string,
  runs: string[],
): { next: string; matched: number } {
  let next = text;
  let matched = 0;
  const normalizePunct = (s: string) =>
    s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
  for (const run of runs) {
    if (!run) continue;
    if (next.includes(run)) {
      next = next.replace(run, `<u>${run}</u>`);
      matched++;
      continue;
    }
    const normText = normalizePunct(next);
    const normRun = normalizePunct(run);
    if (normText.includes(normRun)) {
      next = next.replace(
        new RegExp(escapeRegExp(normRun), "g"),
        `<u>${normRun}</u>`,
      );
      matched++;
      continue;
    }
    const m = fuzzyFindSubstring(next, run, 2);
    if (m) {
      next =
        next.slice(0, m.start) + `<u>${m.found}</u>` + next.slice(m.end);
      matched++;
    }
  }
  return { next, matched };
}

async function repairUnderlines(
  moduleId: string,
  db: SupabaseClient,
): Promise<number> {
  const { data, error } = await db
    .from("questions")
    .select("id, original_question_number, question_text, source_pdf_url")
    .eq("module_id", moduleId)
    .ilike("question_text", "%underlined portion%");
  if (error) throw new Error(`repairUnderlines select: ${error.message}`);
  const candidates = (data ?? []).filter(
    (q) => !/<u\b/i.test(q.question_text ?? ""),
  );
  let patched = 0;
  for (const q of candidates) {
    if (!q.source_pdf_url) continue;
    try {
      const pdfBase64 = await fetchPdfBase64(q.source_pdf_url);
      const result = await generateObject({
        model: anthropic("claude-haiku-4-5"),
        schema: UnderlineSchema,
        system: UNDERLINE_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "file", data: pdfBase64, mediaType: "application/pdf" },
              {
                type: "text",
                text: `Question ${q.original_question_number ?? "?"}. Return underlined_runs.`,
              },
            ],
          },
        ],
      });
      const runs = result.object.underlined_runs
        .map((s) => s.trim())
        .filter(Boolean);
      if (runs.length === 0) continue;
      const { next, matched } = wrapUnderlinedRuns(q.question_text ?? "", runs);
      if (matched === 0) continue;
      const { error: upErr } = await db
        .from("questions")
        .update({ question_text: next })
        .eq("id", q.id);
      if (!upErr) patched++;
    } catch (e) {
      console.error(
        `[post-parse-cleanup] underline ${q.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return patched;
}

// ── 3. Recover missing MCQ choices ────────────────────────────────
const ChoicesSchema = z.object({
  choices: z
    .array(z.object({ label: z.enum(["A", "B", "C", "D"]), text: z.string() }))
    .describe(
      "The four answer choices for the multiple-choice question on this page, in order A, B, C, D. Copy verbatim from the PDF.",
    ),
});

const CHOICES_SYSTEM = `You are extracting answer choices for a single SAT R&W multiple-choice question from a PDF page. The question stem is given to you separately; only return the four A/B/C/D options verbatim from the page.

Rules:
- Copy each choice character-for-character. No paraphrase, no quote normalization.
- Wrap math expressions in $…$ per project convention.
- Return exactly four entries: A, B, C, D in order.`;

async function recoverMissingChoices(
  moduleId: string,
  db: SupabaseClient,
): Promise<number> {
  const { data, error } = await db
    .from("questions")
    .select(
      "id, original_question_number, question_text, source_pdf_url, choices",
    )
    .eq("module_id", moduleId)
    .eq("question_type", "Multiple Choice")
    .or("choices.is.null,choices.eq.[]");
  if (error) throw new Error(`recoverMissingChoices select: ${error.message}`);
  const candidates = (data ?? []).filter(
    (q) =>
      q.source_pdf_url &&
      (!Array.isArray(q.choices) || q.choices.length === 0),
  );
  let patched = 0;
  for (const q of candidates) {
    try {
      const pdfBase64 = await fetchPdfBase64(q.source_pdf_url as string);
      const result = await generateObject({
        model: anthropic("claude-haiku-4-5"),
        schema: ChoicesSchema,
        system: CHOICES_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "file", data: pdfBase64, mediaType: "application/pdf" },
              {
                type: "text",
                text: `Question ${q.original_question_number ?? "?"}. Stem:\n\n${q.question_text}\n\nReturn the four answer choices.`,
              },
            ],
          },
        ],
      });
      const choices = result.object.choices;
      if (choices.length < 2) continue;
      const { error: upErr } = await db
        .from("questions")
        .update({
          choices,
          parsing_status: "Needs Review",
          parsing_notes:
            "Choices re-extracted by post-parse-cleanup. Verify correct_answer still maps to the right letter before promoting to Approved.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", q.id);
      if (!upErr) patched++;
    } catch (e) {
      console.error(
        `[post-parse-cleanup] choices ${q.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return patched;
}

// ── 3b. Auto-fix has_table flag ────────────────────────────────────
//
// Parser sometimes leaves has_table=false even when question_text
// contains a proper markdown table. The renderer doesn't care (the
// table renders regardless), but downstream admin filters and the
// audit step do — fix the flag in-place instead of demoting the row.
async function fixHasTableFlag(
  moduleId: string,
  db: SupabaseClient,
): Promise<number> {
  const { data, error } = await db
    .from("questions")
    .select("id, has_table, question_text")
    .eq("module_id", moduleId)
    .neq("has_table", true);
  if (error) throw new Error(`fixHasTableFlag select: ${error.message}`);
  let patched = 0;
  for (const q of data ?? []) {
    const text: string = q.question_text ?? "";
    if (!text) continue;
    // Real markdown table = header row + dash separator row.
    if (!/\|\s*-{3,}\s*\|/.test(text)) continue;
    const { error: upErr } = await db
      .from("questions")
      .update({ has_table: true })
      .eq("id", q.id);
    if (!upErr) patched++;
  }
  return patched;
}

// ── 3b'. Escape currency dollar signs ──────────────────────────────
//
// SAT prose constantly mixes "$950" (currency) and "$t > 3$" (inline
// math) in the same sentence. The parser doesn't disambiguate, so
// once two unescaped `$` glyphs land in a single string the KaTeX
// renderer pairs them and renders everything in between as math —
// you get "950forthefirst3hoursandanadditional 50" instead of
// "$950 for the first 3 hours and an additional $50".
//
// Rule used here: any `$` that is NOT already escaped (`\$`) and
// is immediately followed by a digit / comma / period / digit-cluster
// is currency. Escape those, leave anything else alone. This
// preserves real inline math like `$x$`, `$t > 3$`, `$\frac{1}{2}$`
// because they start with a letter or backslash, not a digit.

const CURRENCY_DOLLAR_RE = /(^|[^\\])\$(?=\d)/g;

function escapeCurrencyDollars(text: string): string {
  if (!text) return text;
  return text.replace(CURRENCY_DOLLAR_RE, "$1\\$");
}

async function patchCurrencyDollars(
  moduleId: string,
  db: SupabaseClient,
): Promise<number> {
  const { data, error } = await db
    .from("questions")
    .select("id, question_text, choices, explanation")
    .eq("module_id", moduleId);
  if (error) throw new Error(`patchCurrencyDollars select: ${error.message}`);
  let patched = 0;
  for (const q of data ?? []) {
    const nextText = escapeCurrencyDollars((q.question_text as string) ?? "");
    const nextExpl = escapeCurrencyDollars((q.explanation as string) ?? "");
    let nextChoices: Array<{ label: string; text: string }> | null = null;
    if (Array.isArray(q.choices)) {
      const arr = q.choices as Array<{ label: string; text: string }>;
      const escaped = arr.map((c) => ({
        ...c,
        text: escapeCurrencyDollars(c.text ?? ""),
      }));
      const dirty = escaped.some((c, i) => c.text !== arr[i].text);
      if (dirty) nextChoices = escaped;
    }
    const textDirty = nextText !== (q.question_text ?? "");
    const explDirty = nextExpl !== (q.explanation ?? "");
    if (!textDirty && !explDirty && !nextChoices) continue;
    const update: Record<string, unknown> = {};
    if (textDirty) update.question_text = nextText;
    if (explDirty) update.explanation = nextExpl;
    if (nextChoices) update.choices = nextChoices;
    update.updated_at = new Date().toISOString();
    const { error: upErr } = await db
      .from("questions")
      .update(update)
      .eq("id", q.id);
    if (!upErr) patched++;
  }
  return patched;
}

// ── 3b''. Unwrap pure-numeric math regions ────────────────────────
//
// The parser keeps wrapping bare numbers in answer choices as
// inline math: "$180$", "$45$", "$1{,}150$". When the value is a
// pure number with no operators, variables, or LaTeX commands, the
// math wrap adds nothing and the renderer puts the number in italic
// serif (so "180" looks completely different from the other prose).
// Worse, half the time the parser pairs `$180$` with another stray
// `$` elsewhere in the same string and the whole thing becomes one
// runaway math region.
//
// Strip the wrap whenever the content between two unescaped `$`
// glyphs is a single token of digits / commas / a decimal / a
// leading minus, with optional LaTeX thin-space (`{,}`). Real math
// (`$x$`, `$x^2$`, `$\frac{1}{2}$`, `$1 + 2$`) starts with a
// letter / backslash / has an operator and is left alone.

const PURE_NUMERIC_MATH_RE =
  /(^|[^\\])\$\s*(-?\d[\d,]*(?:\{,\}\d+)?(?:\.\d+)?)\s*\$/g;

function unwrapPureNumericMath(text: string): string {
  if (!text) return text;
  let prev = "";
  let out = text;
  // Repeat until stable so adjacent wrap-pairs all get unwrapped.
  while (prev !== out) {
    prev = out;
    out = out.replace(PURE_NUMERIC_MATH_RE, (_m, lead: string, num: string) => {
      // Normalize LaTeX thin-space `{,}` back to plain comma — prose
      // doesn't need the math-mode thousand grouping macro.
      const normalized = num.replace(/\{,\}/g, ",");
      return `${lead}${normalized}`;
    });
  }
  return out;
}

async function unwrapPureNumericMathInModule(
  moduleId: string,
  db: SupabaseClient,
): Promise<number> {
  const { data, error } = await db
    .from("questions")
    .select("id, question_text, choices, explanation")
    .eq("module_id", moduleId);
  if (error) throw new Error(`unwrapPureNumericMath select: ${error.message}`);
  let patched = 0;
  for (const q of data ?? []) {
    const nextText = unwrapPureNumericMath((q.question_text as string) ?? "");
    const nextExpl = unwrapPureNumericMath((q.explanation as string) ?? "");
    let nextChoices: Array<{ label: string; text: string }> | null = null;
    if (Array.isArray(q.choices)) {
      const arr = q.choices as Array<{ label: string; text: string }>;
      const stripped = arr.map((c) => ({
        ...c,
        text: unwrapPureNumericMath(c.text ?? ""),
      }));
      const dirty = stripped.some((c, i) => c.text !== arr[i].text);
      if (dirty) nextChoices = stripped;
    }
    const textDirty = nextText !== (q.question_text ?? "");
    const explDirty = nextExpl !== (q.explanation ?? "");
    if (!textDirty && !explDirty && !nextChoices) continue;
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (textDirty) update.question_text = nextText;
    if (explDirty) update.explanation = nextExpl;
    if (nextChoices) update.choices = nextChoices;
    const { error: upErr } = await db
      .from("questions")
      .update(update)
      .eq("id", q.id);
    if (!upErr) patched++;
  }
  return patched;
}

// ── 3c. Resolve "blind image" questions ───────────────────────────
//
// Parser sometimes flags has_image=true on questions that, on
// second look, contain no figure at all — the parser was tricked by
// a header glyph or a stray rendered formula. Other times the
// question genuinely needs a figure that the image extractor missed.
//
// We send the PDF page to Claude with the stored question_text and
// ask one yes/no question: does this question actually need a
// figure to be answerable? If No, clear has_image so the row stops
// failing the blind-image audit check. If Yes, leave has_image=true
// and add a parsing note so the admin can re-extract the image
// manually (the heavy "render PDF page → crop → upload to storage"
// pipeline lives in the parser, not here).
const BlindImageSchema = z.object({
  needs_figure: z
    .boolean()
    .describe(
      "True if the SAT question on this page genuinely requires a figure/diagram/chart/graph/picture to be answerable. False if the question is pure text and can be solved without looking at any image.",
    ),
  reason: z
    .string()
    .max(220)
    .describe("One short sentence explaining the decision."),
});

const BLIND_IMAGE_SYSTEM = `You are auditing a single SAT question that the parser flagged as containing an image but for which the image extractor produced no URLs. Look at the PDF page and the stored question text.

Decide: does answering this question REQUIRE looking at a figure/diagram/chart/graph/picture? Examples that need a figure: bar charts, scatterplots, geometric diagrams, number lines with marked points, tables drawn as images, photographs in R&W context. Examples that DON'T need a figure: pure word problems with all numbers in the prose, algebra word problems, math questions where every value appears in the question text or LaTeX.

Be conservative — if the figure shows real data the student needs (axis labels, plotted points, geometric measurements), say true. If the figure is decorative or absent, say false.

Return JSON only.`;

async function resolveBlindImages(
  moduleId: string,
  db: SupabaseClient,
): Promise<number> {
  const { data, error } = await db
    .from("questions")
    .select(
      "id, original_question_number, question_text, source_pdf_url, has_image, image_urls",
    )
    .eq("module_id", moduleId)
    .eq("has_image", true)
    .or("image_urls.is.null,image_urls.eq.{}");
  if (error) throw new Error(`resolveBlindImages select: ${error.message}`);
  const candidates = (data ?? []).filter((q) => {
    const urls = q.image_urls as string[] | null;
    return q.source_pdf_url && (!Array.isArray(urls) || urls.length === 0);
  });
  let resolved = 0;
  for (const q of candidates) {
    try {
      const pdfBase64 = await fetchPdfBase64(q.source_pdf_url as string);
      const result = await generateObject({
        model: anthropic("claude-haiku-4-5"),
        schema: BlindImageSchema,
        system: BLIND_IMAGE_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "file", data: pdfBase64, mediaType: "application/pdf" },
              {
                type: "text",
                text: `Question ${q.original_question_number ?? "?"}.\n\nStored question text:\n\n${q.question_text ?? "(empty)"}\n\nDoes this question need a figure to be answerable?`,
              },
            ],
          },
        ],
      });
      const { needs_figure, reason } = result.object;
      if (needs_figure === false) {
        // No image actually needed — clear has_image so blind-image
        // audit check stops firing on the next pass.
        const { error: upErr } = await db
          .from("questions")
          .update({
            has_image: false,
            parsing_notes: `post-parse-cleanup cleared has_image flag (no figure required): ${reason}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", q.id);
        if (!upErr) resolved++;
      } else {
        // Figure genuinely required but URLs missing — leave the
        // flag on, but record why so the admin knows manual image
        // re-extraction is needed instead of just toggling a flag.
        await db
          .from("questions")
          .update({
            parsing_notes: `Needs manual image re-extraction (Claude audit: ${reason})`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", q.id);
      }
    } catch (e) {
      console.error(
        `[post-parse-cleanup] blindImage ${q.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return resolved;
}

// ── 4. Structural audit + demote ───────────────────────────────────
function pipeFlattenedTable(text: string): boolean {
  if (/\|\s*-{3,}\s*\|/.test(text)) return false;
  const stripped = text
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$\n]*\$/g, "");
  for (const line of stripped.split("\n")) {
    const cells = (line.match(/\|/g) ?? []).length;
    if (cells >= 3) return true;
  }
  return false;
}

function letterFromExplanationTrailer(
  explanation: string | null,
): string | null {
  if (!explanation) return null;
  const m = explanation.match(/Final answer:\s*([^\n]+)/i);
  if (!m) return null;
  const value = m[1].trim().replace(/[.,;)]+$/, "");
  return value || null;
}

interface AuditRow {
  id: string;
  section: string | null;
  question_type: string | null;
  question_text: string | null;
  choices: Array<{ label: string; text: string }> | null;
  correct_answer: string | null;
  explanation: string | null;
  has_image: boolean | null;
  image_urls: string[] | null;
  has_table: boolean | null;
}

// ── Math / table / image heuristics ────────────────────────────────
//
// Each heuristic strips $…$ and $$…$$ regions before applying its
// regexes so legitimate math like $\frac{1}{7}$ doesn't false-positive
// the "unwrapped math" check.
function stripMath(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]*\$/g, " ");
}

function hasUnwrappedMath(text: string): boolean {
  const noMath = stripMath(text);
  // Raw LaTeX macros outside math wrap — \frac / \sqrt / \pi / \cdot /
  // \times / \div / \log / \sin / \cos / \tan / \int / \sum / a^{n} /
  // _{n}. These shouldn't appear in prose; if the parser left them
  // exposed, the renderer prints the literal backslash command.
  if (/\\(?:frac|sqrt|pi|cdot|times|div|log|sin|cos|tan|int|sum)\b/.test(noMath)) {
    return true;
  }
  if (/[A-Za-z]\^\{[^}]+\}/.test(noMath)) return true;
  if (/[A-Za-z]_\{[^}]+\}/.test(noMath)) return true;
  // ASCII pseudo-math the project explicitly forbids in question_text
  // / choice text: bare "x^2" and "sqrt(...)" outside $…$. Skip pure
  // exponent like "2^4" that's in prose paragraphs (cheap heuristic:
  // require a letter on the LHS so "g(x) = x^2" trips but "240,000 /
  // 16 = 2^4" doesn't).
  if (/[A-Za-z]\^\d+(?!\$)/.test(noMath)) return true;
  if (/\bsqrt\s*\(/.test(noMath)) return true;
  return false;
}

function hasTableSyntax(text: string): boolean {
  // A markdown table requires both a header row of pipes AND the dash
  // separator row immediately after. Cheap version: the dash-separator
  // pattern is rare enough in prose that detecting it is reliable.
  if (/\|\s*-{3,}\s*\|/.test(text)) return true;
  // Multiple lines with 3+ pipes each is also table-ish (the flattened
  // shape, still counts as "tries to be a table").
  let lines = 0;
  for (const line of stripMath(text).split("\n")) {
    if ((line.match(/\|/g) ?? []).length >= 3) lines++;
    if (lines >= 2) return true;
  }
  return false;
}

// Returns true if any $…$ or $$…$$ region in the text fails to render
// through KaTeX. Mirrors the runtime rehype-katex pipeline so a hit
// here means the student would see a red error span or a raw LaTeX
// snippet instead of a typeset expression.
function mathRenderFails(text: string): boolean {
  if (!text) return false;
  const displayBlocks = text.match(/\$\$([\s\S]*?)\$\$/g) ?? [];
  for (const block of displayBlocks) {
    const expr = block.slice(2, -2);
    if (!expr.trim()) continue;
    try {
      katex.renderToString(expr, { throwOnError: true, displayMode: true });
    } catch {
      return true;
    }
  }
  // Strip display math first so the inline regex doesn't match $$ as
  // two adjacent inline $'s.
  const withoutDisplay = text.replace(/\$\$[\s\S]*?\$\$/g, " ");
  const inlineBlocks = withoutDisplay.match(/\$([^$\n]+)\$/g) ?? [];
  for (const block of inlineBlocks) {
    const expr = block.slice(1, -1);
    if (!expr.trim()) continue;
    try {
      katex.renderToString(expr, { throwOnError: true, displayMode: false });
    } catch {
      return true;
    }
  }
  return false;
}

function looksLikeValidUrl(u: string): boolean {
  if (!u || typeof u !== "string") return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const CHECKS: Array<{
  id: string;
  failed: (r: AuditRow) => boolean;
}> = [
  {
    id: "mcq-bad-choice-count",
    failed: (r) =>
      r.question_type === "Multiple Choice" &&
      (!Array.isArray(r.choices) || r.choices.length !== 4),
  },
  {
    id: "mcq-answer-not-in-choices",
    failed: (r) => {
      if (r.question_type !== "Multiple Choice") return false;
      if (!Array.isArray(r.choices) || r.choices.length === 0) return false;
      const ans = (r.correct_answer ?? "").trim().toUpperCase();
      if (!/^[A-D]$/.test(ans)) return true;
      const labels = new Set(
        r.choices.map((c) => (c.label ?? "").trim().toUpperCase()),
      );
      return !labels.has(ans);
    },
  },
  {
    id: "spr-with-letter-answer",
    failed: (r) =>
      r.question_type === "Student Produced Response" &&
      /^[A-D]$/i.test((r.correct_answer ?? "").trim()),
  },
  {
    id: "empty-text",
    failed: (r) => !r.question_text || r.question_text.trim().length === 0,
  },
  {
    id: "empty-answer",
    failed: (r) => !r.correct_answer || r.correct_answer.trim().length === 0,
  },
  {
    id: "rw-misclassified-as-spr",
    failed: (r) =>
      (r.section === "Reading & Writing" ||
        r.section === "Reading and Writing") &&
      r.question_type === "Student Produced Response",
  },
  {
    id: "blind-image",
    failed: (r) =>
      r.has_image === true &&
      (!Array.isArray(r.image_urls) || r.image_urls.length === 0),
  },
  {
    id: "blank-artifact",
    failed: (r) =>
      r.question_text != null && /_{2,}\s*blank\b/i.test(r.question_text),
  },
  {
    id: "pipe-flattened-table",
    failed: (r) =>
      r.question_text != null && pipeFlattenedTable(r.question_text),
  },
  {
    // has_table=true but the rendered text has no table syntax at all
    // → parser dropped the whole table when serializing.
    id: "has-table-flag-but-no-table-in-text",
    failed: (r) =>
      r.has_table === true &&
      r.question_text != null &&
      !hasTableSyntax(r.question_text),
  },
  {
    // has_image=true and image_urls has entries, but at least one
    // URL isn't a well-formed http(s) URL — the renderer will 404 it.
    id: "image-url-malformed",
    failed: (r) => {
      if (r.has_image !== true) return false;
      const urls = Array.isArray(r.image_urls) ? r.image_urls : [];
      if (urls.length === 0) return false; // blind-image catches this
      return urls.some((u) => !looksLikeValidUrl(u));
    },
  },
  {
    // question_text or any choice text contains math that the parser
    // forgot to wrap in $…$ delimiters. The renderer prints raw LaTeX
    // macros / ASCII pseudo-math which reads as garbage to students.
    id: "math-unwrapped",
    failed: (r) => {
      if (r.question_text && hasUnwrappedMath(r.question_text)) return true;
      if (Array.isArray(r.choices)) {
        for (const c of r.choices) {
          if (c.text && hasUnwrappedMath(c.text)) return true;
        }
      }
      return false;
    },
  },
  {
    // Every $…$ / $$…$$ region must round-trip through KaTeX. A
    // throw means the student would see a red KaTeX error span or
    // a raw LaTeX dump instead of a typeset expression. Covers the
    // "math doesn't render" failure mode (mismatched braces, unknown
    // macros, raw \begin{tabular} dropped into $…$, etc).
    id: "math-render-failed",
    failed: (r) => {
      if (r.question_text && mathRenderFails(r.question_text)) return true;
      if (r.explanation && mathRenderFails(r.explanation)) return true;
      if (Array.isArray(r.choices)) {
        for (const c of r.choices) {
          if (c.text && mathRenderFails(c.text)) return true;
        }
      }
      return false;
    },
  },
  {
    id: "explanation-final-mismatch",
    failed: (r) => {
      const trailer = letterFromExplanationTrailer(r.explanation);
      if (!trailer) return false;
      const stored = (r.correct_answer ?? "").trim();
      if (/^[A-D]$/i.test(trailer) && /^[A-D]$/i.test(stored)) {
        return trailer.toUpperCase() !== stored.toUpperCase();
      }
      const tNum = parseFloat(trailer.replace(/[,]/g, ""));
      const sNum = parseFloat(stored.replace(/[,]/g, ""));
      if (!Number.isNaN(tNum) && !Number.isNaN(sNum)) {
        return Math.abs(tNum - sNum) > 0.0001;
      }
      const norm = (s: string) =>
        s.trim().toLowerCase().replace(/^["']|["']$/g, "");
      return norm(trailer) !== norm(stored);
    },
  },
];

async function auditAndDemote(
  moduleId: string,
  db: SupabaseClient,
): Promise<number> {
  const { data, error } = await db
    .from("questions")
    .select(
      "id, section, question_type, question_text, choices, correct_answer, explanation, has_image, image_urls, has_table, parsing_status",
    )
    .eq("module_id", moduleId)
    .in("parsing_status", ["Approved", "Draft"]);
  if (error) throw new Error(`auditAndDemote select: ${error.message}`);
  let demoted = 0;
  for (const row of (data ?? []) as Array<AuditRow & { parsing_status: string }>) {
    const failed = CHECKS.filter((c) => c.failed(row)).map((c) => c.id);
    if (failed.length === 0) continue;
    const note = `Demoted by post-parse-cleanup: failed checks → ${failed.join(", ")}`;
    const { error: upErr } = await db
      .from("questions")
      .update({
        parsing_status: "Needs Review",
        parsing_notes: note,
        reviewed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (!upErr) demoted++;
  }
  return demoted;
}

// ── Top-level orchestrator ─────────────────────────────────────────
export async function runPostParseCleanup(
  moduleId: string,
  db: SupabaseClient,
): Promise<PostParseCleanupSummary> {
  const summary: PostParseCleanupSummary = {
    blanksStripped: 0,
    underlinesRepaired: 0,
    choicesRecovered: 0,
    hasTableFlagFixed: 0,
    currencyDollarsEscaped: 0,
    pureNumericMathUnwrapped: 0,
    blindImagesResolved: 0,
    anomaliesDemoted: 0,
    errors: [],
  };
  const safe = async <T>(
    label: string,
    fn: () => Promise<T>,
    onResult: (v: T) => void,
  ) => {
    try {
      onResult(await fn());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.errors.push(`${label}: ${msg}`);
      console.error(`[post-parse-cleanup] ${label} failed:`, msg);
    }
  };
  // Order matters: strip artifacts and recover missing pieces FIRST
  // (so the audit sees the repaired rows), then audit.
  await safe(
    "stripBlankWord",
    () => stripBlankWord(moduleId, db),
    (v) => (summary.blanksStripped = v),
  );
  await safe(
    "repairUnderlines",
    () => repairUnderlines(moduleId, db),
    (v) => (summary.underlinesRepaired = v),
  );
  await safe(
    "recoverMissingChoices",
    () => recoverMissingChoices(moduleId, db),
    (v) => (summary.choicesRecovered = v),
  );
  await safe(
    "fixHasTableFlag",
    () => fixHasTableFlag(moduleId, db),
    (v) => (summary.hasTableFlagFixed = v),
  );
  await safe(
    "patchCurrencyDollars",
    () => patchCurrencyDollars(moduleId, db),
    (v) => (summary.currencyDollarsEscaped = v),
  );
  await safe(
    "unwrapPureNumericMath",
    () => unwrapPureNumericMathInModule(moduleId, db),
    (v) => (summary.pureNumericMathUnwrapped = v),
  );
  await safe(
    "resolveBlindImages",
    () => resolveBlindImages(moduleId, db),
    (v) => (summary.blindImagesResolved = v),
  );
  await safe(
    "auditAndDemote",
    () => auditAndDemote(moduleId, db),
    (v) => (summary.anomaliesDemoted = v),
  );
  return summary;
}
