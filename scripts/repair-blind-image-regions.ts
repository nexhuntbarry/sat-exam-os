// scripts/repair-blind-image-regions.ts
//
// Re-extract figures for questions where the parser flagged
// has_image=true but emitted no image_urls. The parser is supposed
// to populate `image_regions` on every visual question; when it
// forgets, the cropper has nothing to crop and the student sees
// "Refer to the graph below" with a blank panel.
//
// For each stuck row we:
//   1. fetch the source PDF,
//   2. ask Claude Haiku vision for a tight bounding box around the
//      figure that belongs to the question on its page,
//   3. feed a synthetic ParsedQuestion[] with that region into the
//      existing extractAndUploadQuestionImages pipeline (renders +
//      crops + uploads to Vercel Blob exactly like a fresh parse),
//   4. write the returned image_urls back onto the row + clear the
//      "Needs manual image re-extraction" parsing note.
//
// Usage:
//   npx tsx scripts/repair-blind-image-regions.ts                      # dry-run, all modules
//   npx tsx scripts/repair-blind-image-regions.ts --apply
//   npx tsx scripts/repair-blind-image-regions.ts --apply --module=<uuid>
//   npx tsx scripts/repair-blind-image-regions.ts --apply --question=<uuid>

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { extractAndUploadQuestionImages } from "../lib/ai/extract-images";

