// ────────────────────────────────────────────
// SAT question solver pass
// ────────────────────────────────────────────
//
// SAT module PDFs are typically question-only (no answer key, no
// explanations). After extraction we run a "solver pass" so every question
// in the bank has a `correct_answer` and `explanation` — making the bank
// self-contained for student review.
//
// Strategy:
//   - For each question that's missing answer or explanation, ask Claude
//     Sonnet 4.6 to solve it (better SAT reasoning than Haiku).
//   - When the question references images (graphs/diagrams already cropped
//     and uploaded by extract-images), include them as base64 image blocks
//     so the solver can actually read the visual.
//   - Run sequentially (rate-limit safety) and keep solver failures
//     non-fatal: the question is still saved, it just won't get an answer.

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { ParsedQuestion } from "./parse-pdf";
import { logUsage } from "./parse-pdf";
import type { getServiceClient } from "@/lib/supabase";

type DbClient = ReturnType<typeof getServiceClient>;

const SolverSchema = z.object({
  correct_answer: z
    .string()
    .describe(
      "For MCQ: single letter A/B/C/D. For Student Produced Response: the numeric/text answer the student should write. Empty string when needs_drawing=true.",
    ),
  explanation: z
    .string()
    .describe(
      "Step-by-step solution in plain prose, suitable for a student review. Include the key insight that gets to the answer. Markdown allowed for formula notation.",
    ),
  confidence: z.number().describe("Solver self-confidence between 0 and 1"),
  needs_drawing: z
    .boolean()
    .describe(
      "Set to true when reliably solving the problem REQUIRES physically constructing or drawing a figure (e.g. ruler-and-compass geometry construction, free-body diagram, or sketching a graph from scratch when no figure is provided). In that case leave correct_answer as an empty string and put the reason in explanation. Don't set this for problems that merely refer to a figure already shown — those go through the regular image pipeline.",
    ),
});

const SOLVER_SYSTEM_PROMPT = `You are an expert SAT tutor who solves SAT problems for the official answer key.

Solve the supplied SAT question rigorously. For Multiple Choice questions, identify the single correct option (A/B/C/D). For Student Produced Response questions, give the exact answer the student should grid in (decimal or fraction; no units).

Your explanation must be the kind a student review tool would show after they answer — concise, step by step, and pointing out the key insight. Use plain prose with markdown allowed for formulas.

MATH FORMATTING (CRITICAL):
- Every mathematical expression — even simple ones — MUST be wrapped in $...$ for inline math or $$...$$ for display math.
- Use proper LaTeX commands: \\frac{a}{b} for fractions, \\sqrt{x} for square roots, x^{2} for exponents, _{i} for subscripts.
- Examples:
  - "the slope is 1/7" → "the slope is $\\frac{1}{7}$"
  - "y = 7x - 53" → "$y = 7x - 53$"
  - "x squared plus 4" → "$x^{2} + 4$"
  - "RS = sqrt(133)" → "$RS = \\sqrt{133}$"
- This applies to correct_answer (when numeric/symbolic) AND explanation.
- Plain English prose stays unwrapped — only the math itself uses $...$.
- Do not output ASCII pseudo-math like 1/7, x^2, sqrt(x) — always use LaTeX.
- MONEY / CURRENCY: never write a bare dollar amount like $170 — a bare $ opens math mode and corrupts the line. Write "170 dollars" or escape the sign as "\\$170". Reserve $…$ for actual algebra only.

SELF-CONSISTENCY (MANDATORY):
End the explanation with a final line of EXACTLY this form:
  Final answer: X
where X is exactly the same value as the value you put in correct_answer (same letter for MCQ, same numeric/text value for SPR). Do not add extra punctuation, $...$ wrapping, or commentary on this final line. (Skip this trailer entirely when needs_drawing=true.)

UNDERLINED PORTION (CRITICAL for SAT R&W):
- SAT Reading & Writing has "function of the underlined portion" questions. The underlined run is wrapped in HTML <u>…</u> tags inside the question_text or choice text passed to you.
- Treat the contents of <u>…</u> as the specific span the question is asking about. The question is unsolvable without anchoring to that span — do not skip or ignore the tag.
- The <u> tags are markup, not part of the prose. Don't repeat them in your explanation; quote the underlined text in plain English instead (e.g. The underlined sentence "X" functions to …).

NEEDS_DRAWING (MANDATORY):
If the problem genuinely requires you to construct or sketch a figure from scratch — e.g. ruler-and-compass geometry construction, sketching a graph from an equation when no graph is provided, freehand drawing a triangle to scale — DO NOT guess an answer. Set needs_drawing=true, leave correct_answer as "", and put a one-sentence reason in explanation (e.g. "Requires constructing the angle bisector — please verify by hand."). The reviewer will solve and enter the answer manually.

This rule does NOT apply when the figure is already provided in the question image; in that case treat the figure as known and solve normally.

Return JSON only matching the schema. No prose outside the JSON.`;

