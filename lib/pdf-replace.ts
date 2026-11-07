// lib/pdf-replace.ts
//
// "Replace source PDF" for an existing module (admin module page). The new
// PDF is attached to the SAME module without re-parsing: modules.pdf_url /
// pdf_size_bytes and questions.source_pdf_url change; question content,
// status, correct_answer, answer_records and scores are left alone. Each
// question is then re-read from the new PDF (reextractQuestionFromPdf) and
// compared with the stored copy; the outcome is a parsing_notes tag
// (lib/pdf-check-tags.ts). Nothing is ever approved here. A question that
// differs moves to Needs Review — unless it is in a live test, where the
// status stays and only notes are added (applyLiveHold).

import { head } from "@vercel/blob";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backupModulePdf, isOurBlob } from "@/lib/pdf-backup";
import {
  PDF_PENDING_TAG,
  pdfDiffNote,
  pdfMatchNote,
  pdfCheckState,
  pdfPendingNote,
  withPdfNote,
} from "@/lib/pdf-check-tags";
import { applyLiveHold, liveQuestionIds, stripLiveFixNote, type LiveHoldRow } from "@/lib/live-questions";
import { fetchPdfBase64, reextractQuestionFromPdf, type ReextractProposal } from "@/lib/repair-ops";
import {
  choiceTextsAgree,
  extractChoicesFromPdfText,
  isComparableChoice,
  isTextLayerReliable,
  lookupPdfTextQuestion,
  normalizeChoiceText,
  type PdfTextChoices,
} from "@/lib/pdf-text-choices";

export class ReplacePdfError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ReplaceResult {
  questions: number;
  backups: string[];
  backupWarnings: string[];
}

/**
 * Point module `moduleId` (and its questions) at `pdfUrl`, after backing up
 * both the new PDF (required) and the old one (best effort). Every question
 * gets a "[pdf-pending]" tag for the comparison batches.
 */
export async function replaceModulePdf(
  db: SupabaseClient,
  moduleId: string,
  pdfUrl: string,
): Promise<ReplaceResult> {
  if (!isOurBlob(pdfUrl) || !new URL(pdfUrl).pathname.startsWith("/modules/")) {
    throw new ReplacePdfError("pdfUrl must be a PDF uploaded to the modules/ folder", 400);
  }
  const { data: mod } = await db.from("modules").select("id, pdf_url").eq("id", moduleId).maybeSingle();
  if (!mod) throw new ReplacePdfError("Module not found", 404);
  if (mod.pdf_url === pdfUrl) throw new ReplacePdfError("That PDF is already this module's source", 400);

  let size: number;
  try {
    const meta = await head(pdfUrl);
    if (meta.contentType && !meta.contentType.includes("pdf")) {
      throw new ReplacePdfError(`Uploaded file is ${meta.contentType}, not a PDF`, 400);
    }
    size = meta.size;
  } catch (err) {
    if (err instanceof ReplacePdfError) throw err;
    throw new ReplacePdfError("The uploaded PDF could not be found in storage", 400);
  }

  const backups: string[] = [];
  const backupWarnings: string[] = [];
  // The new file must be backed up before anything points at it.
  try {
    backups.push(await backupModulePdf(moduleId, pdfUrl));
  } catch (err) {
    throw new ReplacePdfError(`Backup of the new PDF failed: ${err instanceof Error ? err.message : err}`, 500);
  }
  if (mod.pdf_url && isOurBlob(mod.pdf_url)) {
    try {
      backups.push(await backupModulePdf(moduleId, mod.pdf_url));
    } catch (err) {
      backupWarnings.push(`old PDF not backed up (${err instanceof Error ? err.message : err})`);
    }
  }

  const now = new Date().toISOString();
  // Questions first, module row last: if a question batch fails, the module
  // still points at the old PDF, so the admin can simply retry the same
  // upload (the "already this module's source" guard won't block it) and
  // every question gets re-tagged.
  const { data: rows, error: qErr } = await db
    .from("questions")
    .select("id, parsing_notes")
    .eq("module_id", moduleId);
  if (qErr) throw new ReplacePdfError(`Question lookup failed: ${qErr.message}`, 500);
  const list = rows ?? [];
  for (let i = 0; i < list.length; i += 10) {
    const results = await Promise.all(
      list.slice(i, i + 10).map((r) =>
        db
          .from("questions")
          .update({
            source_pdf_url: pdfUrl,
            parsing_notes: withPdfNote(r.parsing_notes as string | null, pdfPendingNote()),
            updated_at: now,
          })
          .eq("id", r.id),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) throw new ReplacePdfError(`Question update failed: ${failed.error.message}`, 500);
  }
  const { error: mErr } = await db
    .from("modules")
    .update({ pdf_url: pdfUrl, pdf_size_bytes: size, updated_at: now })
    .eq("id", moduleId);
  if (mErr) throw new ReplacePdfError(`Module update failed: ${mErr.message}`, 500);

  return { questions: list.length, backups, backupWarnings };
}

// ── Comparison ──────────────────────────────────────────────────────

interface CompareRow {
  id: string;
  original_question_number: number | null;
  question_type: string | null;
  question_text: string | null;
  choices: unknown;
  correct_answer: string | null;
  official_answer: string | null;
  parsing_status: string | null;
  parsing_notes: string | null;
}

function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) grams.set(a.slice(i, i + 2), (grams.get(a.slice(i, i + 2)) ?? 0) + 1);
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      inter++;
      grams.set(g, n - 1);
    }
  }
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

