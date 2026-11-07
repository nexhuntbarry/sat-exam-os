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
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { ParsedQuestion } from "./parse-pdf";
import { logUsage, QUOTE_RULE } from "./parse-pdf";
import type { getServiceClient } from "@/lib/supabase";
import { findParsePlaceholder, placeholderNote, stemFigureMissing } from "@/lib/parse-guards";
import { applyLiveHold, liveQuestionIds, type LiveHoldRow } from "@/lib/live-questions";
import { answersMatch } from "@/lib/grade-submission";
import {
  SPR_TYPE,
  answersAgreeForQuestion,
  applyRounding,
  checkComputedAnswer,
  keyFormNote,
  keyTypeProblem,
  roundingInstruction,
  sprValue,
  withSprAnswerLine,
  type ComputedAnswerCheck,
} from "@/lib/answer-key";
import { keyDoubtNote } from "@/lib/key-doubt";
import { parseBlobUrl } from "@/lib/blob-url";
import { highResFigure } from "@/lib/figure-hires";
import { keyLetters } from "@/lib/explanation-consistency";

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
  answer_expression: z
    .string()
    .describe(
      "Student Produced Response only: the final computation as a plain arithmetic expression (Python/JS style: numbers, + - * / ** ( ), sqrt(), abs(), pi) whose value is the answer BEFORE any rounding the question asks for — e.g. \"(3*412 + 5)/5\" or \"2*sqrt(3)\". No variables, units, words or $. Empty string for Multiple Choice.",
    ),
  check_equation: z
    .string()
    .describe(
      "Student Produced Response only, optional: one equation from the problem that the answer must satisfy, with `ans` standing for the answer, e.g. \"3*ans + 7 == 31\". Empty string when there is none or for Multiple Choice.",
    ),
  confidence: z.number().describe("Solver self-confidence between 0 and 1"),
  needs_drawing: z
    .boolean()
    .describe(
      "Set to true when reliably solving the problem REQUIRES physically constructing or drawing a figure (e.g. ruler-and-compass geometry construction, free-body diagram, or sketching a graph from scratch when no figure is provided). In that case leave correct_answer as an empty string and put the reason in explanation. Don't set this for problems that merely refer to a figure already shown — those go through the regular image pipeline.",
    ),
});

/**
 * Fill-in answers: the model writes the arithmetic, code evaluates it
 * (lib/math/safe-eval) and applies the question's rounding (lib/answer-key).
 * Shared by the pipeline solver, consensus solve and the review page's
 * "AI suggestion".
 */
export const SPR_COMPUTATION_RULE = `STUDENT PRODUCED RESPONSE — ARITHMETIC IS CHECKED IN CODE:
- Put the final computation in answer_expression as a plain arithmetic expression (numbers, + - * / ** ( ), sqrt(), abs(), pi). It is evaluated by a program, so never do long arithmetic in your head and never pre-round inside it.
- Write the UNROUNDED value's expression; if the question says "round to the nearest tenth / whole number / …", the program applies that rounding. Still give your rounded answer in correct_answer.
- When the problem gives an equation the answer must satisfy, put it in check_equation with ans for the answer (e.g. 3*ans + 7 == 31); the program plugs your answer back in.
- The answer is a number in SAT grid form: an integer, a decimal or a fraction such as 7/2, optional leading minus; at most 5 characters (6 with the minus); no %, $, commas or units. Never a letter A–D.
- Official entry rules: give the EXACT value when it fits (prefer the fraction 2/3 over 0.6667); a fraction that doesn't fit becomes a decimal that fills all 5 characters; no mixed numbers (7/2, not 3 1/2). When the question asks for a rounding ("nearest tenth"), the rounded value is the answer.
- If the question has MORE THAN ONE correct answer (e.g. x = 5 or x = -13), put EVERY correct answer in correct_answer separated by " or " (e.g. "5 or -13"); answer_expression gives any one of them.`;

