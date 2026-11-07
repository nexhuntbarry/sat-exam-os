// lib/figure-compare.ts
//
// Figure / table / choices check (owner-approved, 2026-11-07). Questions
// whose notes ask someone to compare the stored figure, table or choices with
// the PDF ("still needs review (figure/choices)", "Image re-extracted…",
// "choices re-extracted from PDF", "Markdown table AND an image", …) are
// compared with the source PDF automatically:
//   - choices and tables: an AI re-read of the question's PDF page
//     (reextractQuestionFromPdf), cross-checked with the PDF text layer; a
//     difference counts only when a second read sees it too;
//   - figures: a fresh crop of the PDF page (cropFigureFromPdf) compared with
//     the stored image by Claude vision. A stored image that only repeats a
//     table already in the text is a duplicate (the note says to remove it).
// Match → the figure notes are cleared and the row is approved when nothing
// else blocks (approvalBlockers, the "only reason" logic). Differs → a note
// links the PDF version (JSON on Blob) for a side-by-side review with "Use
// PDF version" / "Keep". Live-test rows keep their status ([live-fix] note).
//
// Used by scripts/compare-figures.ts and the review-queue decide route.

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { put } from "@vercel/blob";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTO_FIX_NOTE_PREFIX, AUTO_FIX_SELECT, type AutoFixRow } from "@/lib/explanation-autofix";
import {
  cropFigureFromPdf,
  reextractQuestionFromPdf,
  type FigureCropResult,
  type FigureCropRow,
  type ReextractProposal,
} from "@/lib/repair-ops";
import { diffAgainstPdf, dropTextLayerConfirmed, type PdfDiff } from "@/lib/pdf-replace";
import { choiceTextsAgree, type PdfTextChoices } from "@/lib/pdf-text-choices";
import { choiceImageUrls } from "@/lib/parse-guards";
import { hasMarkdownTable } from "@/lib/markdown-table";
import { fetchImageAsBase64 } from "@/lib/ai/solve-question";
import { parseBlobUrl } from "@/lib/blob-url";
import { LIVE_FIX_TAG } from "@/lib/live-questions";
import {
  approvalBlockers,
  dropFigureNotes,
  figureDiffNote,
  figureMatchNote,
  isFigureNote,
  noteSegments,
  removeNotes,
} from "@/lib/review-queue";

export const FIGURE_COMPARE_SELECT = `${AUTO_FIX_SELECT}, page_number, source_pdf_url, image_alts`;

export interface FigureRow extends AutoFixRow {
  page_number: number | null;
  source_pdf_url: string | null;
  image_alts?: string[] | null;
}

type Choice = { label: "A" | "B" | "C" | "D"; text: string; image_url?: string | null };

/** A Needs Review row whose notes ask for a figure / table / choices check. */
export function isFigureTarget(r: Pick<AutoFixRow, "parsing_status" | "parsing_notes">): boolean {
  return r.parsing_status === "Needs Review" && noteSegments(r.parsing_notes).some(isFigureNote);
}

// ── Tables ───────────────────────────────────────────────────────────

/** Rows of cells of every Markdown table in the text (separator rows dropped). */
export function markdownTableCells(text: string | null | undefined): string[][] {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\|.*\|$/.test(l) && !/^\|[\s:|-]+\|$/.test(l))
    .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
}

/** Cell text compared on content: math delimiters, spacing, case and minus signs ignored. */
export function normalizeCell(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[−–—]/g, "-")
    .replace(/\\(?:text|mathrm|textbf|mathbf|left|right|,|;|!)/g, "")
    .replace(/[$\\{}*_\s]/g, "")
    .toLowerCase();
}

/** Differences between two tables ([] = same cells). */
export function diffTables(stored: string | null | undefined, pdf: string | null | undefined): string[] {
  const a = markdownTableCells(stored);
  const b = markdownTableCells(pdf);
  if (a.length === 0) return [];
  if (b.length === 0) return ["the PDF read has no table"];
  if (a.length !== b.length) return [`table has ${a.length} rows, the PDF ${b.length}`];
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) {
      out.push(`table row ${i + 1} has ${a[i].length} cells, the PDF ${b[i].length}`);
      continue;
    }
    for (let j = 0; j < a[i].length; j++) {
      if (normalizeCell(a[i][j]) !== normalizeCell(b[i][j])) out.push(`table row ${i + 1} cell ${j + 1}: "${a[i][j]}" vs PDF "${b[i][j]}"`);
    }
  }
  return out;
}