export type SolvedAnswer = {
  correct_answer: string;
  explanation: string;
  /** Value parsed out of the explanation's "Final answer: X" line, if present. */
  explainedAnswer: string | null;
  /** True when the parsed final-answer line disagrees with correct_answer. */
  consistencyMismatch: boolean;
  /** Solver self-declared "I'd have to draw something to answer this." */
  needsDrawing: boolean;
};

/**
 * Extract the LAST occurrence of `Final answer: <value>` from an explanation.
 * Case-insensitive, tolerates leading/trailing whitespace and a trailing period.
 * Returns null if no such line exists.
 */
export function extractFinalAnswer(explanation: string): string | null {
  const re = /final\s*answer\s*:\s*([^\n\r]+)/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(explanation)) !== null) {
    last = match[1];
  }
  if (last === null) return null;
  // Trim whitespace, trailing period, and surrounding $ wrappers (in case the
  // model wrapped the value as math despite instructions).
  return last
    .trim()
    .replace(/\.+$/, "")
    .replace(/^\$+|\$+$/g, "")
    .trim();
}

/**
 * Fallback when the solver ignored the "Final answer: X" trailer instruction.
 * For MCQ questions we look for the last A/B/C/D letter that appears as a
 * standalone choice reference (e.g. "answer is C", "(C)", "option D"). For SPR
 * we look for the last numeric/fraction value in the explanation.
 *
 * This is a best-effort heuristic — never returns garbage like "the". Returns
 * null when no plausible value is found, in which case consistencyMismatch
 * stays false (we can't accuse the solver of disagreeing with itself if we
 * can't even parse what it argued for).
 */
export function inferImpliedAnswer(
  explanation: string,
  isMultipleChoice: boolean,
): string | null {
  if (isMultipleChoice) {
    // Look for letters in contexts that strongly imply "this is the answer":
    //   "answer is C", "answer: B", "the correct option is A", "(D)", "choice C"
    const re =
      /(?:answer\s*(?:is|=|:)\s*|correct\s*(?:option|choice|answer)\s*(?:is\s*)?|option\s+|choice\s+|\(\s*)([ABCD])\b/gi;
    let m: RegExpExecArray | null;
    let last: string | null = null;
    while ((m = re.exec(explanation)) !== null) {
      last = m[1].toUpperCase();
    }
    return last;
  }
  // SPR: last numeric token (integer, decimal, or simple fraction a/b).
  const re = /(-?\d+(?:\.\d+)?(?:\/\d+)?)/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(explanation)) !== null) {
    last = m[1];
  }
  return last;
}

/** Loose equality for answer comparison: case-insensitive, strips whitespace. */
function answersAgree(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
  return norm(a) === norm(b);
}

interface ImageInput {
  urls: string[];
}

/**
 * Fetch an image URL and convert it to a base64 string suitable for
 * Anthropic's image content block. Returns null on failure.
 *
 * Vercel Blob URLs at *.blob.vercel-storage.com require a bearer token when
 * the underlying store is provisioned as private — extract-images falls back
 * to access:"private" when the public-access mode is rejected, so we mirror
 * that here.
 */