const SOLVER_SYSTEM_PROMPT = `You are an expert SAT tutor who solves SAT problems for the official answer key.

Solve the supplied SAT question rigorously. For Multiple Choice questions, identify the single correct option (A/B/C/D). For Student Produced Response questions, give the exact answer the student should grid in (decimal or fraction; no units).

${SPR_COMPUTATION_RULE}

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

${QUOTE_RULE}

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

/**
 * Graph / figure questions: read exact points, fit, verify, transform — never
 * estimate by eye ([Test #13] L Test 1 Math M2 Q9: the graph of y = 2f(x) − 3
 * through (0,−3), (1,−1), (4,1), (9,3) was read as 7, 2 and 3; the answer is 4).
 */
export const FIGURE_READ_RULE = `FIGURE / GRAPH QUESTIONS — READ, DON'T ESTIMATE:
1. First list the EXACT points the graph passes through: where the curve or line crosses grid-line intersections, plus labelled points, intercepts and the maximum/minimum. Use a high-resolution image when one is attached. Never estimate a value by eye between grid lines.
2. Fit the function from those points (line through two points, vertex form, √x, exponential …) and check that the fitted function reproduces EVERY listed point. If one doesn't fit, re-read the points before going on.
3. Apply any transformation the question states BEFORE reading off the answer (e.g. the graph shows y = 2f(x) − 3, so f(x) = (y + 3)/2).
4. Only then compute the answer.`;

export type SolvedAnswer = {
  correct_answer: string;
  explanation: string;
  /** Value parsed out of the explanation's "Final answer: X" line, if present. */
  explainedAnswer: string | null;
  /** True when the parsed final-answer line disagrees with correct_answer. */
  consistencyMismatch: boolean;
  /** Solver self-declared "I'd have to draw something to answer this." */
  needsDrawing: boolean;
  /** True when the explanation still looks truncated after one retry. */
  truncatedExplanation: boolean;
  /** Fill-in only: the code-evaluated computation (null when not a fill-in). */
  computed: ComputedAnswerCheck | null;
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
  // Fill-in explanations end with "Answer: 2/3; .6666, … also accepted."
  // (lib/answer-key withSprAnswerLine), which replaces the trailer.
  if (last === null) {
    const m = explanation.match(/(?:^|\n)[ \t]*Answer\s*:\s*([^;\n\r]+)(?:;[^\n]*)?\s*$/);
    if (m) last = m[1];
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
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function fetchImageAsBase64(
  url: string,
): Promise<{ base64: string; mediaType: string } | null> {
  // Only stored figures on Vercel Blob are fetched (no other host, no
  // http), so a caller-supplied URL can't make the server fetch internal
  // addresses or receive the Blob token.
  const parsed = parseBlobUrl(url);
  if (!parsed) {
    console.warn(`[solve-question] image URL refused (not an https Vercel Blob URL): ${String(url).slice(0, 200)}`);
    return null;
  }
  try {
    // Figures live in more than one Blob store, each with its own token; a
    // token from the other store gets 403, so try each (as fetchPdfAsBase64).
    const tokens = [process.env.PUBLIC_BLOB_READ_WRITE_TOKEN, process.env.BLOB_READ_WRITE_TOKEN].filter(
      (t): t is string => Boolean(t),
    );
    let res: Response | null = null;
    for (const token of tokens.length > 0 ? tokens : [undefined]) {
      res = await fetch(parsed.href, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
      });
      if (res.status !== 401 && res.status !== 403) break;
      await res.body?.cancel().catch(() => {});
    }
    if (!res || !res.ok || !res.body) {
      console.warn(`[solve-question] image fetch failed (${res?.status}): ${url}`);
      return null;
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) {
      console.warn(`[solve-question] image too large (${declared} bytes): ${url}`);
      await res.body.cancel().catch(() => {});
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "image/png";
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        console.warn(`[solve-question] image exceeded ${MAX_IMAGE_BYTES} bytes: ${url}`);
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    return {
      base64: Buffer.concat(parts).toString("base64"),
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
      ? `\n\nChoices:\n${q.choices.map((c) => `${c.label}. ${c.text || (c.image_url ? `(graph — see the attached image labelled "Choice ${c.label}")` : "")}`).join("\n")}`
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
  const imageBlocks: Array<
    | { type: "image"; image: string; mediaType: string }
    | { type: "text"; text: string }
  > = [];
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
  // Graph answer choices (any section): the image IS the choice, so the
  // solver always gets them, each labelled with its letter.
  for (const c of q.choices ?? []) {
    if (!c.image_url) continue;
    const fetched = await fetchImageAsBase64(c.image_url);
    if (fetched) {
      imageBlocks.push({ type: "text", text: `Choice ${c.label}:` });
      imageBlocks.push({ type: "image", image: fetched.base64, mediaType: fetched.mediaType });
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

    // Truncation guard: retry once if the explanation looks cut off.
    let truncatedExplanation = false;
    if (looksTruncated(explanationText)) {
      try {
        const retry = await generateObject({
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
          maxOutputTokens: 3000,
          maxRetries: 2,
        });
        if (!looksTruncated(retry.object.explanation)) {
          explanationText = retry.object.explanation;
        } else {
          truncatedExplanation = true;
          console.warn(`[solve-question] q${q.original_question_number}: explanation still truncated after retry`);
        }
      } catch {
        truncatedExplanation = true;
      }
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

    // Fill-in: evaluate the model's computation in code, apply the stem's
    // rounding in code, plug the value back in, and compare with both the
    // declared answer and the explanation's final answer.
    let computed: ComputedAnswerCheck | null = null;
    if (q.question_type === SPR_TYPE && !result.object.needs_drawing) {
      computed = checkComputedAnswer({
        declared,
        expression: result.object.answer_expression,
        checkEquation: result.object.check_equation,
        questionText: q.question_text,
      });
      if (!result.object.answer_expression?.trim()) {
        computed.problems.push("the solver gave no computation to check");
      }
      if (
        computed.answer &&
        explainedAnswer &&
        sprValue(explainedAnswer) !== null &&
        !answersAgreeForQuestion(explainedAnswer, computed.answer, q.question_text)
      ) {
        computed.problems.push(`the explanation ends with ${explainedAnswer} but the computation gives ${computed.answer}`);
      }
      if (computed.problems.length > 0) {
        console.warn(`[solve-question] q${q.original_question_number}: computed-answer check: ${computed.problems.join("; ")}`);
      }
    }

    return {
      correct_answer: declared,
      explanation: explanationText,
      explainedAnswer,
      consistencyMismatch,
      needsDrawing: Boolean(result.object.needs_drawing),
      truncatedExplanation,
      computed,
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
  // A row in a live test keeps Approved and its answer key
  // (lib/live-questions.ts) even when the solver would demote it.
  const { data: currentRows } = await db
    .from("questions")
    .select("id, original_question_number, parsing_status, parsing_notes, correct_answer")
    .eq("module_id", moduleId);
  const currentByNumber = new Map(
    ((currentRows ?? []) as (LiveHoldRow & { original_question_number: number })[]).map((r) => [r.original_question_number, r]),
  );
  const live = await liveQuestionIds(
    db,
    [...currentByNumber.values()].filter((r) => r.parsing_status === "Approved").map((r) => r.id),
  );

  const blindOnImage = new Set<number>();
  for (const q of pending) {
    // Choice graphs don't stand in for a figure the stem itself refers to.
    const imgs = imagesByQuestion.get(q.original_question_number);
    if (stemFigureMissing({ ...q, image_urls: imgs?.urls ?? [] })) {
      blindOnImage.add(q.original_question_number);
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
        // Fill-in: the key is the code-evaluated computation, rounded in code
        // as the stem asks — never the model's mental arithmetic. Any
        // disagreement (computation vs declared vs explanation, plug-back,
        // unreadable computation) → a person decides.
        const computed = solved.computed;
        if (!needsDrawing && computed?.answer) savedAnswer = computed.answer;
        const computeProblems = !needsDrawing && computed ? computed.problems : [];
        // The key to save must fit the type (accepted SPR form, A–D for MC).
        const keyProblem = needsDrawing
          ? null
          : keyTypeProblem({ question_type: q.question_type, correct_answer: savedAnswer, question_text: q.question_text, choices: q.choices });

        if (needsDrawing) {
          savedAnswer = null as unknown as string;
        }

        const cur = currentByNumber.get(q.original_question_number);
        const needsReview =
          solved.consistencyMismatch ||
          sprLetterAnswer ||
          blindImage ||
          needsDrawing ||
          solved.truncatedExplanation ||
          computeProblems.length > 0 ||
          !!keyProblem ||
          // A reason found at insert (e.g. choices moved across a page break) still stands.
          cur?.parsing_status === "Needs Review";

        const noteParts: string[] = [];
        // Keep the insert-time reasons (minus the placeholder and anything a
        // previous solver run wrote) so a re-solve doesn't erase why the row
        // is in review.
        const priorNotes = (cur?.parsing_notes ?? "")
          .split(/;\s*/)
          .map((s) => s.trim())
          .filter(
            (s) =>
              s &&
              s !== "Pending AI answer" &&
              !/^(Solver |Answer & explanation generated|has_image=true but|Needs review: computed-answer check|Needs review: answer key check|Needs review: the generated explanation looks cut off)/.test(s),
          );
        if (priorNotes.length > 0) noteParts.push(`${priorNotes.join("; ")};`);
        if (computeProblems.length > 0) {
          noteParts.push(
            `Needs review: computed-answer check disagrees — ${computeProblems.join(", ").replace(/;/g, ",")}; stored ${savedAnswer ?? "no answer"} (needs human, no majority vote).`,
          );
        }
        if (keyProblem) noteParts.push(`${keyFormNote(keyProblem)}`);
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
        if (solved.truncatedExplanation) {
          noteParts.push(TRUNCATION_NOTE);
        }
        const notes =
          noteParts.length > 0
            ? noteParts.join(" ")
            : "Answer & explanation generated by AI solver — please verify";
        const status = needsReview ? "Needs Review" : "Draft";
        let update: Record<string, unknown> = {
          correct_answer: savedAnswer,
          // Fill-in: end on the stored key and its other accepted entries.
          explanation:
            isSPR && savedAnswer && !keyProblem && !solved.consistencyMismatch
              ? withSprAnswerLine(solved.explanation, savedAnswer, q.question_text)
              : solved.explanation,
          parsing_notes: notes,
          parsing_status: status,
        };
        if (cur) update = applyLiveHold(cur, update, "Re-solved by the AI solver", live).update;
        const { error } = await db
          .from("questions")
          .update(update)
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


// ── Explanation output without JSON ─────────────────────────────────
// generateObject makes the model write the explanation inside a JSON string.
// Explanations quote words from the passage, and the model regularly types a
// bare straight " — which ends the JSON string and silently cuts the
// explanation (2026-11-07: Test #20 Aug 2024 ENG M1 Q27, even with
// QUOTE_RULE and curly-quoted input). So explanation calls ask for plain text
// in XML-style tags instead, which needs no escaping at all.
type TaggedField = "explanation" | "independent_answer" | "figure_values";

const TAG_HINTS: Record<TaggedField, string> = {
  independent_answer:
    "<independent_answer>Solve the question yourself first, IGNORING the given answer. Multiple Choice: the single letter A/B/C/D only. Student Produced Response: the value only (no units, no $). Leave it empty if it cannot be determined.</independent_answer>",
  explanation:
    "<explanation>The complete explanation, as plain Markdown/KaTeX text.</explanation>",
  figure_values:
    "<figure_values>BEFORE solving: the exact points / values you read from the attached figure(s), one per line as \"label: value\" (e.g. \"grid point: (4, 1)\", \"y-intercept: (0, -3)\", \"minimum: (2, -4)\", \"row 2019: 145\"), then one line \"fit: <the function fitted from those points>\" when there is a curve or line. Only values the figure shows exactly.</figure_values>",
};

export function parseTagged<F extends TaggedField>(text: string, fields: readonly F[]): Record<F, string> | null {
  const out = {} as Record<F, string>;
  for (const f of fields) {
    const m = text.match(new RegExp(`<${f}>([\\s\\S]*?)</${f}>`));
    // An unclosed final tag means the output itself was cut (token limit):
    // keep what's there so the cut-off check can judge it.
    const open = m ? null : text.match(new RegExp(`<${f}>([\\s\\S]*)$`));
    if (!m && !open) return null;
    out[f] = (m ? m[1] : open![1]).trim();
  }
  return out;
}

async function generateTagged<F extends TaggedField>(
  params: { model: Parameters<typeof generateText>[0]["model"]; system: string; maxOutputTokens: number; maxRetries: number; messages: Parameters<typeof generateText>[0]["messages"] },
  fields: readonly F[],
): Promise<{ object: Record<F, string>; usage: Awaited<ReturnType<typeof generateText>>["usage"] }> {
  const res = await generateText({
    model: params.model,
    system: `${params.system}

