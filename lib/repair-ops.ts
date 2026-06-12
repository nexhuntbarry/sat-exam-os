// lib/repair-ops.ts
//
// Reusable single-question repair operations. The same logic that
// scripts/repair-math-render-failed.ts and
// scripts/repair-blind-image-regions.ts run against a whole module,
// surfaced as plain async functions so admin-UI API routes can
// trigger them with one button click.

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import katex from "katex";
import { getServiceClient } from "@/lib/supabase";
import { extractAndUploadQuestionImages } from "@/lib/ai/extract-images";

const REPAIR_MATH_SYSTEM = `You are re-extracting one SAT question from a PDF because the previous parser run produced text the KaTeX renderer couldn't display. Output a clean replacement.

For every numeric token, pick ONE form and stick to it:
(a) Pure value (180, 45, 1,150, -12, 0.33) — write BARE.
(b) Currency in prose (\\$5 admission) — write \\$<digits>, never wrap in $...$.
(c) Math expression (operator / variable / fraction / root / LaTeX command) — wrap in $...$ inline.
(d) Mixed currency + math — each piece by its own rule.

Hard rules:
- NEVER write "\\3", "\\10" — no LaTeX \\3 macro exists.
- NEVER write "\\$<digit>$" — pick form (a) or (c).
- Every $ in a field needs a matching closing $ in the SAME field. Currency $ must be escaped as \\$.
- Every $...$ region must hold a real math expression — never a number alone, never English prose.
- For Multiple Choice, return exactly four choices labelled A, B, C, D.

Return JSON only.`;

const RepairMathSchema = z.object({
  question_text: z.string(),
  choices: z
    .array(z.object({ label: z.enum(["A", "B", "C", "D"]), text: z.string() }))
    .optional(),
  explanation: z.string().optional(),
});

const PROSE_IN_MATH_RE_REPAIR =
  /\b(?:what|where|when|why|how|the|and|but|then|if|is|are|was|were|will|would|should|value|find|equation|graph|table|figure|show|gives|represents|following|using|since|because|let|so|that|which|each|any|some|both|either|neither|same|different)\b/i;

