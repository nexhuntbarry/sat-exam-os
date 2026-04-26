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
import { extractAndUploadQuestionImages } from "@/lib/ai/extract-images";
import { solveQuestions, type SolvedAnswer } from "@/lib/ai/solve-question";

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

  let classification;
  try {
    classification = await classifyPdfIsSat(pdfBase64, authResult.userId);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[modules/parse] classifier failed:", err);
    await db
      .from("modules")
      .update({
        parsing_status: "failed",
        parsing_error: errorMsg,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    return NextResponse.json({ error: "Classifier failed", detail: errorMsg }, { status: 500 });
  }
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

  // Step C — Extract & upload question images (graphs, tables, diagrams)
  // We already have pdfBase64 in memory from the classifier step; reuse it
  // rather than re-fetching from Blob. Failures are non-fatal: questions
  // are still saved, they just won't have inline images.
  let imageMap: Map<number, { urls: string[]; alts: string[] }> = new Map();
  try {
    const result = await extractAndUploadQuestionImages(
      pdfBase64,
      parsedQuestions,
      id,
    );
    imageMap = result.byQuestion;
    console.log(
      `[modules/parse] extracted ${result.totalUploaded} images across ${result.byQuestion.size} questions; ${result.errors.length} errors`,
    );
  } catch (err) {
    console.error("[modules/parse] image extraction failed (non-fatal):", err);
  }

  // Step D — Solve every question (answer key + explanation)
  // SAT module PDFs are question-only; ask Claude to solve so the bank is
  // self-contained. Failures are non-fatal: questions still save without
  // an AI-generated answer.
  let answerMap = new Map<number, SolvedAnswer>();
  try {
    const imagesForSolver = new Map<number, { urls: string[] }>();
    for (const [num, info] of imageMap) {
      imagesForSolver.set(num, { urls: info.urls });
    }
    answerMap = await solveQuestions(
      parsedQuestions,
      imagesForSolver,
      authResult.userId,
    );
    console.log(
      `[modules/parse] solver produced answers for ${answerMap.size}/${parsedQuestions.length} questions`,
    );
  } catch (err) {
    console.error(
      "[modules/parse] solver failed (non-fatal, questions saved without answers):",
      err,
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

    // Apply AI-solver fallback for missing answer/explanation. If the solver
    // supplied either field, annotate parsing_notes so reviewers know the
    // value isn't from an authoritative answer key.
    const solved = answerMap.get(q.original_question_number);
    const correctAnswer = q.correct_answer ?? solved?.correct_answer ?? null;
    const explanation = q.explanation ?? solved?.explanation ?? null;
    const usedSolverForAnswer = !q.correct_answer && !!solved?.correct_answer;
    const usedSolverForExplanation = !q.explanation && !!solved?.explanation;
    if (usedSolverForAnswer || usedSolverForExplanation) {
      parsingNotes = (parsingNotes ? parsingNotes + "; " : "") +
        "Answer & explanation generated by AI solver — please verify";
    }

    // If the solver self-contradicted (declared one answer but argued for
    // another in the explanation), force Needs Review with a precise note so
    // reviewers know exactly which value to trust.
    if (solved?.consistencyMismatch) {
      parsingStatus = "Needs Review";
      parsingNotes = (parsingNotes ? parsingNotes + "; " : "") +
        `Solver self-contradicts: declared ${solved.correct_answer}, explained ${solved.explainedAnswer ?? "<unparsed>"}`;
    }

    if (parsingStatus === "Needs Review") needsReviewCount++;

    const imagesForQ = imageMap.get(q.original_question_number);
    const { error: insertError } = await db.from("questions").insert({
      module_id: id,
      section: mod.section,
      original_question_number: q.original_question_number,
      question_text: q.question_text,
      choices: q.choices,
      correct_answer: correctAnswer,
      explanation: explanation,
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
      image_urls: imagesForQ?.urls ?? [],
      image_alts: imagesForQ?.alts ?? [],
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