/** The Markdown table block(s) in a text, as written. */
export function tableBlock(text: string | null | undefined): string {
  return (text ?? "")
    .split("\n")
    .filter((l) => /^\s*\|.*\|\s*$/.test(l))
    .join("\n");
}

/** `text` with its (first) Markdown table block replaced by `table`. */
export function replaceTableBlock(text: string, table: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => /^\s*\|.*\|\s*$/.test(l));
  if (first < 0) return text;
  let last = first;
  while (last + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[last + 1])) last++;
  return [...lines.slice(0, first), ...table.split("\n"), ...lines.slice(last + 1)].join("\n");
}

// ── Choices ──────────────────────────────────────────────────────────

/** Punctuation-preserving form: "Ortelius," and "Ortelius;" differ (punctuation questions). */
export function strictChoice(s: string): string {
  return (s || "")
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/<\/?u>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const hasMath = (s: string) => /\$|\\/.test(s);

/** Choice differences between the stored row and a PDF read. */
export function choiceDiffs(row: FigureRow, p: ReextractProposal): PdfDiff[] {
  const out = diffAgainstPdf(
    { ...row, question_type: row.question_type, parsing_status: row.parsing_status, parsing_notes: row.parsing_notes },
    p,
  ).filter((d) => d.key.startsWith("choice ") || d.key === "type");
  const stored = Array.isArray(row.choices) ? (row.choices as Choice[]) : [];
  for (const c of p.choices) {
    if (out.some((d) => d.key === `choice ${c.label}`)) continue;
    const s = stored.find((x) => x?.label === c.label)?.text ?? "";
    if (hasMath(s) || hasMath(c.text)) continue;
    if (choiceTextsAgree(s, c.text) && strictChoice(s) !== strictChoice(c.text)) {
      out.push({ key: `choice ${c.label}`, text: `choice ${c.label}: saved "${s}" vs PDF "${c.text}" (punctuation)` });
    }
  }
  return out;
}

// ── Figures (vision) ─────────────────────────────────────────────────

const SameFigureSchema = z.object({
  stored_is_figure: z.boolean(),
  same_figure: z.boolean(),
  stored_complete: z.boolean(),
  stored_has_extra_content: z.boolean(),
  reason: z.string(),
});

const DuplicateTableSchema = z.object({
  only_this_table: z.boolean(),
  reason: z.string(),
});

export type VisionVerdict = { same: boolean; reason: string; notFigure?: boolean };

async function imageBlocks(urls: string[]): Promise<{ type: "image"; image: string; mediaType: string }[]> {
  const out: { type: "image"; image: string; mediaType: string }[] = [];
  for (const u of urls.slice(0, 3)) {
    const f = await fetchImageAsBase64(u);
    if (f) out.push({ type: "image", image: f.base64, mediaType: f.mediaType });
  }
  return out;
}

/** Does the stored figure show the same, complete figure as the fresh PDF crop? */
export async function sameFigure(storedUrls: string[], pdfUrls: string[], questionNumber: number | null): Promise<VisionVerdict> {
  const stored = await imageBlocks(storedUrls);
  const pdf = await imageBlocks(pdfUrls);
  if (stored.length === 0 || pdf.length === 0) return { same: false, reason: "couldn't load the images" };
  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema: SameFigureSchema,
    system:
      "You compare two crops of the same SAT question's figure. Ignore crop margins, scale, resolution and colour depth. Judge only the content a student needs.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `STORED figure(s) for question ${questionNumber ?? "?"}:` },
          ...stored,
          { type: "text", text: "FRESH crop(s) of the same question's figure from the source PDF:" },
          ...pdf,
          {
            type: "text",
            text: "stored_is_figure: does the stored image show a real figure (graph, chart, table, diagram, map, picture), not just lines of passage or question text? same_figure: do the stored and fresh images show the same figure with the same data, labels, values, axes and shapes? stored_complete: does the stored image show the whole figure (no axis, label, table row, legend or part cut off)? stored_has_extra_content: does the stored image include anything that is not part of the figure (another question's text or answer choices, a ✓ answer mark, the question-number banner, a page header or footer)? reason: one sentence.",
          },
        ],
      },
    ],
  });
  if (!object.stored_is_figure) return { same: false, notFigure: true, reason: `the stored image shows only text, not a figure (${object.reason})` };
  return {
    same: object.same_figure && object.stored_complete && !object.stored_has_extra_content,
    reason: object.reason,
  };
}