export async function fetchImageAsBase64(
  url: string,
): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const headers: Record<string, string> = {};
    const token =
      process.env.PUBLIC_BLOB_READ_WRITE_TOKEN ??
      process.env.BLOB_READ_WRITE_TOKEN;
    if (token && url.includes(".blob.vercel-storage.com")) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[solve-question] image fetch failed (${res.status}): ${url}`);
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "image/png";
    const buffer = await res.arrayBuffer();
    return {
      base64: Buffer.from(buffer).toString("base64"),
      mediaType: contentType,
    };
  } catch (err) {
    console.warn(`[solve-question] image fetch error for ${url}:`, err);
    return null;
  }
}

function buildPromptText(q: ParsedQuestion, section: string): string {
  const choicesText =
    q.choices.length > 0
      ? `\n\nChoices:\n${q.choices.map((c) => `${c.label}. ${c.text}`).join("\n")}`
      : "";
  const typeText =
    q.question_type === "Student Produced Response"
      ? "Student Produced Response — give the exact value to grid in (no units)."
      : "Multiple Choice — give the single correct letter A/B/C/D.";

  return `Section: ${section}
Question type: ${typeText}

Question:
${q.question_text}${choicesText}

${q.image_regions && q.image_regions.length > 0 ? "Refer to the attached image(s) for the visual." : ""}