function loadEnv(file: string, overwrite: boolean) {
  try {
    const body = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of body.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (overwrite || !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}
loadEnv(".env.local", true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey || !process.env.ANTHROPIC_API_KEY) {
  console.error("Missing env.");
  process.exit(1);
}

const sb = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

const apply = process.argv.includes("--apply");
const moduleArg = process.argv.find((a) => a.startsWith("--module="));
const questionArg = process.argv.find((a) => a.startsWith("--question="));

const BBOX_SYSTEM = `You are returning a bounding box around the figure (graph, chart, diagram, table-as-image, geometric drawing, scatterplot, or other visual) that belongs to ONE specific SAT question on the given PDF page.

Coordinates are FRACTIONS of the page dimensions: (0,0) = top-left, (1,1) = bottom-right.

PROCESS — follow this every time:
  Step 1: scan the page and identify the visual that belongs to the target question. Mentally trace its OWN frame (the chart's axes + plot area + legend block; the table's caption + header + body rows + source line; the geometric figure's drawing region).
  Step 2: BEFORE writing coordinates, answer the self-check fields what_is_above_y0 and what_is_below_y1. If your y0 sits in the middle of the visual, or your y1 sits in the middle of a paragraph BELOW the visual, your numbers are wrong — fix them, then re-answer.
  Step 3: write the coordinates.

VERTICAL BOUNDARIES — the most common failure mode:

  TOP boundary (y0): Place y0 directly at the visual's own top edge — the chart's title bar, the table's short caption (e.g. "Studies of Cougar Population Density"), or the geometric figure's drawing area. DO NOT include:
    • Any other question's answer choices sitting above the figure ("60 for Class VII", "50 for Class VI", labelled A/B/C/D rows).
    • The "Question N" banner / number label that precedes the target question.
    • The previous question's stem text.
    • Page header (test / section / page number).
    If the figure sits in the middle of the page and an earlier question's choices are 1cm above it, y0 must NOT include those.

  BOTTOM boundary (y1): Place y1 at the visual's own bottom edge — the table's last data row (or the source citation immediately under it), the chart's x-axis labels and legend, or the figure's bottom border. DO NOT include:
    • Running prose describing the figure ("The following 3 lines are shown:", "The graph shows…", "The table reports the population densities reported by various researchers…").
    • Bullet lists labelling each plotted series ("• Class VII (very severe limitations on use for crops) line: begins at 1960, 65 meters per hectare…").
    • The "Which choice most effectively…" stem.
    • The target question's own answer choices.
    The figure ends at its own visual frame, NOT at the next block of body text — even when there is zero whitespace gap.

PER-SHAPE GUIDANCE:
  TABLES: include the short caption / title row + header row + every body row + any totals + footnote citation. Count the rows in the PDF — y1 must sit BELOW the last row, never in the middle.
  GRAPHS / CHARTS: include title, both axis labels, every plotted series, legend block, and inline annotations. Err on the side of a slightly larger box around the plot area itself.
  GEOMETRIC FIGURES: include labels, angle markings, side-length annotations, and the figure border.

HORIZONTAL BOUNDARIES: x0 and x1 should hug the left and right edges of the visual itself — not the full page width (the column gutter beside a 2-column layout often contains other content).

If there are multiple visuals on the page, return only the one tied to the question number in the user prompt.

If you genuinely cannot find a figure for this question (the parser was wrong, the page is text-only), return an empty regions array.

Return JSON only.`;

const BBoxSchema = z.object({
  // Self-check fields force the model to verbalize what's actually
  // inside the bbox before it commits, which catches the failure
  // mode where Claude returns a box that visually "feels right" but
  // includes prose below the legend. We ignore these fields server-
  // side, but the act of writing them out tightens the bbox itself.
  what_is_above_y0: z
    .string()
    .describe(
      "One short sentence: what page content sits just ABOVE your y0 line? If it's the previous question's answer choices or a 'Question N' banner, your y0 is correct (figure starts below). If it's something part of the figure itself (chart title, table caption), move y0 up.",
    ),
  what_is_below_y1: z
    .string()
    .describe(
      "One short sentence: what page content sits just BELOW your y1 line? If it's prose describing the figure or this question's answer choices, your y1 is correct (figure ends above). If it's something part of the figure (last table row, x-axis label, legend), move y1 down.",
    ),
  regions: z
    .array(
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

async function fetchPdfBase64(url: string): Promise<string> {
  const headers: Record<string, string> = {};
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

interface Row {
  id: string;
  original_question_number: number | null;
  module_id: string;
  question_text: string | null;
  page_number: number | null;
  source_pdf_url: string | null;
  has_image: boolean | null;
  image_urls: string[] | null;
}

async function loadBlindRows(): Promise<Row[]> {
  if (questionArg) {
    const qid = questionArg.split("=")[1];
    const { data } = await sb
      .from("questions")
      .select(
        "id, original_question_number, module_id, question_text, page_number, source_pdf_url, has_image, image_urls",
      )
      .eq("id", qid);
    return (data ?? []) as Row[];
  }
  let q = sb
    .from("questions")
    .select(
      "id, original_question_number, module_id, question_text, page_number, source_pdf_url, has_image, image_urls",
    )
    .eq("has_image", true)
    .or("image_urls.is.null,image_urls.eq.{}");
  if (moduleArg) q = q.eq("module_id", moduleArg.split("=")[1]);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).filter(
    (r) => r.source_pdf_url && (!Array.isArray(r.image_urls) || r.image_urls.length === 0),
  );
}

async function repairOne(row: Row): Promise<boolean> {
  if (!row.source_pdf_url) return false;
  const pdfBase64 = await fetchPdfBase64(row.source_pdf_url);
  const result = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema: BBoxSchema,
    system: BBOX_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: pdfBase64, mediaType: "application/pdf" },
          {
            type: "text",
            text: `Question ${row.original_question_number ?? "?"} sits on page ${row.page_number ?? "?"}.\n\nStored question text:\n\n${row.question_text ?? ""}\n\nReturn the bounding box(es) for the figure that belongs to this question.`,
          },
        ],
      },
    ],
  });
  const regions = result.object.regions;
  if (regions.length === 0) {
    console.log(`  Q${row.original_question_number}: Claude found no figure — leaving alone`);
    return false;
  }
  if (!apply) {
    console.log(
      `  Q${row.original_question_number}: would crop ${regions.length} region(s)`,
    );
    return true;
  }
  // Synthesize a single-question ParsedQuestion shim that the existing
  // extractor accepts; we only need original_question_number + page_number
  // + image_regions for it to do the right thing.
  // Convert (x0,y0,x1,y1) corners into the (x_pct,y_pct,w_pct,h_pct)
  // shape the existing ParsedImageRegion / cropper expects.
  //
  // Asymmetric padding policy after observing two real-world failures:
  //  - Q9 Sep 2025 ENG M2 table — bbox shaved off the bottom rows
  //    because Claude returned a flush-tight box and antialias /
  //    rounding cut a row of pixels.
  //  - Q8 Sep 2025 ENG M2 chart — adding 2.5% to every side bled the
  //    bbox DOWN into question-stem prose right under the chart.
  //
  // Compromise: 1.5% margin on TOP / LEFT / RIGHT (where over-crop
  // is rare and slight under-crop is the typical failure) and 0% on
  // BOTTOM so we never extend into the stem text immediately below
  // the figure. The new prompt is also stricter about excluding any
  // running prose that describes the figure.
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
    row.module_id,
  );
  const slot = res.byQuestion.get(row.original_question_number ?? 0);
  const urls = slot?.urls ?? [];
  const alts = slot?.alts ?? [];
  if (urls.length === 0) {
    console.log(
      `  Q${row.original_question_number}: extractor produced 0 URLs (errors: ${res.errors.join(" | ") || "none"})`,
    );
    return false;
  }
  const { error: upErr } = await sb
    .from("questions")
    .update({
      image_urls: urls,
      image_alts: alts,
      // Drop the "needs manual image re-extraction" note we put on
      // during resolveBlindImages so the admin doesn't keep seeing it.
      parsing_notes: `Image re-extracted by repair-blind-image-regions (${urls.length} region${urls.length === 1 ? "" : "s"}).`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (upErr) {
    console.log(`  Q${row.original_question_number}: DB write failed — ${upErr.message}`);
    return false;
  }
  console.log(`  Q${row.original_question_number}: repaired (${urls.length} url)`);
  return true;
}

async function main() {
  const rows = await loadBlindRows();
  if (rows.length === 0) {
    console.log("No blind-image rows match.");
    return;
  }
  if (!apply) console.log("DRY-RUN: pass --apply to actually mutate.");
  console.log(`Targeting ${rows.length} row(s).`);
  // Group by module for nicer logs.
  const byMod = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byMod.has(r.module_id)) byMod.set(r.module_id, []);
    byMod.get(r.module_id)!.push(r);
  }
  let totalRepaired = 0;
  for (const [moduleId, group] of byMod) {
    console.log(`\nModule ${moduleId} (${group.length} blind row(s)):`);
    for (const r of group) {
      try {
        const ok = await repairOne(r);
        if (ok) totalRepaired++;
      } catch (e) {
        console.log(
          `  Q${r.original_question_number}: ERROR — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  console.log(`\nDone. Repaired ${totalRepaired} / ${rows.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