const short = (s: string, n = 50) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const STEM_SIMILARITY = 0.9;

function storedChoice(row: CompareRow, label: string): string {
  const stored = Array.isArray(row.choices) ? (row.choices as { label?: string; text?: string }[]) : [];
  return stored.find((x) => (x?.label ?? "").trim().toUpperCase() === label)?.text ?? "";
}

/**
 * The vision read sometimes binds a choice from the question printed above
 * (seen: Test #17 Q3 choice D read as Q2's "Remember"). When the PDF text
 * layer has this question's choices and they agree with the stored one,
 * that choice difference is dropped.
 */
function dropTextLayerConfirmed(row: CompareRow, diffs: PdfDiff[], pdfText: PdfTextChoices | null): PdfDiff[] {
  const textQ = pdfText && row.original_question_number != null
    ? lookupPdfTextQuestion(pdfText, row.original_question_number)
    : null;
  if (!textQ) return diffs;
  return diffs.filter((d) => {
    if (!d.key.startsWith("choice ")) return true;
    const t = textQ.choices.find((c) => c.label === d.key.slice(7));
    if (!t || !isComparableChoice(t.text)) return true;
    return !choiceTextsAgree(storedChoice(row, d.key.slice(7)), t.text);
  });
}

export interface PdfDiff {
  /** Which part differs ("stem", "choice B", "answer", "type", "error"). */
  key: string;
  text: string;
}

/** What differs between the stored question and the PDF read (empty = matches). */
export function diffAgainstPdf(row: CompareRow, p: ReextractProposal): PdfDiff[] {
  const out: PdfDiff[] = [];
  for (const w of p.warnings) if (/PDF reads as/.test(w)) out.push({ key: "type", text: w });

  // Printed boilerplate the stored stem often leaves out, and "[Right
  // triangle FGH with …]" figure descriptions the read sometimes adds.
  const stem = (s: string) =>
    normalizeChoiceText(
      s.replace(/note:\s*figures?\s+not\s+drawn\s+to\s+scale\.?/gi, "").replace(/^\s*\[[^\]\n]*\]\s*$/gm, ""),
    );
  const a = stem(row.question_text ?? "");
  const b = stem(p.question_text);
  const sim = bigramDice(a, b);
  if (sim < STEM_SIMILARITY) out.push({ key: "stem", text: `question text differs (${Math.round(sim * 100)}% similar)` });

  if (row.question_type === "Multiple Choice" && p.choices.length > 0) {
    for (const c of p.choices) {
      const sText = storedChoice(row, c.label);
      if (!normalizeChoiceText(sText) && !normalizeChoiceText(c.text)) continue; // graph choices
      if (!choiceTextsAgree(sText, c.text)) {
        out.push({ key: `choice ${c.label}`, text: `choice ${c.label}: saved "${short(sText)}" vs PDF "${short(c.text)}"` });
      }
    }
  }

  // A "marked" answer is read off checkmarks and is the least reliable part
  // of the read (seen: Test #17 Q17 read as D on an unmarked page). When the
  // saved key already equals the official answer-key page, trust that.
  const keyIsOfficial =
    !!row.official_answer &&
    normalizeChoiceText(row.official_answer) === normalizeChoiceText(row.correct_answer ?? "");
  if (p.marked_answer && row.correct_answer && !keyIsOfficial) {
    const marked = normalizeChoiceText(p.marked_answer);
    const keys = row.correct_answer.split(/[,|;]|\bor\b/).map(normalizeChoiceText).filter(Boolean);
    if (marked && keys.length && !keys.includes(marked)) {
      out.push({ key: "answer", text: `PDF marks answer ${short(p.marked_answer, 20)}, saved key is ${short(row.correct_answer, 20)}` });
    }
  }
  return out;
}

export interface CompareSummary {
  checked: number;
  matched: number;
  differs: number;
  remaining: number;
}