function isMathClean(text: string): { ok: boolean; reason?: string } {
  if (!text) return { ok: true };
  if (/(^|[^\\$])\\\d/.test(text)) return { ok: false, reason: "\\<digit>" };
  if (/(^|[^\\])\\\$[^$\n]{1,25}?\$/.test(text))
    return { ok: false, reason: "doubly-escaped wrap" };
  const sanitized = text.replace(/\\\$/g, "\x00");
  const dollars = (sanitized.match(/\$/g) ?? []).length;
  if (dollars % 2 !== 0) return { ok: false, reason: "odd $ count" };
  // Math wrap swallowed an English word — the renderer will jam
  // letters together. KaTeX won't throw, so the earlier checks
  // miss it.
  const displayForProse = sanitized.match(/\$\$([\s\S]*?)\$\$/g) ?? [];
  for (const b of displayForProse) {
    const e = b.slice(2, -2);
    if (PROSE_IN_MATH_RE_REPAIR.test(e))
      return { ok: false, reason: "prose inside math wrap" };
  }
  const inlineForProse = sanitized
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .match(/\$([^$\n]+)\$/g) ?? [];
  for (const b of inlineForProse) {
    const e = b.slice(1, -1);
    if (PROSE_IN_MATH_RE_REPAIR.test(e))
      return { ok: false, reason: "prose inside math wrap" };
  }
  const display = sanitized.match(/\$\$([\s\S]*?)\$\$/g) ?? [];
  for (const b of display) {
    const e = b.slice(2, -2);
    if (!e.trim()) continue;
    try {
      katex.renderToString(e, { throwOnError: true, displayMode: true });
    } catch {
      return { ok: false, reason: "KaTeX display fail" };
    }
  }
  const inline = sanitized
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .match(/\$([^$\n]+)\$/g) ?? [];
  for (const b of inline) {
    const e = b.slice(1, -1);
    if (!e.trim()) continue;
    try {
      katex.renderToString(e, { throwOnError: true, displayMode: false });
    } catch {
      return { ok: false, reason: "KaTeX inline fail" };
    }
  }
  return { ok: true };
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

export interface RepairResult {
  ok: boolean;
  message: string;
}

/**
 * Re-extract one question's text / choices / explanation via Claude
 * because the stored content fails KaTeX. Escalates Haiku → Sonnet
 * → Opus until either the output passes the local math-render
 * check or we exhaust the ladder.
 */
export async function repairMathForQuestion(
  questionId: string,
): Promise<RepairResult> {
  const db = getServiceClient();
  const { data: row, error: rowErr } = await db
    .from("questions")
    .select(
      "id, module_id, original_question_number, source_pdf_url, question_type, question_text, choices, explanation, page_number",
    )
    .eq("id", questionId)
    .maybeSingle();
  if (rowErr) return { ok: false, message: rowErr.message };
  if (!row) return { ok: false, message: "Question not found" };
  if (!row.source_pdf_url)
    return { ok: false, message: "No source PDF on this question" };

  const pdfBase64 = await fetchPdfBase64(row.source_pdf_url as string);
  const ladder = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-7",
  ] as const;
  let lastReason = "";
  for (let attempt = 0; attempt < ladder.length; attempt++) {
    const result = await generateObject({
      model: anthropic(ladder[attempt]),
      schema: RepairMathSchema,
      system: REPAIR_MATH_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: pdfBase64, mediaType: "application/pdf" },
            {
              type: "text",
              text: `Re-extract question ${row.original_question_number ?? "?"} (page ${row.page_number ?? "?"}).\n\nCurrent stored text (broken — use only as context):\n\nquestion_text: ${row.question_text}\n\nchoices: ${JSON.stringify(row.choices)}\n\nexplanation: ${row.explanation}\n\nReturn cleaned fields.${
                attempt > 0
                  ? `\n\nPrior attempt failed (${lastReason}). Be stricter.`
                  : ""
              }`,
            },
          ],
        },
      ],
    });
    const q = result.object;
    const checks: Array<{ field: string; text: string }> = [
      { field: "question_text", text: q.question_text },
    ];
    if (q.explanation) checks.push({ field: "explanation", text: q.explanation });
    for (const c of q.choices ?? []) {
      checks.push({ field: `choice ${c.label}`, text: c.text });
    }
    let failed: string | null = null;
    for (const f of checks) {
      const r = isMathClean(f.text);
      if (!r.ok) {
        failed = `${f.field}: ${r.reason}`;
        break;
      }
    }
    if (failed) {
      lastReason = failed;
      continue;
    }
    const update: Record<string, unknown> = {
      question_text: q.question_text,
      parsing_status: "Draft",
      parsing_notes:
        "Re-extracted by admin self-repair (math). Re-review before approve.",
      updated_at: new Date().toISOString(),
    };
    if (q.explanation) update.explanation = q.explanation;
    if (q.choices && q.choices.length > 0) update.choices = q.choices;
    const { error: upErr } = await db
      .from("questions")
      .update(update)
      .eq("id", row.id);
    if (upErr) return { ok: false, message: upErr.message };
    return {
      ok: true,
      message: `Math repaired (${ladder[attempt]}). Status moved to Draft — re-review before approve.`,
    };
  }
  return {
    ok: false,
    message: `Tried Haiku, Sonnet, and Opus — none produced clean math (${lastReason}). Edit the question by hand.`,
  };
}

const BBoxSchema = z.object({
  what_is_above_y0: z.string(),
  what_is_below_y1: z.string(),
  regions: z.array(
    z.object({
      page: z.number(),
      x0: z.number(),
      y0: z.number(),
      x1: z.number(),
      y1: z.number(),
      alt: z.string().optional().default(""),
    }),
  ),
});

const BBOX_SYSTEM = `Return a bounding box around the figure that belongs to ONE specific SAT question on the given PDF page. Coordinates are FRACTIONS of the page dimensions: (0,0) = top-left, (1,1) = bottom-right.

ADMIN INVOKED THIS BUTTON because they SAW a figure they want extracted. Bias hard toward FINDING the figure. Return an empty regions array ONLY when no figure exists on the page anywhere — never just because the question "can be solved" from the text alone. A "Note: Figure not drawn to scale" caption MEANS THERE IS A FIGURE — find it and return its bbox.

Before writing coordinates, answer what_is_above_y0 (should be a Question-N banner or earlier-question answer choice — never the chart title itself) and what_is_below_y1 (should be prose / answer choices — never the legend, x-axis labels, or last table row).

For TABLES include caption + header + every body row + source line.
For GRAPHS include title, both axis labels, every plotted series, legend.
For GEOMETRIC FIGURES include angle markings, side-length annotations, point labels (S, R, Q, P, etc.), and any "Note: Figure not drawn to scale" caption.
For MULTIPLE-CHOICE questions whose A/B/C/D choices are themselves figures (small graphs / diagrams as the options), return ONE region that wraps all four choice diagrams together so the student sees the labeled set.

Do NOT extend the box into prose describing the figure ("The following 3 lines are shown:") or into other questions' answer choices or banners.`;

/**
 * Re-crop and re-upload the figure for one question whose
 * has_image=true but image_urls is empty. Mirrors
 * scripts/repair-blind-image-regions.ts for a single question.
 */
