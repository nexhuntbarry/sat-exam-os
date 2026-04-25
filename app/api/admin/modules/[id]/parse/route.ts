import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import {
  parsePdfToQuestions,
  simpleEmbedding,
  cosineSimilarity,
  classifyPdfIsSat,
  fetchPdfAsBase64,
} from "@/lib/ai/parse-pdf";

const SAT_CONFIDENCE_THRESHOLD = 0.6;

export const maxDuration = 300; // 5 minutes — Vercel Node.js runtime

// POST /api/admin/modules/[id]/parse
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  // Fetch module
  const { data: mod, error: fetchError } = await db
    .from("modules")
    .select("id, pdf_url, section, difficulty, module_number, parsing_status")
    .eq("id", id)
    .single();

  if (fetchError || !mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  if (mod.parsing_status === "parsing") {
    return NextResponse.json({ error: "Already parsing" }, { status: 409 });
  }

  // Mark as parsing
  await db
    .from("modules")
    .update({
      parsing_status: "parsing",
      parsing_started_at: new Date().toISOString(),
      parsing_error: null,
      parsing_model: "claude-sonnet-4-6",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  // Step A — Pre-parse classifier: is this PDF actually a SAT test?
  // Cheap Haiku call up front so we can fail fast on garbage uploads.
  let pdfBase64: string;
  try {
    pdfBase64 = await fetchPdfAsBase64(mod.pdf_url);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[modules/parse] PDF fetch failed:", err);
    await db
      .from("modules")
      .update({
        parsing_status: "failed",
        parsing_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    return NextResponse.json({ error: "PDF fetch failed", detail: errorMsg }, { status: 500 });
  }

  const classification = await classifyPdfIsSat(pdfBase64, authResult.userId);
  if (!classification.is_sat || classification.confidence < SAT_CONFIDENCE_THRESHOLD) {
    const reason = `${classification.reason} (confidence ${classification.confidence.toFixed(2)})`;
    await db
      .from("modules")
      .update({
        parsing_status: "rejected_not_sat",
        parsing_error: reason,
        parsing_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    return NextResponse.json(
      {
        rejected: true,
        is_sat: classification.is_sat,
        confidence: classification.confidence,
        reason: classification.reason,
      },
      { status: 200 },
    );
  }

  // Step B — Extract questions (existing logic)
  let parsedQuestions;
  try {
    parsedQuestions = await parsePdfToQuestions(
      mod.pdf_url,
      {
        section: mod.section as "Math" | "Reading & Writing",
        difficulty_hint: (mod.difficulty ?? "Mixed") as
          | "Easy"
          | "Medium"
          | "Hard"
          | "Mixed",
        moduleNumber: mod.module_number ?? null,
      },
      authResult.userId
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[modules/parse] parsePdfToQuestions failed:", err);
    await db
      .from("modules")
      .update({
        parsing_status: "failed",
        parsing_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    return NextResponse.json({ error: "Parse failed", detail: errorMsg }, { status: 500 });
  }

  if (parsedQuestions.length === 0) {
    await db
      .from("modules")
      .update({
        parsing_status: "failed",
        parsing_error: "AI returned 0 questions. PDF may be empty or unreadable.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    return NextResponse.json(
      { error: "No questions extracted" },
      { status: 422 }
    );
  }

  // Fetch existing questions in same section for duplicate detection
  const { data: existingQuestions } = await db
    .from("questions")
    .select("id, question_text, question_text_embedding")
    .eq("section", mod.section)
    .neq("module_id", id);

  const existing = existingQuestions ?? [];

  // Insert questions
  let needsReviewCount = 0;
  let totalInserted = 0;
  const avgConfidence =
    parsedQuestions.reduce((sum, q) => sum + q.ai_confidence_score, 0) /
    parsedQuestions.length;

  for (const q of parsedQuestions) {
    const embedding = simpleEmbedding(q.question_text);
    let parsingStatus: "Draft" | "Needs Review" = "Draft";
    let parsingNotes: string | null = null;

    // Low confidence → Needs Review
    if (q.ai_confidence_score < 0.7) {
      parsingStatus = "Needs Review";
      parsingNotes = `Low AI confidence (${q.ai_confidence_score.toFixed(2)})`;
    }

    // Duplicate check against existing questions
    for (const ex of existing) {
      const exEmbed = ex.question_text_embedding as { hash: string; excerpt: string } | null;
      if (!exEmbed) continue;
      const sim = cosineSimilarity(embedding, exEmbed);
      if (sim > 0.92) {
        parsingStatus = "Needs Review";
        parsingNotes = (parsingNotes ? parsingNotes + "; " : "") +
          `Possible duplicate of question ${ex.id} (similarity ${sim.toFixed(2)})`;
        break;
      }
    }

    if (parsingStatus === "Needs Review") needsReviewCount++;

    const { error: insertError } = await db.from("questions").insert({
      module_id: id,
      section: mod.section,
      original_question_number: q.original_question_number,
      question_text: q.question_text,
      choices: q.choices,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
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
      parsing_status: parsingStatus,
      parsing_notes: parsingNotes,
      ai_confidence_score: q.ai_confidence_score,
      question_text_embedding: embedding,
    });

    if (insertError) {
      console.error("[modules/parse] Insert question error:", insertError);
    } else {
      totalInserted++;
    }
  }

  // Mark module as parsed
  await db
    .from("modules")
    .update({
      parsing_status: "parsed",
      parsing_completed_at: new Date().toISOString(),
      total_questions: totalInserted,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  return NextResponse.json({
    success: true,
    questionCount: totalInserted,
    needsReview: needsReviewCount,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
  });
}