/** Is the stored image only a screenshot of the Markdown table already in the text? */
export async function imageOnlyRepeatsTable(storedUrls: string[], table: string): Promise<VisionVerdict> {
  const stored = await imageBlocks(storedUrls);
  if (stored.length === 0) return { same: false, reason: "couldn't load the image" };
  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema: DuplicateTableSchema,
    system: "You check whether an image attached to an SAT question only repeats a table that is already in the question text.",
    messages: [
      {
        role: "user",
        content: [
          ...stored,
          {
            type: "text",
            text: `The question text already contains this table:\n\n${table}\n\nonly_this_table: true when the image shows ONLY this same table (same rows, columns and values; a title or caption is fine) and no chart, graph, diagram or other content. false when it shows anything else, or different values. reason: one sentence.`,
          },
        ],
      },
    ],
  });
  return { same: object.only_this_table, reason: object.reason };
}

// ── Compare ──────────────────────────────────────────────────────────

export type ComparePart = "choices" | "table" | "figure";

export interface FigureProposal {
  version: 1;
  questionId: string;
  checkedAt: string;
  pages: string;
  /** Parts that differ. */
  parts: ComparePart[];
  diffs: string[];
  stored: { choices?: Choice[]; table?: string; imageUrls?: string[] };
  pdf: { choices?: Choice[]; table?: string; imageUrls?: string[]; imageAlts?: string[] };
}

export type FigureCompareResult =
  | { outcome: "match"; checked: string[]; removeDuplicateImage: boolean; detail: string[] }
  | { outcome: "differs"; checked: string[]; proposal: FigureProposal; detail: string[] }
  | { outcome: "unverifiable"; checked: string[]; detail: string[] };

export interface CompareDeps {
  read?: (id: string, pdfBase64: string) => Promise<{ ok: true; proposal: ReextractProposal } | { ok: false; message: string }>;
  crop?: (row: FigureCropRow, pdfBase64: string) => Promise<FigureCropResult>;
  same?: typeof sameFigure;
  repeatsTable?: typeof imageOnlyRepeatsTable;
}