OUTPUT FORMAT: reply with ONLY these tags, in this order, and nothing outside them:
${fields.map((f) => TAG_HINTS[f]).join("\n")}
Inside the tags write normal text — quotation marks need no escaping.`,
    maxOutputTokens: params.maxOutputTokens,
    maxRetries: params.maxRetries,
    messages: params.messages!,
  });
  const object = parseTagged(res.text, fields);
  if (!object) throw new Error("explanation output had no <explanation> tag");
  return { object, usage: res.usage };
}


const EXPLAIN_OFFICIAL_SYSTEM = `You are an expert SAT tutor writing the final answer explanation a student reads after a test. You are GIVEN the correct answer — it comes from the official College Board answer key and is authoritative and final.

Write ONLY the explanation itself, starting immediately with the reasoning. These are ABSOLUTELY FORBIDDEN and corrupt the explanation:
- Any meta-narration or process talk: "Wait", "Actually", "Let me", "re-examine", "reconsider", "re-reading", "hold on", "I must", "as required", "the instructions", "the answer key says", "the stored answer".
- Questioning, hedging, or second-guessing the answer — state the reasoning as settled fact.
- Ever naming a different letter/value as the answer.

Explain clearly why the given answer is correct and briefly why the other choices are wrong.

NO THINKING ALOUD: never interrupt or correct yourself in the text ("Wait —", "Hmm", "Actually, no", "let me check / re-check", "looking more carefully", "on closer inspection", "my mistake"), and never change your mind mid-explanation. (Words that belong to the question itself — "customers wait 5 minutes" — are fine.) Work it out before you write; the student sees only the final, settled reasoning. Never hedge about the answer ("approximately … or so", "probably").

FORMAT (always this order, 150–250 words, never more than 300):
1. Setup: one or two sentences on what the question asks and the given facts. For a question with a graph, figure or table image, first state the key values you read from it (intercepts, maximum/minimum, labelled points, table values) — and use exactly those values in the steps.
2. Steps: the solution, one short step per line.
3. Wrong choices (Multiple Choice): one short line for each other choice saying why it is wrong.
4. Last line, exactly: "Answer: X" (the letter, or the value for a fill-in question) — nothing after it.

FORMATTING — this renders through a Markdown + KaTeX pipeline where $…$ means math mode:
- MONEY / CURRENCY: never write a bare dollar amount like $170 — a bare $ opens math mode and corrupts the rest of the line. Write money as "170 dollars" or with an escaped sign "\\$170". This applies to every dollar amount.
- Use $…$ ONLY for actual algebra/equations (e.g. $x \\leq 300$), and make sure every $ you open you also close.

