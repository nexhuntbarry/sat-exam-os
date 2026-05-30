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

// In-memory token bucket per admin. Parse runs an AI extraction +
// solver + optional answer-key reconciliation, each invoking Claude
// Sonnet against full PDFs. Cost per call is ~$0.50-$2. Without a
// limit a compromised admin can run thousands of dollars through the
// API in minutes. 10 parses/hour gives plenty of headroom for normal
// onboarding (bulk module uploads come in batches of 4-8) while still
// catching runaway loops.
//
// Vercel Fluid Compute reuses function instances, so the bucket lives
// long enough to be meaningful between calls. Resets when the
// container recycles — that's fine; the goal is cost protection, not
// hard policy enforcement (use a CDN/edge limiter for that).
const PARSE_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PARSE_RATE_MAX = 10;
const parseRateBuckets = new Map<string, number[]>();
function consumeParseQuota(adminId: string): { ok: boolean; retryInSec: number } {
  const now = Date.now();
  const hits = (parseRateBuckets.get(adminId) ?? []).filter(
    (t) => now - t < PARSE_RATE_WINDOW_MS,
  );
  if (hits.length >= PARSE_RATE_MAX) {
    const oldest = Math.min(...hits);
    return { ok: false, retryInSec: Math.ceil((PARSE_RATE_WINDOW_MS - (now - oldest)) / 1000) };
  }
  hits.push(now);
  parseRateBuckets.set(adminId, hits);
  return { ok: true, retryInSec: 0 };
}

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
//
// Optional body: { answerKey: { [questionNumber: number]: string } }
// When provided (typically from a prior /probe-answer-key call), the
// parser stores each official answer alongside the AI-derived solver
// answer. After the solver runs, mismatches are flagged
// (mismatch_with_official=true, parsing_status="Needs Review",
// parsing_notes appended with "AI: X, official: Y") and correct_answer
// is overwritten to match the official answer — official is the source
// of truth for what students see.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const rl = consumeParseQuota(authResult.userId);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: `Rate limit: max ${PARSE_RATE_MAX} parses/hour per admin. Retry in ${rl.retryInSec}s.`,
      },
      { status: 429, headers: { "Retry-After": String(rl.retryInSec) } },
    );
  }

  const { id } = await params;
  const db = getServiceClient();

  // Optional answer key from probe step.
  let answerKey: Record<number, string> | null = null;
  try {
    const body = (await req.clone().json()) as
      | { answerKey?: Record<string, string> }
      | undefined;
    if (body?.answerKey) {
      answerKey = {};
      for (const [k, v] of Object.entries(body.answerKey)) {
        const n = Number(k);
        if (Number.isFinite(n) && typeof v === "string" && v.trim()) {
          answerKey[n] = v.trim();
        }
      }
      if (Object.keys(answerKey).length === 0) answerKey = null;
    }
  } catch {
    // No body / invalid JSON → parse without answer key (legacy behaviour).
  }

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
  if (mod.section !== "Reading & Writing") {
    try {
      const result = await extractAndUploadQuestionImages(
        pdfBase64,
        parsedQuestions,
        id,
      );
      imageMap = result.byQuestion;
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

    // MCQ-without-choices defense. The parser occasionally drops the
    // choices array on a Multiple Choice row (5 cases were caught
    // 2026-05-30 in October 2024 SAT English Module 1). Once such a
    // row reaches Draft the auto-promote sweep flips it to Approved
    // and students see the stem with no options. Catch it at insert.
    const choiceCount = Array.isArray(q.choices) ? q.choices.length : 0;
    if (q.question_type === "Multiple Choice" && choiceCount < 4) {
      parsingStatus = "Needs Review";
      parsingNotes = (parsingNotes ? parsingNotes + "; " : "") +
        `Multiple Choice with ${choiceCount} choices (expected 4) — re-run scripts/recover-missing-choices.ts or extract manually`;
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

    const imagesForQ = imageMap.get(q.original_question_number);
    const officialAns = answerKey?.[q.original_question_number] ?? null;

    // Partial answer key: an answer key was uploaded BUT this specific
    // question's official answer wasn't captured. The AI solver runs
    // anyway, but the admin should treat the result as unverified.
    // Flag for review so it sticks out in the question list.
    if (answerKey && !officialAns) {
      parsingStatus = "Needs Review";
      parsingNotes = (parsingNotes ? parsingNotes + "; " : "") +
        `No official answer in key for Q${q.original_question_number} — AI solver only, please verify`;
    }

    if (parsingStatus === "Needs Review") needsReviewCount++;
    const { error: insertError } = await db.from("questions").insert({
      module_id: id,
      section: mod.section,
      original_question_number: q.original_question_number,
      question_text: q.question_text,
      choices: q.choices,
      // Solver fills these in async via the `after` callback below. Keep
      // any answer/explanation that already came from the parser pass.
      // If we have an official answer, seed correct_answer with it so
      // students never see the AI's guess as authoritative.
      correct_answer: officialAns ?? q.correct_answer ?? null,
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
      official_answer: officialAns,
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

  // Phase 2 — solver inline. Vercel `after()` proved unreliable on Hobby
  // (callback never executed in production for a 27-question R&W module).
  // Solver in parallel chunks of 5 takes ~30-60s — fits inside the
  // remaining 300s budget after extraction.
  const imagesForSolver = new Map<number, { urls: string[] }>();
  for (const [num, info] of imageMap) {
    imagesForSolver.set(num, { urls: info.urls });
  }
  let solverStats = { solved: 0, failed: 0 };
  try {
    solverStats = await solveQuestionsAndPersist(
      parsedQuestions,
      imagesForSolver,
      id,
      db,
      authResult.userId,
    );
  } catch (err) {
    console.error("[modules/parse] solver crashed (questions saved without answers):", err);
  }

  // Phase 3 — official-answer reconciliation. Only runs when the upload
  // included an answer key. Solver wrote correct_answer with its own
  // best guess; for every question that has an official_answer we now
  // compare the two, overwrite correct_answer with the official one,
  // and flag mismatches for admin review.
  let mismatchCount = 0;
  if (answerKey) {
    const { data: solvedRows } = await db
      .from("questions")
      .select("id, original_question_number, correct_answer, official_answer, parsing_notes, parsing_status")
      .eq("module_id", id)
      .not("official_answer", "is", null);

    for (const row of solvedRows ?? []) {
      const aiAns = row.correct_answer as string | null;
      const officialAns = row.official_answer as string;
      // Solver may not have answered yet (timeout) — skip until next run.
      if (!aiAns) continue;

      if (!answersAgree(aiAns, officialAns)) {
        mismatchCount++;
        const hint = `Mismatch: AI answered ${aiAns}, official ${officialAns}`;
        const existingNotes = (row.parsing_notes as string | null) ?? "";
        const newNotes = existingNotes ? `${existingNotes}; ${hint}` : hint;
        await db
          .from("questions")
          .update({
            correct_answer: officialAns,
            mismatch_with_official: true,
            parsing_status: "Needs Review",
            parsing_notes: newNotes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      } else {
        // Already correct — clear the "Pending AI answer" placeholder
        // note since we've now confirmed the answer matches official.
        if (typeof row.parsing_notes === "string") {
          const cleaned = row.parsing_notes
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s && s !== "Pending AI answer")
            .join("; ");
          if (cleaned !== row.parsing_notes) {
            await db
              .from("questions")
              .update({ parsing_notes: cleaned || null })
              .eq("id", row.id);
          }
        }
      }
    }
  }

  return NextResponse.json({
    success: true,
    questionCount: totalInserted,
    needsReview: needsReviewCount + mismatchCount,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    solved: solverStats.solved,
    solverFailed: solverStats.failed,
    answerKeyUsed: answerKey ? Object.keys(answerKey).length : 0,
    mismatches: mismatchCount,
  });
}

/**
 * Loose equality for SAT answers. Letters compared case-insensitive +
 * trimmed. Numeric SPR answers compared as floats so "1/2" == "0.5"
 * == ".5". Falls back to trimmed string compare when neither side
 * parses as a number.
 */
function answersAgree(a: string, b: string): boolean {
  const ta = a.trim();
  const tb = b.trim();
  if (ta.length === 1 && tb.length === 1) {
    return ta.toUpperCase() === tb.toUpperCase();
  }
  const na = parseAnswerAsNumber(ta);
  const nb = parseAnswerAsNumber(tb);
  if (na !== null && nb !== null) {
    return Math.abs(na - nb) < 1e-6;
  }
  return ta.replace(/\s+/g, "") === tb.replace(/\s+/g, "");
}

function parseAnswerAsNumber(v: string): number | null {
  // Strip $...$ LaTeX wrapping.
  const cleaned = v.replace(/^\$+|\$+$/g, "").trim();
  // Fraction like "3/4".
  const frac = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (frac) {
    const num = parseFloat(frac[1]);
    const den = parseFloat(frac[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return num / den;
    }
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