/** Compare one row's stored figure / table / choices with its source PDF (no writes). */
export async function compareFigureWithPdf(
  row: FigureRow,
  pdfBase64: string,
  pdfText: PdfTextChoices | null,
  deps: CompareDeps = {},
): Promise<FigureCompareResult> {
  const read = deps.read ?? ((id: string, b64: string) => reextractQuestionFromPdf(id, { pdfBase64: b64 }));
  const crop = deps.crop ?? cropFigureFromPdf;
  const same = deps.same ?? sameFigure;
  const repeatsTable = deps.repeatsTable ?? imageOnlyRepeatsTable;

  const checked: string[] = [];
  const detail: string[] = [];
  const unverifiable: string[] = [];
  const diffs: { part: ComparePart; key: string; text: string }[] = [];
  const storedChoices = Array.isArray(row.choices) ? (row.choices as Choice[]) : [];
  const graphChoices = choiceImageUrls(row.choices).length > 0;
  const textChoices = row.question_type !== "Student Produced Response" && storedChoices.length > 0 && !graphChoices;
  const storedTable = hasMarkdownTable(row.question_text);
  const storedImages = Array.isArray(row.image_urls) ? (row.image_urls as string[]) : [];
  let pdfRead: ReextractProposal | null = null;

  // Choices and table: two independent reads must agree on a difference.
  if (textChoices || storedTable) {
    const first = await read(row.id, pdfBase64);
    if (!first.ok) {
      unverifiable.push(`couldn't read the PDF: ${first.message}`);
    } else {
      pdfRead = first.proposal;
      const found = (p: ReextractProposal) => [
        ...(textChoices ? dropTextLayerConfirmed(row, choiceDiffs(row, p), pdfText).map((d) => ({ part: "choices" as const, ...d })) : []),
        // A read that returns no table at all says nothing about the stored one.
        ...(storedTable && markdownTableCells(p.question_text).length > 0
          ? diffTables(row.question_text, p.question_text).map((t) => ({ part: "table" as const, key: t.replace(/:.*$/, ""), text: t }))
          : []),
      ];
      let d = found(first.proposal);
      if (d.length > 0) {
        const second = await read(row.id, pdfBase64);
        const again = second.ok ? new Set(found(second.proposal).map((x) => `${x.part}|${x.key}`)) : new Set<string>();
        d = d.filter((x) => again.has(`${x.part}|${x.key}`));
      }
      if (textChoices) checked.push("choices");
      if (storedTable && markdownTableCells(first.proposal.question_text).length > 0) checked.push("table");
      else if (storedTable) unverifiable.push("the PDF read has no table to compare with");
      diffs.push(...d);
    }
  }
  if (graphChoices) unverifiable.push("the answer choices are graphs (compare them by eye)");

  // Figure.
  let removeDuplicateImage = false;
  let pdfImages: { urls: string[]; alts: string[] } | null = null;
  if (storedImages.length > 0) {
    if (storedTable) {
      const dup = await repeatsTable(storedImages, tableBlock(row.question_text));
      if (dup.same) {
        removeDuplicateImage = true;
        checked.push("duplicate table image");
        detail.push(`image only repeats the table: ${dup.reason}`);
      }
    }
    if (!removeDuplicateImage) {
      const c = await crop({ ...row, module_id: row.module_id ?? null, section: row.section ?? null }, pdfBase64);
      if (c.kind === "cropped" && c.urls.length > 0) {
        const v = await same(storedImages, c.urls, row.original_question_number);
        if (v.notFigure) {
          // Nothing to compare: a person decides whether the image belongs at all.
          unverifiable.push(v.reason);
        } else if (v.same) {
          checked.push("figure");
          detail.push(`figure: ${v.reason}`);
        } else {
          checked.push("figure");
          pdfImages = { urls: c.urls, alts: c.alts };
          diffs.push({ part: "figure", key: "figure", text: `figure: ${v.reason}` });
        }
      } else {
        unverifiable.push(
          c.kind === "error" ? `figure: ${c.message}` : c.kind === "none" ? "no figure found on the PDF page" : "the PDF crop is only an equation",
        );
      }
    }
  }

  if (diffs.length > 0) {
    const parts = [...new Set(diffs.map((d) => d.part))];
    const proposal: FigureProposal = {
      version: 1,
      questionId: row.id,
      checkedAt: new Date().toISOString(),
      pages: pdfRead?.pages ?? String(row.page_number ?? "?"),
      parts,
      diffs: diffs.map((d) => d.text),
      stored: {
        ...(parts.includes("choices") ? { choices: storedChoices } : {}),
        ...(parts.includes("table") ? { table: tableBlock(row.question_text) } : {}),
        ...(parts.includes("figure") ? { imageUrls: storedImages } : {}),
      },
      pdf: {
        ...(parts.includes("choices") && pdfRead ? { choices: pdfRead.choices as Choice[] } : {}),
        ...(parts.includes("table") && pdfRead ? { table: tableBlock(pdfRead.question_text) } : {}),
        ...(parts.includes("figure") && pdfImages ? { imageUrls: pdfImages.urls, imageAlts: pdfImages.alts } : {}),
      },
    };
    return { outcome: "differs", checked, proposal, detail: [...detail, ...diffs.map((d) => d.text), ...unverifiable] };
  }
  if (unverifiable.length > 0 || checked.length === 0) {
    return { outcome: "unverifiable", checked, detail: [...detail, ...(unverifiable.length ? unverifiable : ["nothing to compare (no text choices, table or figure)"])] };
  }
  return { outcome: "match", checked, removeDuplicateImage, detail };
}

// ── Decision (pure) ──────────────────────────────────────────────────

/**
 * A semantic-audit note that only says choices are garbled / empty / cut off
 * (and maybe that the explanation is cut off) — nothing about the stem,
 * figure, key or the explanation's reasoning.
 */
export function isStaleChoiceAudit(seg: string): boolean {
  const m = seg.match(/^Semantic audit:\s*([\s\S]*)$/i);
  if (!m) return false;
  const body = m[1].replace(/'[^']*'|"[^"]*"|“[^”]*”|\([^)]*\)/g, "");
  if (!/\bchoices?\b/i.test(body)) return false;
  return !/\bstem\b|question text|passage|figure|image|graph|table|correct[_ ]answer|\bkey\b|contradict|conclud|argues|incorrect|wrong|unanswerable|missing context/i.test(body);
}

export type FigureGroup = "match_approved" | "match_live_held" | "match_still_review" | "differs" | "unverifiable";

export interface FigureDecision {
  group: FigureGroup;
  update: Record<string, unknown> | null;
  blockers: string[];
  removedNotes: string[];
}

