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

const SolverSchema = z.object({
  correct_answer: z
    .string()
    .describe(
      "For MCQ: single letter A/B/C/D. For Student Produced Response: the numeric/text answer the student should write.",
    ),
  explanation: z
    .string()
    .describe(
      "Step-by-step solution in plain prose, suitable for a student review. Include the key insight that gets to the answer. Markdown allowed for formula notation.",
    ),
  confidence: z.number().describe("Solver self-confidence between 0 and 1"),
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

SELF-CONSISTENCY (MANDATORY):
End the explanation with a final line of EXACTLY this form:
  Final answer: X
where X is exactly the same value as the value you put in correct_answer (same letter for MCQ, same numeric/text value for SPR). Do not add extra punctuation, $...$ wrapping, or commentary on this final line.

Return JSON only matching the schema. No prose outside the JSON.`;

export type SolvedAnswer = {
  correct_answer: string;
  explanation: string;
  /** Value parsed out of the explanation's "Final answer: X" line, if present. */
  explainedAnswer: string | null;
  /** True when the parsed final-answer line disagrees with correct_answer. */
  consistencyMismatch: boolean;
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
 */
async function fetchImageAsBase64(
  url: string,
): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const res = await fetch(url);
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
 * Solve every question that's missing a correct_answer or explanation.
 * Returns a Map keyed by original_question_number → { correct_answer, explanation }.
 *
 * Sequential execution (one question at a time) to stay well under
 * Anthropic's per-minute token caps for long modules.
 */
export async function solveQuestions(
  questions: ParsedQuestion[],
  imagesByQuestion: Map<number, { urls: string[] }>,
  callerUserId?: string,
): Promise<Map<number, SolvedAnswer>> {
  const out = new Map<number, SolvedAnswer>();

  for (const q of questions) {
    if (q.correct_answer && q.explanation) continue;

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
    const imageRefs: ImageInput | undefined = imagesByQuestion.get(q.original_question_number);
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
        maxRetries: 2,
      });

      const declared = result.object.correct_answer;
      let explanationText = result.object.explanation;
      const explainedAnswer = extractFinalAnswer(explanationText);
      const consistencyMismatch =
        explainedAnswer !== null && !answersAgree(declared, explainedAnswer);

      if (consistencyMismatch) {
        console.warn(
          `[solve-question] q${q.original_question_number}: solver self-inconsistent (declared "${declared}", explained "${explainedAnswer}")`,
        );
        explanationText =
          explanationText.trimEnd() +
          "\n\n(⚠️ Solver self-inconsistent — flagged for review.)";
      }

      out.set(q.original_question_number, {
        correct_answer: declared,
        explanation: explanationText,
        explainedAnswer,
        consistencyMismatch,
      });

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
      // Non-fatal: skip this one; the parse loop will store null.
    }
  }

  return out;
}