/**
 * Compare the module's "[pdf-pending]" questions with its current PDF, in
 * parallel, until `budgetMs` runs out. Callers loop until remaining = 0
 * (the module page does this; each request fits the function limit).
 */
export async function comparePendingQuestions(
  db: SupabaseClient,
  moduleId: string,
  opts: { budgetMs?: number; concurrency?: number } = {},
): Promise<CompareSummary> {
  const deadline = Date.now() + (opts.budgetMs ?? 200_000);
  const { data: mod } = await db.from("modules").select("pdf_url").eq("id", moduleId).maybeSingle();
  if (!mod?.pdf_url) throw new ReplacePdfError("Module has no source PDF", 404);

  const { data: rows, error } = await db
    .from("questions")
    .select(
      "id, original_question_number, question_type, question_text, choices, correct_answer, official_answer, parsing_status, parsing_notes",
    )
    .eq("module_id", moduleId)
    .like("parsing_notes", `%${PDF_PENDING_TAG}%`)
    .order("original_question_number", { ascending: true });
  if (error) throw new Error(`pending lookup: ${error.message}`);
  const queue = [...((rows ?? []) as CompareRow[])];
  const summary: CompareSummary = { checked: 0, matched: 0, differs: 0, remaining: queue.length };
  if (queue.length === 0) return summary;

  const pdfBase64 = await fetchPdfBase64(mod.pdf_url as string);
  let pdfText: PdfTextChoices | null = null;
  try {
    pdfText = await extractChoicesFromPdfText(pdfBase64);
    if (!isTextLayerReliable(pdfText, queue.length)) pdfText = null;
  } catch {
    pdfText = null;
  }
  const live = await liveQuestionIds(
    db,
    queue.filter((r) => r.parsing_status === "Approved").map((r) => r.id),
  );

  const worker = async () => {
    for (let row = queue.shift(); row; row = Date.now() < deadline ? queue.shift() : undefined) {
      const current = row;
      const read = async (): Promise<PdfDiff[]> => {
        try {
          const res = await reextractQuestionFromPdf(current.id, { pdfBase64 });
          return res.ok ? diffAgainstPdf(current, res.proposal) : [{ key: "error", text: `couldn't compare: ${res.message}` }];
        } catch (err) {
          return [{ key: "error", text: `couldn't compare: ${err instanceof Error ? err.message : String(err)}` }];
        }
      };
      // One AI read can misread or mis-bind a choice. A difference counts
      // only if the PDF text layer doesn't contradict it and a second read
      // sees it too.
      let diffs = dropTextLayerConfirmed(current, await read(), pdfText);
      if (diffs.length > 0) {
        const again = new Set((await read()).map((d) => d.key));
        diffs = diffs.filter((d) => again.has(d.key));
      }
      const now = new Date().toISOString();
      let update: Record<string, unknown>;
      if (diffs.length === 0) {
        // Matches: tag only. Never approve here.
        update = { parsing_notes: withPdfNote(row.parsing_notes, pdfMatchNote()), updated_at: now };
        summary.matched++;
      } else {
        // A live row gets a fresh [live-fix] from applyLiveHold below.
        const base = row.parsing_status === "Approved" && live.has(row.id) ? stripLiveFixNote(row.parsing_notes) : row.parsing_notes;
        update = { parsing_notes: withPdfNote(base, pdfDiffNote(diffs.map((d) => d.text).join(", "))), updated_at: now };
        if (row.parsing_status === "Draft" || row.parsing_status === "Approved") {
          update.parsing_status = "Needs Review";
        }
        // Live test: keep the status, add the [live-fix] re-check note.
        update = applyLiveHold(
          row as LiveHoldRow,
          update,
          "Its replaced source PDF differs from this question",
          live,
        ).update;
        summary.differs++;
      }
      const { error: uErr } = await db.from("questions").update(update).eq("id", row.id);
      if (uErr) console.error(`[pdf-replace] update q${row.original_question_number} failed:`, uErr.message);
      summary.checked++;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));

  const { count } = await db
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("module_id", moduleId)
    .like("parsing_notes", `%${PDF_PENDING_TAG}%`);
  summary.remaining = count ?? 0;
  return summary;
}

/** Counts of the pdf-check outcome per state for one module. */
export async function pdfCheckCounts(
  db: SupabaseClient,
  moduleId: string,
): Promise<{ pending: number; match: number; diff: number }> {
  const { data } = await db.from("questions").select("parsing_notes").eq("module_id", moduleId);
  const out = { pending: 0, match: 0, diff: 0 };
  for (const r of data ?? []) {
    const state = pdfCheckState(r.parsing_notes as string | null);
    if (state) out[state]++;
  }
  return out;
}