/** What to write for one compare result. `proposalUrl` = the uploaded proposal (differs). */
export function decideFigure(
  r: FigureRow,
  res: FigureCompareResult,
  live: boolean,
  proposalUrl: string | null,
  now = new Date(),
): FigureDecision {
  if (res.outcome === "unverifiable") return { group: "unverifiable", update: null, blockers: [], removedNotes: [] };
  const dropped = dropFigureNotes(r.parsing_notes);
  const base = dropped.notes ? `${dropped.notes}; ` : "";
  if (res.outcome === "differs") {
    return {
      group: "differs",
      update: { parsing_notes: `${base}${figureDiffNote(res.proposal.parts, proposalUrl)}`, updated_at: now.toISOString() },
      blockers: res.proposal.diffs,
      removedNotes: dropped.removed,
    };
  }
  // The semantic audit's complaint about garbled / empty choices (plus a cut
  // off explanation) is settled once the choices match the PDF and the
  // explanation has since been rewritten and checked by the auto-fix.
  let kept = dropped.notes;
  if (res.checked.includes("choices") && noteSegments(kept).some((s) => s.startsWith(AUTO_FIX_NOTE_PREFIX))) {
    const stale = removeNotes(kept, isStaleChoiceAudit);
    kept = stale.notes;
    dropped.removed.push(...stale.removed);
  }
  let notes = `${kept ? `${kept}; ` : ""}${figureMatchNote(res.checked, now)}`;
  const update: Record<string, unknown> = { updated_at: now.toISOString() };
  const next: FigureRow = { ...r, parsing_notes: notes };
  if (res.removeDuplicateImage) {
    update.has_image = false;
    update.image_urls = [];
    update.image_alts = [];
    next.has_image = false;
    next.image_urls = [];
  }
  const blockers = approvalBlockers(next);
  let group: FigureGroup = "match_still_review";
  if (blockers.length === 0) {
    if (live) {
      group = "match_live_held";
      if (!notes.startsWith(LIVE_FIX_TAG)) {
        notes = `${LIVE_FIX_TAG} Figure check matched the PDF and nothing else blocks approval while this question is in a live test; kept ${r.parsing_status} — please re-check. ${notes}`;
      }
    } else {
      group = "match_approved";
      update.parsing_status = "Approved";
    }
  }
  update.parsing_notes = notes;
  return { group, update, blockers, removedNotes: dropped.removed };
}

// ── Proposal storage (Vercel Blob) ───────────────────────────────────

/** Upload the PDF version for the side-by-side review; returns its URL. */
export async function uploadProposal(p: FigureProposal): Promise<string> {
  const token = process.env.PUBLIC_BLOB_READ_WRITE_TOKEN ?? process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("No Vercel Blob token configured");
  let lastErr: unknown = null;
  for (const access of ["public", "private"] as const) {
    try {
      const blob = await put(`figure-compare/${p.questionId}.json`, JSON.stringify(p), {
        access,
        addRandomSuffix: true,
        contentType: "application/json",
        token,
      });
      return blob.url;
    } catch (e) {
      lastErr = e;
      if (!/private store|public access/i.test(e instanceof Error ? e.message : String(e))) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Read a proposal back (only https Vercel Blob URLs are fetched). */
export async function loadProposal(url: string): Promise<FigureProposal | null> {
  const parsed = parseBlobUrl(url);
  if (!parsed) return null;
  const tokens = [process.env.PUBLIC_BLOB_READ_WRITE_TOKEN, process.env.BLOB_READ_WRITE_TOKEN].filter((t): t is string => !!t);
  for (const token of tokens.length ? tokens : [undefined]) {
    try {
      const res = await fetch(parsed.href, { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: "error", cache: "no-store" });
      if (!res.ok) continue;
      const json = (await res.json()) as FigureProposal;
      return json?.version === 1 ? json : null;
    } catch {
      // try the next token
    }
  }
  return null;
}

/** Load figure-check targets (optionally only some ids). */
export async function loadFigureTargets(db: SupabaseClient, ids?: string[]): Promise<FigureRow[]> {
  const rows: FigureRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from("questions").select(FIGURE_COMPARE_SELECT).eq("parsing_status", "Needs Review");
    if (ids?.length) q = q.in("id", ids);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) throw new Error(`loadFigureTargets: ${error.message}`);
    rows.push(...((data ?? []) as unknown as FigureRow[]));
    if (!data || data.length < 1000) break;
  }
  return rows.filter(isFigureTarget);
}