Solve it. Provide correct_answer, a clear step-by-step explanation, and your confidence (0..1).`;
}

/**
 * Solve a single question. Pulled out of the main loop so the solver can
 * dispatch them in parallel chunks. Returns null on failure (logged + recorded
 * via logUsage); never throws.
 */
async function solveOneQuestion(
  q: ParsedQuestion,
  imagesByQuestion: Map<number, { urls: string[] }>,
  callerUserId?: string,
): Promise<SolvedAnswer | null> {
  // Section is inferred from the parser's `domain` classification:
  // R&W domains start with one of the Reading & Writing sets.
  const rwDomains = new Set([
    "Information and Ideas",
    "Craft and Structure",
    "Expression of Ideas",
    "Standard English Conventions",
  ]);
  const section = rwDomains.has(q.domain) ? "Reading & Writing" : "Math";

  // Build content blocks. Anthropic expects base64 image data, so fetch
  // any image URLs from the just-uploaded image extraction pass.
  //
  // R&W solver runs text-only: the section is passage-driven, the cropper
  // is skipped upstream so urls would be empty anyway, and avoiding the
  // per-image fetch keeps long R&W modules well inside the function budget.
  const imageRefs: ImageInput | undefined =
    section === "Reading & Writing"
      ? undefined
      : imagesByQuestion.get(q.original_question_number);
  const imageBlocks: Array<{
    type: "image";
    image: string;
    mediaType: string;
  }> = [];
  if (imageRefs && imageRefs.urls.length > 0) {
    for (const url of imageRefs.urls) {
      const fetched = await fetchImageAsBase64(url);
      if (fetched) {
        imageBlocks.push({
          type: "image",
          image: fetched.base64,
          mediaType: fetched.mediaType,
        });
      }
    }
  }

  const promptText = buildPromptText(q, section);

  try {
    const result = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: SolverSchema,
      system: SOLVER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            { type: "text", text: promptText },
          ],
        },
      ],
      // Headroom so a long worked solution never gets clipped mid-sentence.
      maxOutputTokens: 3000,
      maxRetries: 2,
    });

    const declared = result.object.correct_answer;
    let explanationText = result.object.explanation;
    // Primary: parse the "Final answer: X" trailer line we asked for.
    // Fallback: if the model ignored that instruction, infer the implied
    // answer from prose ("answer is C", "(D)", or last numeric for SPR).
    // Without the fallback the regex always misses → consistencyMismatch
    // is always false → no protection against the Q10-style self-contradiction
    // we just shipped this fix for.
    const isMcq = q.question_type === "Multiple Choice";
    const trailerAnswer = extractFinalAnswer(explanationText);
    const inferredAnswer = trailerAnswer ?? inferImpliedAnswer(explanationText, isMcq);
    const explainedAnswer = inferredAnswer;
    const consistencyMismatch =
      inferredAnswer !== null && !answersAgree(declared, inferredAnswer);

    if (consistencyMismatch) {
      console.warn(
        `[solve-question] q${q.original_question_number}: solver self-inconsistent (declared "${declared}", explained "${inferredAnswer}", source=${trailerAnswer ? "trailer" : "inferred"})`,
      );
      explanationText =
        explanationText.trimEnd() +
        "\n\n(⚠️ Solver self-inconsistent — flagged for review.)";
    }

    // Audit log: every solver call's outcome so we can spot patterns later.
    console.log(
      `[solve-question] q${q.original_question_number} section=${section} hadImages=${imageBlocks.length > 0} declared=${declared} explained=${inferredAnswer ?? "<none>"} mismatch=${consistencyMismatch} confidence=${result.object.confidence}`,
    );

    const usage = result.usage;
    if (usage) {
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      // Claude Sonnet 4.6: $3/M input, $15/M output
      const costCents = Math.round(
        (inputTokens / 1_000_000) * 300 + (outputTokens / 1_000_000) * 1500,
      );
      await logUsage({
        userId: callerUserId,
        route: "solve-question",
        tokensInput: inputTokens,
        tokensOutput: outputTokens,
        model: "claude-sonnet-4-6",
        costCents,
        metadata: {
          question_number: q.original_question_number,
          section,
          confidence: result.object.confidence,
          had_images: imageBlocks.length > 0,
        },
      });
    }

    return {
      correct_answer: declared,
      explanation: explanationText,
      explainedAnswer,
      consistencyMismatch,
      needsDrawing: Boolean(result.object.needs_drawing),
    };
  } catch (err) {
    console.error(
      `[solve-question] solver failed for q${q.original_question_number}:`,
      err,
    );
    await logUsage({
      userId: callerUserId,
      route: "solve-question",
      tokensInput: 0,
      tokensOutput: 0,
      model: "claude-sonnet-4-6",
      costCents: 0,
      metadata: {
        question_number: q.original_question_number,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

/**
 * Solve every question that's missing a correct_answer or explanation.
 * Returns a Map keyed by original_question_number → { correct_answer, explanation }.
 *
 * Chunked parallel execution: 5 questions per chunk run concurrently, each
 * chunk waits for all to settle before the next dispatches. This keeps us
 * well under Anthropic's tier-2 ~1000 RPM ceiling while cutting wall-clock
 * time by ~5x for long modules (e.g. 22-question R&W: 143s → ~30s).
 */
export async function solveQuestions(
  questions: ParsedQuestion[],
  imagesByQuestion: Map<number, { urls: string[] }>,
  callerUserId?: string,
): Promise<Map<number, SolvedAnswer>> {
  const out = new Map<number, SolvedAnswer>();
  const pending = questions.filter((q) => !(q.correct_answer && q.explanation));

  const CHUNK_SIZE = 5;
  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map((q) => solveOneQuestion(q, imagesByQuestion, callerUserId)),
    );
    for (let j = 0; j < chunk.length; j++) {
      const solved = results[j];
      if (solved) out.set(chunk[j].original_question_number, solved);
    }
  }

  return out;
}

/**
 * Background-solve helper: solve all pending questions and UPDATE each
 * question row in Supabase as the answer arrives. Used by the parse route's
 * `after()` callback so the UI can show questions immediately while answers
 * stream in.
 *
 * Per-question failures are non-fatal — the row keeps its initial null
 * answer/explanation and the parsing_notes already say "Pending AI answer".
 */
export async function solveQuestionsAndPersist(
  questions: ParsedQuestion[],
  imagesByQuestion: Map<number, { urls: string[] }>,
  moduleId: string,
  db: DbClient,
  callerUserId?: string,
): Promise<{ solved: number; failed: number }> {
  const pending = questions.filter((q) => !(q.correct_answer && q.explanation));
  const CHUNK_SIZE = 5;
  let solvedCount = 0;
  let failedCount = 0;

  // Gate A: track which questions had has_image=true but no image_urls.
  // The solver still runs (so admins get an AI guess to verify against),
  // but the result is flagged Needs Review so the missing-figure
  // hallucination doesn't get treated as authoritative.
  const blindOnImage = new Set<number>();
  for (const q of pending) {
    if (q.has_image) {
      const imgs = imagesByQuestion.get(q.original_question_number);
      if (!imgs || imgs.urls.length === 0) {
        blindOnImage.add(q.original_question_number);
      }
    }
  }

  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map((q) => solveOneQuestion(q, imagesByQuestion, callerUserId)),
    );
    // Persist each chunk as it completes so partial progress is visible
    // in the UI even if the function later times out.
    await Promise.all(
      chunk.map(async (q, idx) => {
        const solved = results[idx];
        if (!solved) {
          failedCount++;
          return;
        }
        solvedCount++;

        // Persist the solver's best guess so admins always have an AI
        // answer to verify against — don't null it out — but flag the
        // row Needs Review whenever any of these conditions trips:
        //
        //   A) the question had has_image=true and we ran the solver
        //      blind (cropper failed to upload any image),
        //   B) SPR (grid-in) returned a letter A/B/C/D — wrong format,
        //      but the explanation still hints at the right numeric
        //      answer the admin can read out,
        //   C) solver self-contradicts (declared vs explained mismatch).
        //
        // For B specifically: replace the bogus letter with the parsed
        // explainedAnswer if we managed to extract one (e.g. "the
        // answer is 22/3"). Otherwise keep the letter so admins can see
        // the model's leaked MCQ reasoning when they review.
        const declared = solved.correct_answer ?? "";
        const isSPR = q.question_type === "Student Produced Response";
        const sprLetterAnswer = isSPR && /^[A-D]$/i.test(declared.trim());
        const blindImage = blindOnImage.has(q.original_question_number);
        const needsDrawing = Boolean(solved.needsDrawing);

        let savedAnswer = solved.correct_answer;
        if (sprLetterAnswer && solved.explainedAnswer && !/^[A-D]$/i.test(solved.explainedAnswer.trim())) {
          savedAnswer = solved.explainedAnswer;
        }
        // Solver self-contradiction (declared answer field ≠ the answer its
        // own explanation works out to): the structured `correct_answer` slot
        // is filled somewhat independently of the reasoning and is the less
        // reliable of the two — the worked explanation is the actual solve.
        // Trust the explained answer so we never PERSIST a known-wrong declared
        // value (e.g. explanation computes 29 but the field said 19). Still
        // flagged Needs Review below for a human glance. SPR substitution and
        // needs-drawing (handled just above/below) take precedence.
        else if (solved.consistencyMismatch && solved.explainedAnswer) {
          savedAnswer = solved.explainedAnswer;
        }
        // needs_drawing → solver explicitly refused to guess; null the
        // answer out so the admin sees an empty field and the verbatim
        // "requires drawing" explanation. The Needs Review status below
        // surfaces it in the review queue.
        if (needsDrawing) {
          savedAnswer = null as unknown as string;
        }

        const needsReview =
          solved.consistencyMismatch || sprLetterAnswer || blindImage || needsDrawing;

        const noteParts: string[] = [];
        if (needsDrawing) {
          noteParts.push(
            "Solver said this problem requires drawing/constructing a figure — no answer generated. Please solve and enter manually.",
          );
        }
        if (blindImage) {
          noteParts.push(
            "has_image=true but image not uploaded — solver answered without the figure. Please verify against the PDF.",
          );
        }
        if (sprLetterAnswer) {
          noteParts.push(
            `Solver returned letter "${declared}" on a Student Produced Response${savedAnswer !== declared ? `; substituted with explained value "${savedAnswer}"` : ""}. Please verify.`,
          );
        }
        if (solved.consistencyMismatch) {
          noteParts.push(
            `Solver self-contradicted (declared ${declared}, explained ${solved.explainedAnswer ?? "<unparsed>"}); stored the explained answer${savedAnswer !== declared ? ` "${savedAnswer}"` : ""}. Please verify.`,
          );
        }
        const notes =
          noteParts.length > 0
            ? noteParts.join(" ")
            : "Answer & explanation generated by AI solver — please verify";
        const status = needsReview ? "Needs Review" : "Draft";
        const { error } = await db
          .from("questions")
          .update({
            correct_answer: savedAnswer,
            explanation: solved.explanation,
            parsing_notes: notes,
            parsing_status: status,
          })
          .eq("module_id", moduleId)
          .eq("original_question_number", q.original_question_number);
        if (error) {
          console.error(
            `[solve-question] failed to persist q${q.original_question_number}:`,
            error,
          );
        }
      }),
    );
  }

  return { solved: solvedCount, failed: failedCount };
}

// ── Explain toward the official answer ───────────────────────────────
//
// When a question already has an authoritative answer (from the official
// answer key), we should NOT let the solver guess independently and then flag
// disagreements — that floods the review queue with false alarms whose only
// problem is that the (weaker) independent solve differed from the correct key.
// Instead we generate an explanation CONDITIONED on the official answer: the
// stored answer stays correct and the explanation justifies it, so the two
// always agree. Rows with a real non-answer defect (blind figure, or a note
// naming a figure/choices/latex problem) stay Needs Review; the rest are safe
// to Approve. Shared by the parse pipeline and the /api/cron/explain-official
// backfill endpoint.

const ExplainOfficialSchema = z.object({
  explanation: z
    .string()
    .describe(
      "A clear, complete, self-contained explanation of WHY the given correct answer is correct, and briefly why the others are wrong. Never contradict it or name a different answer.",
    ),
});

const EXPLAIN_OFFICIAL_SYSTEM = `You are an expert SAT tutor writing the final answer explanation a student reads after a test. You are GIVEN the correct answer — it comes from the official College Board answer key and is authoritative and final.