export async function repairImageForQuestion(
  questionId: string,
): Promise<RepairResult> {
  const db = getServiceClient();
  const { data: row, error: rowErr } = await db
    .from("questions")
    .select(
      "id, module_id, original_question_number, source_pdf_url, question_text, page_number, has_image, image_urls",
    )
    .eq("id", questionId)
    .maybeSingle();
  if (rowErr) return { ok: false, message: rowErr.message };
  if (!row) return { ok: false, message: "Question not found" };
  if (!row.source_pdf_url)
    return { ok: false, message: "No source PDF on this question" };

  const pdfBase64 = await fetchPdfBase64(row.source_pdf_url as string);
  const result = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: BBoxSchema,
    system: BBOX_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: pdfBase64, mediaType: "application/pdf" },
          {
            type: "text",
            text: `Question ${row.original_question_number ?? "?"} sits on page ${row.page_number ?? "?"}.\n\nStored question text:\n\n${row.question_text ?? ""}\n\nReturn the bounding box(es) for the figure tied to this question.`,
          },
        ],
      },
    ],
  });
  const regions = result.object.regions;
  if (regions.length === 0) {
    // Admin explicitly clicked "Re-extract figure" — they think a
    // figure exists. Don't silently flip has_image=false the way
    // the batch resolveBlindImages step does; instead surface the
    // problem so the admin can decide. They keep has_image=true
    // and the row stays in its current status; the message tells
    // them what happened.
    return {
      ok: false,
      message:
        "Claude looked at the page but couldn't pinpoint a figure for this question. If you can clearly see one on the PDF, try Re-extract again or crop a screenshot by hand. Use 'Mark as no figure needed' on the audit banner if there really isn't one.",
    };
  }

  const PAD_TOP = 0.015;
  const PAD_LEFT = 0.015;
  const PAD_RIGHT = 0.015;
  const PAD_BOTTOM = 0;
  const synthetic = [
    {
      original_question_number: row.original_question_number ?? 0,
      page_number: row.page_number ?? regions[0].page,
      image_regions: regions.map((r) => {
        const x0 = Math.max(0, Math.min(1, r.x0 - PAD_LEFT));
        const y0 = Math.max(0, Math.min(1, r.y0 - PAD_TOP));
        const x1 = Math.max(0, Math.min(1, r.x1 + PAD_RIGHT));
        const y1 = Math.max(0, Math.min(1, r.y1 + PAD_BOTTOM));
        return {
          page: r.page,
          x_pct: x0,
          y_pct: y0,
          w_pct: Math.max(0, x1 - x0),
          h_pct: Math.max(0, y1 - y0),
          alt: r.alt ?? "",
        };
      }),
    },
  ] as unknown as Parameters<typeof extractAndUploadQuestionImages>[1];
  const res = await extractAndUploadQuestionImages(
    pdfBase64,
    synthetic,
    row.module_id as string,
  );
  const slot = res.byQuestion.get(row.original_question_number ?? 0);
  const urls = slot?.urls ?? [];
  const alts = slot?.alts ?? [];
  if (urls.length === 0) {
    return {
      ok: false,
      message: `Cropper produced 0 URLs (${res.errors[0] ?? "unknown"})`,
    };
  }
  await db
    .from("questions")
    .update({
      image_urls: urls,
      image_alts: alts,
      parsing_notes: `Image re-extracted by admin self-repair (${urls.length} region${urls.length === 1 ? "" : "s"}).`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  return {
    ok: true,
    message: `Figure re-cropped (${urls.length} region${urls.length === 1 ? "" : "s"}).`,
  };
}

/**
 * Mark the row as "no figure" so the blind-image audit stops
 * firing AND any previously-extracted image_urls are cleared.
 * Use when the reviewer has verified the question really doesn't
 * need a figure.
 */
export async function clearImageFlag(
  questionId: string,
): Promise<RepairResult> {
  const db = getServiceClient();
  const { error } = await db
    .from("questions")
    .update({
      has_image: false,
      image_urls: [],
      image_alts: [],
      parsing_notes:
        "Admin self-repair cleared has_image flag (no figure needed).",
      updated_at: new Date().toISOString(),
    })
    .eq("id", questionId);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Image flag cleared." };
}

/**
 * Mark the row as "no table" so the has-table-flag-but-no-table audit
 * stops firing. Use when the reviewer has verified the question
 * really doesn't need a table.
 */
export async function clearTableFlag(
  questionId: string,
): Promise<RepairResult> {
  const db = getServiceClient();
  const { error } = await db
    .from("questions")
    .update({
      has_table: false,
      parsing_notes:
        "Admin self-repair cleared has_table flag (no table needed).",
      updated_at: new Date().toISOString(),
    })
    .eq("id", questionId);
  if (error) return { ok: false, message: error.message };
  return {
    ok: true,
    message: "Table flag cleared.",
  };
}