${QUOTE_RULE}`;

// Deterministic safety net for answer explanations: strip any LEADING
// sentences that are process narration ("Wait — let me re-examine…",
// "re-reading the instructions…") rather than actual explanation, in case
// the model still slips past the prompt. Only removes leading chatter, so
// a clean explanation passes through untouched.
export function stripMetaNarration(raw: string | null | undefined): string {
  if (!raw) return raw ?? "";
  // Narration only at the START of a sentence ("Wait —", "Let me …", "I need
  // to …"); "Customers wait, on average" or "the wait-time function" is
  // content. Prompt/meta talk counts anywhere.
  const META = /^\s*(?:wait\b(?!-)|let me\b|let's (?:re|double)|hmm+\b|hold on[,.!—–]|i must\b|i need to\b|re-?examin|reconsider|re-?reading)|\b(?:as required|the instructions|answer key says|second-guess|the correct answer given|the stored (?:correct )?answer)\b/i;
  const parts = raw.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) ?? [raw];
  const kept: string[] = [];
  let started = false;
  for (const p of parts) {
    if (!started && META.test(p)) continue;
    started = true;
    kept.push(p);
  }
  let out = kept.join("").trim();
  out = out.replace(/^(?:wait|actually|hmm+|okay|ok)\s*[,—–]\s*/i, "").trim();
  return out || raw;
}

const EXPLAIN_HARD_ISSUE =
  /missing figure|needs? a figure|no figure|figure shown|based on the graph|image not uploaded|requires drawing|LaTeX|garbled|choices|needs review:/i;

/**
 * explainOfficialAndPersist: may the regenerated explanation be saved (and
 * the row approved)? Only a draft written after a solve that never saw the
 * key agreed, and that passes every explanation check for the key
 * (`rejection` = lib/explanation-autofix draftRejection: cut off,
 * formatting / thinking aloud, another answer, numbers that don't add up).
 * Pure. null = save it; otherwise why not.
 */
export function officialDraftProblem(res: RegenExplanationResult, rejection: string | null): string | null {
  if (!res.ok) return res.kind === "cut_off" ? "the explanation came out cut off" : res.error;
  if (!res.agrees) return res.aiAnswer ? `solving it without the key, the AI got ${res.aiAnswer}` : "the AI's answer differs from the key";
  if (res.independent === false) return "the answer did not come from a solve that never saw the key";
  if (rejection) return `the new explanation failed its check: ${rejection}`;
  return null;
}

export const OFFICIAL_EXPLANATION_FAILED_PREFIX = "Needs review: no checked explanation for the official key";

interface ExplainRow {
  id: string;
  original_question_number: number;
  explanation?: string | null;
  question_text: string | null;
  choices: unknown;
  correct_answer: string | null;
  official_answer: string | null;
  parsing_notes: string | null;
  has_image: boolean | null;
  image_urls: unknown;
  question_type: string | null;
}

/**
 * For every question in the module that has an official answer, (re)write its
 * explanation to justify that answer and set correct_answer to it. The model
 * solves independently first; when its answer differs from the key the row
 * gets a key-doubt note (Needs Review) instead of an explanation that argues
 * the key. Approves rows with no other defect; leaves figure/choices/key ones
 * Needs Review (a live-test row stays Approved with [live-fix]).
 */
export async function explainOfficialAndPersist(
  moduleId: string,
  db: DbClient,
  callerUserId?: string,
): Promise<{ rewrote: number; approved: number; keptReview: number; skipped: number }> {
  const { data } = await db
    .from("questions")
    .select(
      "id, original_question_number, section, question_text, choices, correct_answer, official_answer, explanation, parsing_status, parsing_notes, has_image, image_urls, has_table, question_type",
    )
    .eq("module_id", moduleId)
    .not("official_answer", "is", null);
  // Loaded here, not at the top: lib/explanation-autofix imports this module.
  const { draftRejection } = await import("@/lib/explanation-autofix");
  const rows = (data ?? []) as (ExplainRow & { parsing_status: string | null })[];
  const live = await liveQuestionIds(db, rows.filter((r) => r.parsing_status === "Approved").map((r) => r.id));

  let rewrote = 0, approved = 0, keptReview = 0, skipped = 0;
  const CHUNK = 5;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (q) => {
        const ans = q.official_answer || q.correct_answer;
        if (!ans) { skipped++; return; }
        try {
          // Solve independently FIRST (independent_answer), then explain the
          // key. If the two disagree, the key gets a conflict note and goes to
          // a person — the explanation is NOT rewritten to justify a key the
          // AI can't reproduce (Math Module 001 Q17: the explanation argued 249).
          const res = await regenerateExplanation(
            {
              questionId: q.id,
              questionNumber: q.original_question_number,
              questionText: q.question_text ?? "",
              choices: q.choices,
              questionType: q.question_type,
              answer: ans,
              imageUrls: Array.isArray(q.image_urls) ? (q.image_urls as string[]) : null,
            },
            callerUserId,
            "explain-official",
          );
          // An API/schema failure says nothing about the question: skip the
          // row and leave its status and notes alone.
          if (!res.ok && res.kind !== "cut_off") {
            skipped++;
            console.warn(`[explain-official] q${q.original_question_number}: AI call failed; row left unchanged`);
            return;
          }
          const conflict = res.ok && !res.agrees && res.aiAnswer ? res.aiAnswer : null;
          const truncatedOfficial = !res.ok;
          // The draft is saved only when it passes every check for the key
          // and came after a solve that never saw the key.
          const asRow = { ...q, correct_answer: ans, explanation: q.explanation ?? null } as Parameters<typeof draftRejection>[0];
          const draftProblem = res.ok && !conflict ? officialDraftProblem(res, draftRejection(asRow, res.explanation)) : null;
          // The current text must also fit the key, or it goes (the re-parse
          // already nulled it for a changed key).
          const currentFits = !!(q.explanation ?? "").trim() && !draftRejection(asRow, q.explanation ?? "");
          const keyProblem = keyTypeProblem({ question_type: q.question_type, correct_answer: ans, question_text: q.question_text, choices: q.choices, official_answer: q.official_answer });
          if (truncatedOfficial) console.warn(`[explain-official] q${q.original_question_number}: explanation still cut off after retry`);
          const blindFigure = stemFigureMissing(q);
          const placeholder = findParsePlaceholder(q.question_text, q.choices);
          const keep =
            EXPLAIN_HARD_ISSUE.test(q.parsing_notes || "") ||
            blindFigure ||
            placeholder !== null ||
            truncatedOfficial ||
            !!conflict ||
            !!draftProblem ||
            !!keyProblem;
          if (keep) keptReview++; else approved++;
          const parts: string[] = [];
          if (keep && q.parsing_notes) parts.push(q.parsing_notes);
          if (placeholder && !(q.parsing_notes || "").includes("parser placeholder text")) parts.push(placeholderNote(placeholder));
          // Don't repeat a note the row already carries (re-runs).
          const addNote = (n: string) => {
            if (!(q.parsing_notes || "").includes(n) && !parts.includes(n)) parts.push(n);
          };
          if (truncatedOfficial) addNote(TRUNCATION_NOTE);
          if (conflict) {
            addNote(keyDoubtNote(ans, conflict, "solving it independently before writing the explanation gave a different answer, so the explanation was not rewritten"));
          }
          if (keyProblem) addNote(keyFormNote(keyProblem));
          if (draftProblem) addNote(`${OFFICIAL_EXPLANATION_FAILED_PREFIX} (${draftProblem.replace(/[;()]/g, ",").slice(0, 160)}) — write and check it by hand`);
          const update: Record<string, unknown> = {
            correct_answer: ans,
            parsing_status: keep ? "Needs Review" : "Approved",
            // Keep the original defect note on rows staying in review — it
            // names WHAT to fix (e.g. the PDF's real choices).
            parsing_notes: keep
              ? [...parts, ...(conflict || keyProblem || draftProblem ? [] : ["Explanation matches official answer; still needs review (figure/choices)"])].join("; ")
              : "Answer = official key; explanation matches (verified)",
            updated_at: new Date().toISOString(),
          };
          if (res.ok && !conflict && !draftProblem) {
            update.explanation = res.explanation;
            rewrote++;
          } else if (!currentFits) {
            // Never leave text that argues another answer behind the key.
            update.explanation = null;
          }
          const { update: held } = applyLiveHold(q, update, "Explanation rewritten toward the official answer", live);
          await db.from("questions").update(held).eq("id", q.id);
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
// A generated explanation occasionally gets clipped (token cap, model stop,
// or the structured-output straight-quote bug) and ends mid-sentence.
// Detect that and allow regeneration.
export const TRUNCATION_NOTE =
  "Needs review: the generated explanation looks cut off — regenerate or write it by hand.";

/**
 * Straight double quotes → typographic “ ” in text we SEND to the model.
 * The model copies quoted words from the question/choices; a straight " in
 * its JSON output ends the string and silently cuts the explanation
 * (2026-11-07: Test #20 Aug 2024 ENG M1 Q27, quoting "korrrr" / "hu lu").
 */
export function curlyQuotes(s: string): string {
  let open = true;
  return s.replace(/"/g, () => {
    const q = open ? "“" : "”";
    open = !open;
    return q;
  });
}

/** Does this text have more opening than closing typographic quotes (after curlyQuotes)? */
function hasUnbalancedQuotes(s: string): boolean {
  const t = curlyQuotes(s);
  return (t.match(/“/g) ?? []).length !== (t.match(/”/g) ?? []).length;
}

/**
 * `source` = the question text + choices. When the source itself has an
 * unmatched quote (a choice like `The Batak word "korrrr. which…`), quoting
 * it is not a sign the explanation was cut, so the quote-balance check is
 * skipped; the ending check still applies.
 */