Write ONLY the explanation itself, starting immediately with the reasoning. These are ABSOLUTELY FORBIDDEN and corrupt the explanation:
- Any meta-narration or process talk: "Wait", "Actually", "Let me", "re-examine", "reconsider", "re-reading", "hold on", "I must", "as required", "the instructions", "the answer key says", "the stored answer".
- Questioning, hedging, or second-guessing the answer — state the reasoning as settled fact.
- Ever naming a different letter/value as the answer.

Explain clearly why the given answer is correct and briefly why the other choices are wrong.

FORMATTING — this renders through a Markdown + KaTeX pipeline where $…$ means math mode:
- MONEY / CURRENCY: never write a bare dollar amount like $170 — a bare $ opens math mode and corrupts the rest of the line. Write money as "170 dollars" or with an escaped sign "\\$170". This applies to every dollar amount.
- Use $…$ ONLY for actual algebra/equations (e.g. $x \\leq 300$), and make sure every $ you open you also close.`;

// Deterministic safety net for answer explanations: strip any LEADING
// sentences that are process narration ("Wait — let me re-examine…",
// "re-reading the instructions…") rather than actual explanation, in case
// the model still slips past the prompt. Only removes leading chatter, so
// a clean explanation passes through untouched.
export function stripMetaNarration(raw: string | null | undefined): string {
  if (!raw) return raw ?? "";
  const META = /\b(wait|let me|re-?examine|reconsider|re-?reading|hold on|i must|i need to|as required|the instructions|answer key says|second-guess|let me construct|let me write|let me carefully|the correct answer given|the stored (correct )?answer)\b/i;
  const parts = raw.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) ?? [raw];
  const kept: string[] = [];
  let started = false;
  for (const p of parts) {
    if (!started && META.test(p)) continue;
    started = true;
    kept.push(p);
  }
  let out = kept.join("").trim();
  out = out.replace(/^(wait|actually|hmm|okay|ok)[\s,—-]+/i, "").trim();
  return out || raw;
}

const EXPLAIN_HARD_ISSUE =
  /missing figure|needs? a figure|no figure|figure shown|based on the graph|image not uploaded|requires drawing|LaTeX|garbled|choices/i;

interface ExplainRow {
  id: string;
  original_question_number: number;
  question_text: string | null;
  choices: unknown;
  correct_answer: string | null;
  official_answer: string | null;
  parsing_notes: string | null;
  has_image: boolean | null;
  image_urls: unknown;
}

/**
 * For every question in the module that has an official answer, (re)write its
 * explanation to justify that answer and set correct_answer to it. Approves
 * rows with no other defect; leaves figure/choices ones Needs Review.
 */
export async function explainOfficialAndPersist(
  moduleId: string,
  db: DbClient,
  callerUserId?: string,
): Promise<{ rewrote: number; approved: number; keptReview: number; skipped: number }> {
  const { data } = await db
    .from("questions")
    .select(
      "id, original_question_number, question_text, choices, correct_answer, official_answer, parsing_notes, has_image, image_urls",
    )
    .eq("module_id", moduleId)
    .not("official_answer", "is", null);
  const rows = (data ?? []) as ExplainRow[];

  let rewrote = 0, approved = 0, keptReview = 0, skipped = 0;
  const CHUNK = 5;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (q) => {
        const ans = q.official_answer || q.correct_answer;
        if (!ans) { skipped++; return; }
        const ch = Array.isArray(q.choices)
          ? (q.choices as unknown[])
              .map((c) => (typeof c === "string" ? c : `${(c as { label?: string }).label}) ${(c as { text?: string }).text}`))
              .join("\n")
          : "";
        try {
          const res = await generateObject({
            model: anthropic("claude-sonnet-4-6"),
            schema: ExplainOfficialSchema,
            system: EXPLAIN_OFFICIAL_SYSTEM,
            maxOutputTokens: 3000,
            maxRetries: 3,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Question ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${ch}\n\nThe correct answer is: ${ans}\n\nExplain why ${ans} is correct.`,
                  },
                ],
              },
            ],
          });
          rewrote++;
          const blindFigure = !!q.has_image && !(Array.isArray(q.image_urls) && q.image_urls.length > 0);
          const keep = EXPLAIN_HARD_ISSUE.test(q.parsing_notes || "") || blindFigure;
          if (keep) keptReview++; else approved++;
          const usage = res.usage;
          if (usage) {
            const inTok = usage.inputTokens ?? 0;
            const outTok = usage.outputTokens ?? 0;
            await logUsage({
              userId: callerUserId,
              route: "explain-official",
              tokensInput: inTok,
              tokensOutput: outTok,
              model: "claude-sonnet-4-6",
              costCents: Math.round((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500),
              metadata: { question_number: q.original_question_number },
            });
          }
          await db
            .from("questions")
            .update({
              correct_answer: ans,
              explanation: stripMetaNarration(res.object.explanation),
              parsing_status: keep ? "Needs Review" : "Approved",
              parsing_notes: keep
                ? "Explanation matches official answer; still needs review (figure/choices)"
                : "Answer = official key; explanation matches (verified)",
              updated_at: new Date().toISOString(),
            })
            .eq("id", q.id);
        } catch (e) {
          skipped++;
          console.error(`[explain-official] q${q.original_question_number}:`, e instanceof Error ? e.message : e);
        }
      }),
    );
  }
  console.log(
    `[explain-official] module=${moduleId} rewrote=${rewrote} approved=${approved} keptReview=${keptReview} skipped=${skipped}`,
  );
  return { rewrote, approved, keptReview, skipped };
}

