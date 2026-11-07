// lib/figure-hires.ts
//
// Re-read a question's figure at high resolution straight from its source
// PDF, not from the stored 200-DPI crop ([Test #13] L Test 1 Math M2 Q9: the
// curve 2√x − 3 through (0,−3), (1,−1), (4,1), (9,3) was misread three
// different ways from the crop). The page is located in the PDF, the figure's
// box is found by Claude on that one page, and the box is cropped from a
// 400-DPI render, so the model sees grid lines at full detail (Claude scales
// images down past ~1568 px, so a whole-page render would not help).
//
// Best effort: returns [] when the question has no page / PDF, or anything fails.

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { getServiceClient } from "@/lib/supabase";
import { renderPdfPages } from "@/lib/ai/extract-images";
import { logUsage } from "@/lib/ai/parse-pdf";
import { parseBlobUrl } from "@/lib/blob-url";
import { figureExclusionZones, readPrintoutLayout, type PrintoutLayout } from "@/lib/printout-layout";

/**
 * The page that carries this question's own number bar (Premier printouts;
 * same matching as lib/choice-crop-check figureMayContinue). The stored
 * page_number can point at the previous question's page; `stored` breaks a
 * tie. null = no number bar found (another PDF layout): use `stored`.
 */
export function pageOfQuestion(layout: Pick<PrintoutLayout, "elements" | "pages" | "boxes">, stored: number, questionNumber: number): number | null {
  const zones = figureExclusionZones(layout as PrintoutLayout).filter((z) => z.kind === "bar");
  const mine = zones.filter((b) =>
    layout.elements.some(
      (e) => e.kind === "text" && e.page === b.page && e.plain === String(questionNumber) && (e.x0 + e.x1) / 2 > b.x0 && (e.x0 + e.x1) / 2 < b.x1 && (e.y0 + e.y1) / 2 > b.y0 && (e.y0 + e.y1) / 2 < b.y1,
    ),
  );
  return (mine.find((b) => b.page === stored) ?? mine[0])?.page ?? null;
}

const HIRES_DPI = 400;
const MAX_EDGE = 1568;

const BoxSchema = z.object({
  regions: z
    .array(z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }))
    .describe("Bounding boxes (fractions 0–1 of the page width/height) of the question's figure(s): graph, diagram or table image. Empty if none."),
});

async function fetchPdf(raw: string): Promise<Buffer> {
  // The blob token goes only to a real Vercel Blob host (lib/blob-url.ts).
  const url = parseBlobUrl(raw);
  if (!url) throw new Error("PDF is not on Vercel Blob");
  const headers: Record<string, string> = {};
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface HiresImage {
  image: string;
  mediaType: string;
}

/** High-resolution crops of the question's figure from its source PDF ([] = unavailable). */
export async function highResFigure(questionId: string, callerUserId?: string): Promise<HiresImage[]> {
  try {
    const db = getServiceClient();
    const { data: q } = await db
      .from("questions")
      .select("id, module_id, page_number, original_question_number, question_text, source_pdf_url")
      .eq("id", questionId)
      .maybeSingle();
    if (!q?.page_number) return [];
    let url = (q.source_pdf_url as string | null) ?? null;
    if (!url && q.module_id) {
      const { data: m } = await db.from("modules").select("pdf_url").eq("id", q.module_id).maybeSingle();
      url = (m?.pdf_url as string | null) ?? null;
    }
    if (!url) return [];
    const bytes = await fetchPdf(url);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    // Confirm the page by the question's own number bar.
    let page = q.page_number as number;
    try {
      const own = pageOfQuestion(await readPrintoutLayout(bytes.toString("base64")), page, (q.original_question_number as number | null) ?? -1);
      if (own) page = own;
    } catch {
      // No layout (scanned PDF): keep the stored page.
    }
    if (page < 1 || page > src.getPageCount()) return [];
    const one = await PDFDocument.create();
    const [copied] = await one.copyPages(src, [page - 1]);
    one.addPage(copied);
    const pageB64 = Buffer.from(await one.save()).toString("base64");

    const res = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: BoxSchema,
      system: "You locate figures on an SAT test page. Return a tight bounding box (fractions of the page) around the graph / diagram / figure that belongs to the given question, including its axis labels and tick numbers, excluding the question text and other questions.",
      maxRetries: 2,
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: pageB64, mediaType: "application/pdf" },
            { type: "text", text: `Question ${q.original_question_number ?? "?"}:\n${String(q.question_text ?? "").slice(0, 800)}\n\nReturn the figure's bounding box.` },
          ],
        },
      ],
    });
    const u = res.usage;
    if (u) {
      const inTok = u.inputTokens ?? 0, outTok = u.outputTokens ?? 0;
      await logUsage({ userId: callerUserId, route: "figure-hires", tokensInput: inTok, tokensOutput: outTok, model: "claude-sonnet-4-6", costCents: Math.round((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500), metadata: { question_id: questionId } });
    }
    const regions = res.object.regions.filter((r) => r.x1 > r.x0 && r.y1 > r.y0).slice(0, 3);
    if (regions.length === 0) return [];
    const rendered = (await renderPdfPages(pageB64, new Set([1]), HIRES_DPI / 72)).get(1);
    if (!rendered) return [];
    const out: HiresImage[] = [];
    for (const r of regions) {
      const pad = 0.02;
      const left = Math.max(0, Math.floor((Math.max(0, r.x0) - pad) * rendered.widthPx));
      const top = Math.max(0, Math.floor((Math.max(0, r.y0) - pad) * rendered.heightPx));
      const right = Math.min(rendered.widthPx, Math.ceil((Math.min(1, r.x1) + pad) * rendered.widthPx));
      const bottom = Math.min(rendered.heightPx, Math.ceil((Math.min(1, r.y1) + pad) * rendered.heightPx));
      if (right - left < 20 || bottom - top < 20) continue;
      const png = await sharp(rendered.png)
        .extract({ left, top, width: right - left, height: bottom - top })
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      out.push({ image: png.toString("base64"), mediaType: "image/png" });
    }
    return out;
  } catch (e) {
    console.warn(`[figure-hires] ${questionId}:`, e instanceof Error ? e.message : e);
    return [];
  }
}