export function looksTruncated(ex: string | null, source?: string | null): boolean {
  if (!ex) return false;
  const t = ex.trim();
  // Placeholder-only text ("...") is not an explanation; a short but complete
  // one-line math explanation ends in punctuation and passes below.
  if (/^[.\s…]*$/.test(t)) return true;
  if (/Final answer\s*:\s*\S+$/i.test(t)) return false; // ends with the answer trailer
  if (/(?:^|\n)[ \t]*\**Answer\**\s*:\s*\**\s*\(?[A-D]\)?(?:\s*(?:,|and|or)\s*\(?[A-D]\)?)*\**\s*$/.test(t)) return false; // "Answer: B" / "Answer: C, D" closing line
  // Unbalanced opening typographic quote “ (U+201C) means the string was cut
  // inside a quoted passage.
  const openQuotes = (t.match(/“/g) ?? []).length;
  const closeQuotes = (t.match(/”/g) ?? []).length;
  if (openQuotes > closeQuotes && !(source && hasUnbalancedQuotes(source))) return true;
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
    .select("id, original_question_number, question_text, choices, question_type, correct_answer, official_answer, explanation, parsing_status, parsing_notes")
    .eq("module_id", moduleId);
  const rows = (data ?? []) as {
    id: string;
    original_question_number: number;
    question_text: string | null;
    choices: unknown;
    question_type: string | null;
    correct_answer: string | null;
    official_answer: string | null;
    explanation: string | null;
    parsing_status: string | null;
    parsing_notes: string | null;
  }[];
  const targets = rows.filter((r) => looksTruncated(r.explanation));
  const live = await liveQuestionIds(db, targets.filter((r) => r.parsing_status === "Approved").map((r) => r.id));
  let regenerated = 0;
  const CHUNK = 5;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (q) => {
        const ans = q.official_answer || q.correct_answer;
        if (!ans) return;
        const ch = Array.isArray(q.choices)
          ? (q.choices as unknown[]).map((c) => (typeof c === "string" ? c : `${(c as { label?: string }).label}) ${(c as { text?: string }).text || ((c as { image_url?: string | null }).image_url ? "(a graph — image not shown here)" : "")}`)).join("\n")
          : "";
        try {
          const res = await generateTagged({
            model: anthropic("claude-sonnet-4-6"),
            system: EXPLAIN_OFFICIAL_SYSTEM,
            maxOutputTokens: 3000,
            maxRetries: 2,
            messages: [{ role: "user", content: [{ type: "text", text: curlyQuotes(`Question ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${ch}\n\nThe correct answer is: ${ans}\n\nWrite a COMPLETE explanation of why ${ans} is correct — do not cut off.`) }] }],
          }, ["explanation"] as const);
          const raw = stripMetaNarration(res.object.explanation);
          const expl = q.question_type === SPR_TYPE && !looksTruncated(raw) ? withSprAnswerLine(raw, ans, q.question_text) : raw;
          if (!looksTruncated(expl)) {
            regenerated++;
            const { update } = applyLiveHold(
              q,
              { correct_answer: ans, explanation: expl, updated_at: new Date().toISOString() },
              "Cut-off explanation regenerated",
              live,
            );
            await db.from("questions").update(update).eq("id", q.id);
          } else {
            // Still truncated after the regen attempt — flag for human.
            const { update } = applyLiveHold(
              q,
              { parsing_status: "Needs Review", parsing_notes: TRUNCATION_NOTE, updated_at: new Date().toISOString() },
              "Explanation looks cut off",
              live,
            );
            await db.from("questions").update(update).eq("id", q.id);
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

// (explainOneAnswer, which rewrote an explanation to defend a given key with
// no independent solve and no checks, was removed 2026-11-07: every key
// change goes through lib/key-change.ts prepareKeyChange.)

// ── Reviewer "Regenerate explanation" ────────────────────────────────
// Writes a fresh explanation for the question AS GIVEN (the review page sends
// its current, possibly unsaved, text/choices/answer). The explanation always
// argues the given answer; the model separately reports the answer it gets on
// its own so the page can warn when the two differ. Never changes the answer.


const REGEN_EXPLANATION_SYSTEM = `${EXPLAIN_OFFICIAL_SYSTEM}

INDEPENDENT CHECK: before writing the explanation, solve the question on your own as if no answer were given, and put that result in independent_answer. This is only a cross-check for the reviewer — it never changes what the explanation argues. The explanation must still justify the GIVEN answer.`;

/**
 * The page's (possibly unsaved) choice text with each choice's image_url
 * taken from the saved row by label — image URLs in the request body are
 * never fetched by the server.
 */
export function choicesWithStoredImages(bodyChoices: unknown, storedChoices: unknown): { label?: string; text?: string; image_url: string | null }[] {
  const stored = new Map<string, string | null>();
  for (const c of Array.isArray(storedChoices) ? storedChoices : []) {
    const cc = c as { label?: unknown; image_url?: unknown };
    if (typeof cc?.label === "string") stored.set(cc.label, typeof cc.image_url === "string" ? cc.image_url : null);
  }
  return (Array.isArray(bodyChoices) ? bodyChoices : []).map((c) => {
    const cc = (c ?? {}) as { label?: unknown; text?: unknown };
    const label = typeof cc.label === "string" ? cc.label : undefined;
    return {
      label,
      text: typeof cc.text === "string" ? cc.text : undefined,
      image_url: label ? stored.get(label) ?? null : null,
    };
  });
}

export const REGEN_EXPLANATION_FAILED = "Couldn't produce a complete explanation.";

export interface RegenExplanationInput {
  questionId: string;
  questionNumber: number | null;
  questionText: string;
  choices: unknown;
  questionType: string | null;
  answer: string;
  /** Stem figure URLs (stored on the question). */
  imageUrls?: string[] | null;
  /**
   * High-resolution figure crops already made by the caller
   * (lib/figure-hires.ts; [] = tried, none). Omitted: made here.
   */
  hires?: { image: string; mediaType: string }[];
}

export type RegenExplanationResult =
  // `independent`: aiAnswer came from a solve that never saw the key
  // (independentAnswer). On a disagreement `explanation` is "" — nothing is
  // written that argues a key the AI can't reproduce.
  | { ok: true; explanation: string; aiAnswer: string | null; agrees: boolean; independent?: boolean }
  // kind "cut_off": the model answered but every explanation looked cut off;
  // "failed": the API call or schema parse failed (nothing to judge);
  // "figure_conflict": a second read of the figure disagrees with the values
  // the explanation used (flag for a person, don't save).
  | { ok: false; error: string; kind: "cut_off" | "failed" | "figure_conflict"; partial?: string | null };

/**
 * MC explanation ending in exactly one "Answer: X" line (replaces "Final
 * answer: X"); a multi-letter key is written in full ("Answer: C, D").
 */
export function withAnswerLine(explanation: string, key: string): string {
  const letters = keyLetters(key);
  if (letters.length === 0) return explanation;
  const line = `Answer: ${letters.join(", ")}`;
  const body = explanation.replace(/(?:^|\n)[ \t]*(?:\*\*)?(?:final\s+)?answer(?:\*\*)?\s*:[^\n]*\s*$/i, "").trimEnd();
  return body ? `${body}\n\n${line}` : line;
}

/**
 * Second, independent read of the figure: the model checks each value the
 * explanation's writer read (it also sees the question text, i.e. the PDF
 * text layer). Returns what conflicts (null = every value confirmed).
 */
async function checkFigureRead(
  imageBlocks: Array<{ type: "image"; image: string; mediaType: string } | { type: "text"; text: string }>,
  input: RegenExplanationInput,
  values: string,
  callerUserId?: string,
): Promise<string | null> {
  const lines = values.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12);
  if (lines.length === 0) return "no values were read from the figure";
  try {
    const res = await generateText({
      model: anthropic("claude-sonnet-4-6"),
      system: `You check values someone read from an SAT figure (graph, table or diagram). Look at the attached image(s) yourself — use the high-resolution re-render when there is one — and at the question text (the PDF's text layer). Check each point against the grid lines exactly; never accept an estimate between grid lines. For a "fit:" line, check that the function passes through every listed point. For EACH numbered value reply on its own line: "N. OK" if the figure (and the question text) show exactly that, or "N. WRONG: <what it actually shows>". If a value can't be read from the figure at all, write "N. WRONG: not shown". Nothing else.`,
      maxOutputTokens: 600,
      maxRetries: 2,
      messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: curlyQuotes(`Question text:\n${input.questionText}\n\nValues read from the figure:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`) }] }],
    });
    const u = res.usage;
    if (u) {
      const inTok = u.inputTokens ?? 0, outTok = u.outputTokens ?? 0;
      await logUsage({ userId: callerUserId, route: "figure-read-check", tokensInput: inTok, tokensOutput: outTok, model: "claude-sonnet-4-6", costCents: Math.round((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500), metadata: { question_id: input.questionId } });
    }
    const text = res.text.replace(/\*\*/g, "");
    const wrong = [...text.matchAll(/^\s*(\d+)\s*[.):-]?\s*WRONG\b\s*:?\s*(.*)$/gim)].map((m) => `${lines[Number(m[1]) - 1] ?? `value ${m[1]}`} → ${m[2].trim() || "differs"}`);
    if (wrong.length) return wrong.join(" | ").slice(0, 300);
    const oks = (text.match(/^\s*\d+\s*[.):-]?\s*OK\b/gim) ?? []).length;
    if (oks < lines.length) console.warn(`[figure-read-check] ${input.questionId}: unparsed reply: ${JSON.stringify(res.text.slice(0, 300))}`);
    return oks >= lines.length ? null : "the second read could not confirm the values";
  } catch (e) {
    return `the second read failed (${e instanceof Error ? e.message.slice(0, 60) : "error"})`;
  }
}