// ── Truncated-explanation guard ──────────────────────────────────────
// A generated explanation occasionally gets clipped (token cap, model stop)
// and ends mid-sentence. Detect that and regenerate it complete.
export function looksTruncated(ex: string | null): boolean {
  if (!ex) return false;
  const t = ex.trim();
  if (t.length < 25) return false; // too-short is a different (empty) problem
  if (/Final answer\s*:\s*\S+$/i.test(t)) return false; // ends with the answer trailer
  // Clean endings: sentence punctuation, a closing bracket/quote, $ or %, or a
  // number (math answers often end on a value). Anything else = mid-sentence.
  return !/[.!?)\]$%”"'’]$/.test(t) && !/\d$/.test(t);
}

/**
 * Find questions in a module whose explanation looks truncated and regenerate
 * a complete one — toward the official answer when there is one, otherwise
 * toward the stored answer. No-op for rows without a usable answer.
 */
export async function regenerateTruncatedExplanations(
  moduleId: string,
  db: DbClient,
  callerUserId?: string,
): Promise<{ checked: number; regenerated: number }> {
  const { data } = await db
    .from("questions")
    .select("id, original_question_number, question_text, choices, correct_answer, official_answer, explanation")
    .eq("module_id", moduleId);
  const rows = (data ?? []) as {
    id: string;
    original_question_number: number;
    question_text: string | null;
    choices: unknown;
    correct_answer: string | null;
    official_answer: string | null;
    explanation: string | null;
  }[];
  const targets = rows.filter((r) => looksTruncated(r.explanation));
  let regenerated = 0;
  const CHUNK = 5;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (q) => {
        const ans = q.official_answer || q.correct_answer;
        if (!ans) return;
        const ch = Array.isArray(q.choices)
          ? (q.choices as unknown[]).map((c) => (typeof c === "string" ? c : `${(c as { label?: string }).label}) ${(c as { text?: string }).text}`)).join("\n")
          : "";
        try {
          const res = await generateObject({
            model: anthropic("claude-sonnet-4-6"),
            schema: ExplainOfficialSchema,
            system: EXPLAIN_OFFICIAL_SYSTEM,
            maxOutputTokens: 3000,
            maxRetries: 2,
            messages: [{ role: "user", content: [{ type: "text", text: `Question ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${ch}\n\nThe correct answer is: ${ans}\n\nWrite a COMPLETE explanation of why ${ans} is correct — do not cut off.` }] }],
          });
          if (!looksTruncated(res.object.explanation)) {
            regenerated++;
            await db.from("questions").update({ correct_answer: ans, explanation: stripMetaNarration(res.object.explanation), updated_at: new Date().toISOString() }).eq("id", q.id);
          }
        } catch (e) {
          console.error(`[truncation-guard] q${q.original_question_number}:`, e instanceof Error ? e.message : e);
        }
      }),
    );
  }
  console.log(`[truncation-guard] module=${moduleId} checked=${targets.length} regenerated=${regenerated}`);
  return { checked: targets.length, regenerated };
}

