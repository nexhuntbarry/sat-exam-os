import { NextResponse } from "next/server";
import { after } from "next/server";
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
import { solveQuestionsAndPersist } from "@/lib/ai/solve-question";

const SAT_CONFIDENCE_THRESHOLD = 0.6;

// How long a `parsing` lock is considered "fresh". Past this, treat the
// module as recoverable so admins can re-trigger after a crash/timeout.
const PARSE_LOCK_FRESHNESS_MS = 600_000; // 10 minutes

// Vercel Hobby plan caps Serverless Functions at 300s. Revert from 800.
export const maxDuration = 300;

// POST /api/admin/modules/[id]/parse
//
// Two-phase parse:
//   Phase 1 (sync, returns to client): classifier → extraction → image
//   extraction → INSERT all questions with null answers → mark module
//   parsed. Client can navigate away as soon as we respond.
//   Phase 2 (background via Next.js `after()`): chunked parallel solver
//   that UPDATEs each question row as the answer comes back. Even if the
//   serverless budget runs out partway, the questions are already in the
//   bank — admins can re-trigger if needed.
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
    .select(
      "id, pdf_url, section, difficulty, module_number, parsing_status, parsing_started_at",
    )
    .eq("id", id)
    .single();

  if (fetchError || !mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  // Stuck-state reconciler — only refuse re-entry if the existing `parsing`
  // lock is fresh (< PARSE_LOCK_FRESHNESS_MS old). A stale lock means the
  // previous run crashed or timed out; allow recovery.
  if (mod.parsing_status === "parsing") {
    const startedAt = mod.parsing_started_at
      ? new Date(mod.parsing_started_at as string).getTime()
      : 0;
    const ageMs = Date.now() - startedAt;
    if (startedAt > 0 && ageMs < PARSE_LOCK_FRESHNESS_MS) {
      return NextResponse.json(
        { error: "Already parsing", lockAgeMs: ageMs },
        { status: 409 },
      );
    }
    console.warn(
      `[modules/parse] stale parsing lock for module ${id} (age ${Math.round(ageMs / 1000)}s); recovering`,
    );
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
  //
  // Skipped entirely for Reading & Writing modules — R&W questions almost
  // never include figures, the cropper pipeline is the slowest stage in the
  // 5-minute Vercel function budget, and the inline-iframe renderer covers
  // any rare R&W figure without needing per-question crops.
  let imageMap: Map<number, { urls: string[]; alts: string[] }> = new Map();
  if (mod.section === "Reading & Writing") {
    console.log("[modules/parse] skipping image extraction for R&W module");
  } else {
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
  }

  // Fetch existing questions in same section for duplicate detection
  const { data: existingQuestions } = await db
    .from("questions")
    .select("id, question_text, question_text_embedding")
    .eq("section", mod.section)
    .neq("module_id", id);

  const existing = existingQuestions ?? [];

  // Step D — INSERT every question NOW with correct_answer/explanation = null.
  // The solver runs in the background after the response is sent (see `after`
  // block below) and UPDATES each row as solutions arrive. This unblocks the
  // UI in ~30s instead of waiting the full ~3 min for the solver to finish.
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

    // Pending answer note — replaced by the background solver once it lands.
    const needsSolver = !q.correct_answer || !q.explanation;
    if (needsSolver) {
      parsingNotes = (parsingNotes ? parsingNotes + "; " : "") +
        "Pending AI answer";
    }

    if (parsingStatus === "Needs Review") needsReviewCount++;

    const imagesForQ = imageMap.get(q.original_question_number);
    const { error: insertError } = await db.from("questions").insert({
      module_id: id,
      section: mod.section,
      original_question_number: q.original_question_number,
      question_text: q.question_text,
      choices: q.choices,
      // Solver fills these in async via the `after` callback below. Keep
      // any answer/explanation that already came from the parser pass.
      correct_answer: q.correct_answer ?? null,
      explanation: q.explanation ?? null,
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

  // Mark module as parsed — questions are visible immediately, even though
  // their answers/explanations are still being filled in by the background
  // solver. The questions list/detail UI should poll while parsing_notes
  // contains "Pending AI answer".
  await db
    .from("modules")
    .update({
      parsing_status: "parsed",
      parsing_completed_at: new Date().toISOString(),
      total_questions: totalInserted,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  // Phase 2 — kick off the solver after the response is flushed.
  // `after()` runs independently of the request; the user sees questions
  // appear instantly and the solver fills in answers over the next ~30s.
  // On Vercel Hobby this still has a 300s budget but it's separate from
  // the request, so partial timeouts don't roll back the inserts above.
  const imagesForSolver = new Map<number, { urls: string[] }>();
  for (const [num, info] of imageMap) {
    imagesForSolver.set(num, { urls: info.urls });
  }
  after(async () => {
    // Re-derive the service client inside the callback — the outer `db`
    // would still work, but a fresh one keeps the contract obvious.
    const bgDb = getServiceClient();
    try {
      const t0 = Date.now();
      const { solved, failed } = await solveQuestionsAndPersist(
        parsedQuestions,
        imagesForSolver,
        id,
        bgDb,
        authResult.userId,
      );
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[modules/parse] background solver done in ${elapsed}s — solved=${solved} failed=${failed}`,
      );
    } catch (err) {
      console.error(
        "[modules/parse] background solver crashed (questions stay with null answers):",
        err,
      );
    }
  });

  return NextResponse.json({
    success: true,
    questionCount: totalInserted,
    needsReview: needsReviewCount,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    solverPending: true,
  });
}