/** Does the model's own answer match the saved key (letters or values)? */
export function aiAnswerAgrees(aiAnswer: string | null, saved: string, isMcq: boolean, questionText?: string | null): boolean {
  if (!aiAnswer) return true; // nothing to compare — no warning
  if (isMcq) {
    const letter = (s: string) => s.trim().replace(/^\(?\s*([A-D])\b.*$/i, "$1").toUpperCase();
    return letter(aiAnswer) === letter(saved);
  }
  const clean = (s: string) => s.replace(/\$/g, "").trim();
  // Apply the stem's rounding to the AI's value first ("nearest whole
  // number": 248.2 → 248) so it's compared the way students are graded.
  const rule = roundingInstruction(questionText);
  const v = sprValue(clean(aiAnswer));
  const ai = rule && v !== null ? String(applyRounding(v, rule.places)) : clean(aiAnswer);
  return answersMatch(ai, clean(saved), questionText) || answersAgree(ai, clean(saved));
}

export async function regenerateExplanation(
  input: RegenExplanationInput,
  callerUserId?: string,
  usageRoute = "regenerate-explanation",
): Promise<RegenExplanationResult> {
  const isMcq = input.questionType !== "Student Produced Response";
  const choices = Array.isArray(input.choices)
    ? (input.choices as { label?: string; text?: string; image_url?: string | null }[])
    : [];
  const ch = choices
    .map((c) => `${c.label}) ${c.text || (c.image_url ? `(a graph — see the attached image labelled "Choice ${c.label}")` : "")}`)
    .join("\n");

  const imageBlocks: Array<{ type: "image"; image: string; mediaType: string } | { type: "text"; text: string }> = [];
  for (const url of (input.imageUrls ?? []).slice(0, 4)) {
    const f = await fetchImageAsBase64(url);
    if (f) imageBlocks.push({ type: "image", image: f.base64, mediaType: f.mediaType });
  }
  for (const c of choices) {
    if (!c.image_url) continue;
    const f = await fetchImageAsBase64(c.image_url);
    if (f) {
      imageBlocks.push({ type: "text", text: `Choice ${c.label}:` });
      imageBlocks.push({ type: "image", image: f.base64, mediaType: f.mediaType });
    }
  }

  // 1. Solve WITHOUT the key (incident 2026-11-07, J Test M1 Q10: an
  // explanation written to defend a new key computed 100% and wrote 120%).
  // When the independent solve reaches another answer, no explanation is
  // written at all: the caller flags "AI disagrees" for a person.
  // Figure questions: add a high-resolution re-render of the figure from
  // the source PDF; every read below (solve, explanation, check) sees it.
  const hasFigure = imageBlocks.some((b) => b.type === "image");
  if (hasFigure) {
    const hires = input.hires ?? (await highResFigure(input.questionId, callerUserId));
    if (hires.length) {
      imageBlocks.push({ type: "text", text: "High-resolution re-render of the figure from the source PDF — read exact values from this one:" });
      for (const h of hires) imageBlocks.push({ type: "image", image: h.image, mediaType: h.mediaType });
    }
  }
  const solo = await independentAnswer(
    { questionId: input.questionId, questionText: input.questionText, choices: input.choices, questionType: input.questionType, imageUrls: input.imageUrls, blocks: imageBlocks },
    callerUserId,
  );
  // A fill-in "answer" that is really working ("… = 54/5 = 10.8") counts as
  // its last value; anything else unreadable counts as no answer.
  const rawSolo = solo.ok ? (solo.answer ?? "").trim() : "";
  const independent = !rawSolo
    ? null
    : rawSolo.length <= 40 && !rawSolo.includes("\n")
      ? rawSolo
      : !isMcq
        ? (rawSolo.match(/-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?(?=[^\d]*$)/)?.[0].replace(/\s+/g, "") ?? null)
        : null;
  if (independent && !aiAnswerAgrees(independent, input.answer, isMcq, input.questionText)) {
    return { ok: true, explanation: "", aiAnswer: independent, agrees: false, independent: true };
  }

  // 2. They agree (or the solve gave no answer): write the explanation.
  const prompt = curlyQuotes(`Question ${input.questionNumber ?? ""} (${isMcq ? "Multiple Choice" : "Student Produced Response"}):\n${input.questionText}${ch ? `\n\nChoices:\n${ch}` : ""}\n\nThe correct answer is: ${input.answer}\n\nWrite a COMPLETE explanation of why ${input.answer} is correct — do not cut off.`);
  const source = `${input.questionText}\n${ch}`;
  const RETRY_REMINDER = "\n\nREMINDER: your previous explanation was cut off. Write the WHOLE explanation inside the <explanation> tag and close the tag.";
  const params = {
    model: anthropic("claude-sonnet-4-6"),
    system: hasFigure ? `${REGEN_EXPLANATION_SYSTEM}\n\n${FIGURE_READ_RULE}\nThe explanation's setup states the points you read and the fitted function; the steps use exactly those.` : REGEN_EXPLANATION_SYSTEM,
    maxOutputTokens: 3000,
    maxRetries: 2,
    messages: [{ role: "user" as const, content: [...imageBlocks, { type: "text" as const, text: prompt }] }],
  };

  // Same cut-off check as the pipeline (looksTruncated); one retry, then give up.
  let sawCutOff = false;
  let partial: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await generateTagged(
        attempt === 0
          ? params
          : { ...params, messages: [{ role: "user" as const, content: [...imageBlocks, { type: "text" as const, text: prompt + RETRY_REMINDER }] }] },
        hasFigure ? (["figure_values", "independent_answer", "explanation"] as const) : (["independent_answer", "explanation"] as const),
      );
      const usage = res.usage;
      if (usage) {
        const inTok = usage.inputTokens ?? 0, outTok = usage.outputTokens ?? 0;
        await logUsage({ userId: callerUserId, route: usageRoute, tokensInput: inTok, tokensOutput: outTok, model: "claude-sonnet-4-6", costCents: Math.round((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500), metadata: { question_id: input.questionId, attempt } });
      }
      // A LaTeX command whose backslash got read as a JSON escape ("\times" →
      // TAB + "imes", "\frac" → form feed + "rac"): put the backslash back.
      const explanation = stripMetaNarration(res.object.explanation)
        .replace(/\t(?=[a-z])/g, "\\t")
        .replace(/\f(?=[a-z])/g, "\\f")
        .replace(/\x08(?=[a-z])/g, "\\b")
        .replace(/\r(?=[a-z])/g, "\\r")
        .trim();
      if (!explanation || looksTruncated(explanation, source)) {
        if (explanation && explanation.length > (partial?.length ?? 0)) partial = explanation;
        console.warn(`[regen-explanation] ${input.questionId}: attempt ${attempt + 1} looks cut off: …${JSON.stringify(explanation.slice(-160))}`);
        sawCutOff = true;
        continue;
      }
      const inPrompt = res.object.independent_answer.trim() || null;
      // The writer's own cross-check must agree too: a writer that reaches
      // another answer may bend its reasoning toward the key.
      if (inPrompt && !aiAnswerAgrees(inPrompt, input.answer, isMcq, input.questionText)) {
        return { ok: true, explanation: "", aiAnswer: inPrompt, agrees: false, independent: false };
      }
      // Figure questions: a second, separate read of the figure must confirm
      // the values the explanation is built on; otherwise flag, don't save.
      if (hasFigure) {
        const values = ((res.object as Record<string, string>).figure_values ?? "").trim();
        const conflict = values ? await checkFigureRead(imageBlocks, input, values, callerUserId) : "no values were read from the figure";
        if (conflict) {
          console.warn(`[regen-explanation] ${input.questionId}: figure read conflict: ${conflict}`);
          return { ok: false, error: `Figure read conflict: ${conflict}`, kind: "figure_conflict", partial: null };
        }
      }
      return {
        ok: true,
        // One closing line in every explanation: "Answer: X" (fill-in: the
        // answer and its other accepted entries).
        explanation: isMcq ? withAnswerLine(explanation, input.answer) : withSprAnswerLine(explanation, input.answer, input.questionText),
        aiAnswer: independent ?? inPrompt,
        agrees: true,
        independent: !!independent,
      };
    } catch (e) {
      console.error(`[regen-explanation] ${input.questionId}: attempt ${attempt + 1} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { ok: false, error: REGEN_EXPLANATION_FAILED, kind: sawCutOff ? "cut_off" : "failed", partial };
}

export const REGEN_EXPLANATION_NOTE = "Needs review: explanation was cut off and regenerated by AI — check it.";

export const REGEN_DISAGREE_PREFIX = "Needs review: AI's own answer is";

export function regenDisagreeNote(aiAnswer: string, saved: string): string {
  return `${REGEN_DISAGREE_PREFIX} ${aiAnswer} but the saved key is ${saved} — check the key (no explanation was written for ${saved}).`;
}

interface CutOffRow {
  id: string;
  original_question_number: number | null;
  question_text: string | null;
  choices: unknown;
  question_type: string | null;
  correct_answer: string | null;
  explanation: string | null;
  parsing_status: string | null;
  parsing_notes: string | null;
  image_urls: unknown;
}

/** Question text + choice text, for looksTruncated's quote check. */
export function explanationSource(questionText: string | null, choices: unknown): string {
  const ch = Array.isArray(choices) ? choices.map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? "")).join("\n") : "";
  return `${questionText ?? ""}\n${ch}`;
}

function isCutOffTarget(r: { parsing_status: string | null; correct_answer: string | null; explanation: string | null; question_text?: string | null; choices?: unknown }): boolean {
  return r.parsing_status !== "Rejected" && !!r.correct_answer && looksTruncated(r.explanation, explanationSource(r.question_text ?? null, r.choices));
}

/** Questions in a module whose explanation looks cut off and that have a key to explain. */
export async function listCutOffExplanations(
  moduleId: string,
  db: DbClient,
): Promise<{ id: string; number: number | null }[]> {
  const { data, error } = await db
    .from("questions")
    .select("id, original_question_number, explanation, correct_answer, parsing_status, question_text, choices")
    .eq("module_id", moduleId)
    .order("original_question_number");
  if (error) throw new Error(`listCutOffExplanations: ${error.message}`);
  return (data ?? [])
    .filter((r) => isCutOffTarget(r))
    .map((r) => ({ id: r.id as string, number: r.original_question_number as number | null }));
}

export interface BulkRegenOutcome {
  id: string;
  number: number | null;
  status: "regenerated" | "failed" | "skipped";
  /** Set when the AI's own answer differs from the saved key. */
  aiAnswer?: string;
  /** Kept Approved with a [live-fix] note because it is in a live test. */
  liveFix?: boolean;
}

/**
 * Bulk-regenerate cut-off explanations for `ids` (all in `moduleId`). Writes
 * only the explanation and a review note — never the answer, never approves.
 * Draft / Needs Review rows keep their status; an Approved row goes back to
 * Needs Review, unless it is in a live test: then it stays Approved and gets
 * a "[live-fix]" note (lib/live-questions).
 */
export async function regenerateCutOffExplanationsBatch(
  moduleId: string,
  ids: string[],
  db: DbClient,
  callerUserId?: string,
): Promise<BulkRegenOutcome[]> {
  const { data, error } = await db
    .from("questions")
    .select("id, original_question_number, question_text, choices, question_type, correct_answer, explanation, parsing_status, parsing_notes, image_urls")
    .eq("module_id", moduleId)
    .in("id", ids);
  if (error) throw new Error(`regenerateCutOffExplanationsBatch: ${error.message}`);
  const rows = (data ?? []) as CutOffRow[];
  const live = await liveQuestionIds(db, rows.filter((r) => r.parsing_status === "Approved").map((r) => r.id));
  const out: BulkRegenOutcome[] = [];
  const CHUNK = 4;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await Promise.all(
      rows.slice(i, i + CHUNK).map(async (q) => {
        const base = { id: q.id, number: q.original_question_number };
        // Re-check: someone may have fixed it since the list was made.
        if (!isCutOffTarget(q)) {
          out.push({ ...base, status: "skipped" });
          return;
        }
        const answer = q.correct_answer as string;
        const res = await regenerateExplanation(
          {
            questionId: q.id,
            questionNumber: q.original_question_number,
            questionText: q.question_text ?? "",
            choices: q.choices,
            questionType: q.question_type,
            answer,
            imageUrls: Array.isArray(q.image_urls) ? (q.image_urls as string[]) : null,
          },
          callerUserId,
        );
        if (!res.ok) {
          out.push({ ...base, status: "failed" });
          return;
        }
        const disagree = !res.agrees && res.aiAnswer ? res.aiAnswer : null;
        const prior = (q.parsing_notes ?? "")
          .split(/;\s*/)
          .filter((p) => p && p !== TRUNCATION_NOTE && p !== REGEN_EXPLANATION_NOTE && !p.startsWith(REGEN_DISAGREE_PREFIX));
        const notes = [...prior, REGEN_EXPLANATION_NOTE, ...(disagree ? [regenDisagreeNote(disagree, answer)] : [])].join("; ");
        const update: Record<string, unknown> = {
          parsing_notes: notes,
          updated_at: new Date().toISOString(),
        };
        // On a disagreement no explanation was written: keep the old one.
        if (!disagree && res.explanation.trim()) update.explanation = res.explanation;
        // Keep it in review: an Approved row goes back to Needs Review (held
        // for a live question). Draft / Needs Review keep their status.
        if (q.parsing_status === "Approved") update.parsing_status = "Needs Review";
        const hold = applyLiveHold(q, update, "Cut-off explanation regenerated by AI", live);
        const { error: upErr } = await db.from("questions").update(hold.update).eq("id", q.id);
        if (upErr) {
          console.error(`[regen-explanation] bulk write ${q.id}:`, upErr.message);
          out.push({ ...base, status: "failed" });
          return;
        }
        out.push({
          ...base,
          status: "regenerated",
          ...(disagree ? { aiAnswer: disagree } : {}),
          ...(hold.held ? { liveFix: true } : {}),
        });
      }),
    );
  }
  return out.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

// ── Independent answer ("AI suggestion" on the review page) ──────────
// Solves the question as given on the page, without seeing the stored key.
// A fill-in answer comes from the model's computation evaluated in code with
// the stem's rounding applied (checkComputedAnswer); any disagreement is
// returned as a warning, never hidden.

const IndependentAnswerSchema = z.object({
  work: z.string().describe("Brief working: the key steps only (a few lines)."),
  answer: z
    .string()
    .describe("Multiple Choice: the single letter A/B/C/D. Student Produced Response: the value to enter (no units, no $)."),
  answer_expression: SolverSchema.shape.answer_expression,
  check_equation: SolverSchema.shape.check_equation,
});

export interface IndependentAnswerInput {
  questionId: string;
  questionText: string;
  choices: unknown;
  questionType: string | null;
  imageUrls?: string[] | null;
  /** Image blocks already fetched (incl. a high-resolution re-render); replaces imageUrls. */
  blocks?: Array<{ type: "image"; image: string; mediaType: string } | { type: "text"; text: string }>;
}

export type IndependentAnswerResult =
  | { ok: true; answer: string | null; work: string; warnings: string[]; expression: string | null }
  | { ok: false; error: string };

export async function independentAnswer(
  input: IndependentAnswerInput,
  callerUserId?: string,
): Promise<IndependentAnswerResult> {
  const isSpr = input.questionType === SPR_TYPE;
  const choices = Array.isArray(input.choices)
    ? (input.choices as { label?: string; text?: string; image_url?: string | null }[])
    : [];
  const imageBlocks: Array<{ type: "image"; image: string; mediaType: string } | { type: "text"; text: string }> = input.blocks ? [...input.blocks] : [];
  for (const url of input.blocks ? [] : (input.imageUrls ?? []).slice(0, 4)) {
    const f = await fetchImageAsBase64(url);
    if (f) imageBlocks.push({ type: "image", image: f.base64, mediaType: f.mediaType });
  }
  for (const c of isSpr || input.blocks ? [] : choices) {
    if (!c.image_url) continue;
    const f = await fetchImageAsBase64(c.image_url);
    if (f) imageBlocks.push({ type: "text", text: `Choice ${c.label}:` }, { type: "image", image: f.base64, mediaType: f.mediaType });
  }
  const ch = isSpr
    ? ""
    : choices.map((c) => `${c.label}) ${c.text || (c.image_url ? `(a graph — see the attached image labelled "Choice ${c.label}")` : "")}`).join("\n");
  const prompt = `Question (${isSpr ? "Student Produced Response" : "Multiple Choice"}):\n${input.questionText}${ch ? `\n\nChoices:\n${ch}` : ""}\n\nSolve it yourself from scratch.`;
  try {
    const res = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: IndependentAnswerSchema,
      system: `You are an expert SAT solver. Solve the question rigorously and independently. For Multiple Choice give one letter A/B/C/D.\n\n${SPR_COMPUTATION_RULE}${imageBlocks.some((b) => b.type === "image") ? `\n\n${FIGURE_READ_RULE}` : ""}\n\n${QUOTE_RULE}`,
      maxOutputTokens: 2000,
      maxRetries: 2,
      messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: prompt }] }],
    });
    const u = res.usage;
    if (u) {
      const inTok = u.inputTokens ?? 0, outTok = u.outputTokens ?? 0;
      await logUsage({ userId: callerUserId, route: "independent-answer", tokensInput: inTok, tokensOutput: outTok, model: "claude-sonnet-4-6", costCents: Math.round((inTok / 1_000_000) * 300 + (outTok / 1_000_000) * 1500), metadata: { question_id: input.questionId } });
    }
    const o = res.object;
    if (!isSpr) {
      const letter = o.answer.trim().replace(/^\(?\s*([A-D])\b.*$/i, "$1").toUpperCase();
      const ok = /^[A-D]$/.test(letter);
      return { ok: true, answer: ok ? letter : null, work: o.work, warnings: ok ? [] : [`the AI answered "${o.answer}", not a letter`], expression: null };
    }
    const computed = checkComputedAnswer({ declared: o.answer, expression: o.answer_expression, checkEquation: o.check_equation, questionText: input.questionText });
    if (!o.answer_expression?.trim()) computed.problems.push("the AI gave no computation to check");
    return { ok: true, answer: computed.answer, work: o.work, warnings: computed.problems, expression: o.answer_expression?.trim() || null };
  } catch (e) {
    console.error(`[independent-answer] ${input.questionId}:`, e instanceof Error ? e.message : e);
    return { ok: false, error: "Couldn't get an AI answer. Try again." };
  }
}
