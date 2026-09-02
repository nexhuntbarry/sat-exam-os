import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import {
  parsePdfToQuestions,
  simpleEmbedding,
  extractAnswerKey,
  fetchPdfAsBase64,
} from "@/lib/ai/parse-pdf";
import { solveQuestionsAndPersist, explainOfficialAndPersist } from "@/lib/ai/solve-question";
import { runPostParseCleanup } from "@/lib/post-parse-cleanup";
import { runSemanticAudit } from "@/lib/ai/semantic-audit";
import { autoPromoteModule } from "@/lib/auto-promote";

export const maxDuration = 800;

// POST /api/admin/modules/[id]/reparse-inplace
//
// Re-parses a module IN PLACE: re-extracts every question from the PDF and
// overwrites the existing question rows BY question-number (keeping their ids),
// so answer_records FKs stay intact — no duplicate rows, no student-history
// loss. Seeds correct_answer from the official answer key (auto-extracted, or
// the official_answer already stored on the rows), runs the solver, reconciles
// against official, then cleanup + semantic audit + auto-promote.
//
// Gated by CRON_SECRET (Authorization: Bearer <CRON_SECRET>) rather than Clerk
// so it can be driven from a script. Meant for repairing the handful of modules
// that were badly parsed before the current pipeline existed.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = getServiceClient();
  const t0 = Date.now();

  const { data: mod } = await db
    .from("modules")
    .select("id, module_name, pdf_url, section, difficulty, module_number")
    .eq("id", id)
    .single();
  if (!mod) return NextResponse.json({ error: "Module not found" }, { status: 404 });

  // Existing rows (preserve ids) + any official answers already on file.
  const { data: existing } = await db
    .from("questions")
    .select("id, original_question_number, official_answer")
    .eq("module_id", id);
  const idByNum = new Map<number, string>();
  const officialByNum = new Map<number, string>();
  for (const r of existing ?? []) {
    idByNum.set(r.original_question_number, r.id);
    if (r.official_answer) officialByNum.set(r.original_question_number, r.official_answer as string);
  }

  // Fill any missing official answers by extracting the key from the PDF.
  let keyEntries = officialByNum.size;
  try {
    const b64 = await fetchPdfAsBase64(mod.pdf_url);
    const key = await extractAnswerKey(b64);
    if (key.found) {
      for (const [num, ans] of Object.entries(key.answers)) {
        officialByNum.set(Number(num), ans as string);
      }
      keyEntries = officialByNum.size;
    }
  } catch (err) {
    console.error("[reparse-inplace] answer-key extract failed (using stored):", err);
  }

  // Re-extract questions.
  let parsed;
  try {
    parsed = await parsePdfToQuestions(mod.pdf_url, {
      section: mod.section as "Math" | "Reading & Writing",
      difficulty_hint: (mod.difficulty ?? "Mixed") as "Easy" | "Medium" | "Hard" | "Mixed",
      moduleNumber: mod.module_number ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Parse failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  if (!parsed.length) {
    return NextResponse.json({ error: "Parse returned 0 questions — module left untouched" }, { status: 422 });
  }

  // Overwrite rows in place by question number.
  let updated = 0, inserted = 0;
  const seen = new Set<number>();
  for (const q of parsed) {
    seen.add(q.original_question_number);
    const official = officialByNum.get(q.original_question_number) ?? null;
    const fields: Record<string, unknown> = {
      section: mod.section,
      question_text: q.question_text,
      choices: q.choices,
      correct_answer: official ?? null,
      explanation: null,
      difficulty: q.difficulty,
      domain: q.domain,
      skill: q.skill,
      concept: q.concept,
      question_type: q.question_type,
      has_image: q.has_image,
      has_table: q.has_table,
      has_formula: q.has_formula,
      source_pdf_url: mod.pdf_url,
      page_number: q.page_number,
      parsing_status: "Draft",
      parsing_notes: "Re-parsed in place",
      ai_confidence_score: q.ai_confidence_score,
      question_text_embedding: simpleEmbedding(q.question_text),
      official_answer: official,
      image_urls: [],
      image_alts: [],
      updated_at: new Date().toISOString(),
    };
    const existingId = idByNum.get(q.original_question_number);
    if (existingId) {
      await db.from("questions").update(fields).eq("id", existingId);
      updated++;
    } else {
      await db.from("questions").insert({ module_id: id, original_question_number: q.original_question_number, ...fields });
      inserted++;
    }
  }
  const orphans = [...idByNum.keys()].filter((n) => !seen.has(n));

  await db
    .from("modules")
    .update({
      parsing_status: "parsed",
      total_questions: parsed.length,
      parsing_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  // Solve, then reconcile the official key over the solver's guesses.
  const solverStats = await solveQuestionsAndPersist(parsed, new Map(), id, db);
  let reconciled = 0;
  const { data: rows } = await db
    .from("questions")
    .select("id, correct_answer, official_answer")
    .eq("module_id", id)
    .not("official_answer", "is", null);
  for (const r of rows ?? []) {
    const off = r.official_answer as string;
    const ai = r.correct_answer as string | null;
    const agree =
      !!ai && !!off &&
      (ai.trim().length === 1 && off.trim().length === 1
        ? ai.trim().toUpperCase() === off.trim().toUpperCase()
        : ai.trim().replace(/\s+/g, "") === off.trim().replace(/\s+/g, ""));
    if (!agree) {
      reconciled++;
      await db
        .from("questions")
        .update({
          correct_answer: off,
          parsing_status: "Needs Review",
          parsing_notes: `Re-parse: official key=${off}, solver said ${ai ?? "?"} — verify`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", r.id);
    }
  }

  let cleanup, explained, audit, promote;
  try { cleanup = await runPostParseCleanup(id, db); } catch (e) { cleanup = { error: String(e) }; }
  // Explain toward the official answer BEFORE the audit — same as the parse
  // pipeline's Phase 4b — so the audit sees consistent answer↔explanation pairs.
  try { explained = await explainOfficialAndPersist(id, db); } catch (e) { explained = { error: String(e) }; }
  try { audit = await runSemanticAudit(id, db); } catch (e) { audit = { error: String(e) }; }
  try { promote = await autoPromoteModule(id, db, 0.9); } catch (e) { promote = { error: String(e) }; }

  return NextResponse.json({
    ok: true,
    module: mod.module_name,
    elapsed_s: Math.round((Date.now() - t0) / 1000),
    keyEntries,
    reExtracted: parsed.length,
    updated,
    inserted,
    orphanQnums: orphans,
    solver: solverStats,
    reconciledToOfficial: reconciled,
    cleanup,
    explained,
    audit,
    promote,
  });
}