/**
 * Regenerate ONE question's explanation so it justifies `answer` (and set
 * correct_answer to it). Used when a reviewer picks/changes the answer so the
 * explanation can never contradict the stored answer. Returns the new
 * explanation, or null on failure (leaves the row untouched).
 */
export async function explainOneAnswer(
  questionId: string,
  answer: string,
  db: DbClient,
  callerUserId?: string,
): Promise<string | null> {
  const { data: q } = await db
    .from("questions")
    .select("id, original_question_number, question_text, choices")
    .eq("id", questionId)
    .maybeSingle();
  if (!q) return null;
  const ch = Array.isArray(q.choices)
    ? (q.choices as unknown[]).map((c) => (typeof c === "string" ? c : `${(c as { label?: string }).label}) ${(c as { text?: string }).text}`)).join("\n")
    : "";
  try {
    const res = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: ExplainOfficialSchema,
      system: EXPLAIN_OFFICIAL_SYSTEM,
      maxOutputTokens: 3000,
      maxRetries: 2,
      messages: [{ role: "user", content: [{ type: "text", text: `Question ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${ch}\n\nThe correct answer is: ${answer}\n\nWrite a COMPLETE explanation of why ${answer} is correct.` }] }],
    });
    const usage = res.usage;
    if (usage) {
      const inTok = usage.inputTokens ?? 0, outTok = usage.outputTokens ?? 0;
      await logUsage({ userId: callerUserId, route: "explain-one", tokensInput: inTok, tokensOutput: outTok, model: "claude-sonnet-4-6", costCents: Math.round((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500), metadata: { question_id: questionId } });
    }
    const cleaned = stripMetaNarration(res.object.explanation);
    await db.from("questions").update({ correct_answer: answer, explanation: cleaned, updated_at: new Date().toISOString() }).eq("id", questionId);
    return cleaned;
  } catch (e) {
    console.error(`[explain-one] ${questionId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}
