import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { getServiceClient } from "@/lib/supabase";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface ModuleMetadata {
  section: "Math" | "Reading & Writing";
  difficulty_hint: "Easy" | "Medium" | "Hard" | "Mixed";
  moduleNumber: number | null;
}

export interface ParsedQuestion {
  original_question_number: number;
  question_text: string;
  choices: { label: "A" | "B" | "C" | "D"; text: string }[];
  correct_answer: string | null;
  explanation: string | null;
  difficulty: "Easy" | "Medium" | "Hard";
  domain: string;
  skill: string;
  concept: string;
  question_type: "Multiple Choice" | "Student Produced Response";
  has_image: boolean;
  has_table: boolean;
  has_formula: boolean;
  page_number: number;
  ai_confidence_score: number;
}

// ────────────────────────────────────────────
// Zod schema (enforces JSON output via generateObject)
// ────────────────────────────────────────────

const ParsedQuestionSchema = z.object({
  original_question_number: z.number().int().positive(),
  question_text: z.string().min(1),
  choices: z
    .array(
      z.object({
        label: z.enum(["A", "B", "C", "D"]),
        text: z.string(),
      })
    )
    .max(4),
  correct_answer: z.string().nullable(),
  explanation: z.string().nullable(),
  difficulty: z.enum(["Easy", "Medium", "Hard"]),
  domain: z.string().min(1),
  skill: z.string().min(1),
  concept: z.string().min(1),
  question_type: z.enum(["Multiple Choice", "Student Produced Response"]),
  has_image: z.boolean(),
  has_table: z.boolean(),
  has_formula: z.boolean(),
  page_number: z.number().int().positive(),
  ai_confidence_score: z.number().min(0).max(1),
});

const ParsedQuestionsSchema = z.object({
  questions: z.array(ParsedQuestionSchema),
});

// ────────────────────────────────────────────
// System prompt
// ────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert SAT exam content extractor. Your job is to carefully parse SAT exam PDFs and extract every question with 100% accuracy.

EXTRACTION RULES:
1. Extract EXACTLY as written — do not paraphrase, simplify, or rewrite question text or answer choices.
2. Preserve all mathematical notation, special characters, and formatting in question_text.
3. For each question, identify whether it is Multiple Choice (has A/B/C/D options) or Student Produced Response (no options, student writes answer).
4. If an answer key is present in the PDF, extract the correct answer letter (A/B/C/D) or value.
5. If an explanation is present, extract it verbatim.
6. Flag uncertain items (partially visible, cut off, or ambiguous) with ai_confidence_score < 0.7.
7. If a question contains an image, diagram, or graph, set has_image=true.
8. If a question contains a table or data chart, set has_table=true.
9. If a question contains mathematical formulas, equations, or expressions, set has_formula=true.
10. page_number should reflect which page of the PDF the question appears on (1-indexed).
11. Do NOT skip any questions — extract every numbered question you can find.
12. For questions you cannot read clearly, still include them with has_image=true (if applicable) and low confidence.

DOMAIN CLASSIFICATION — use EXACTLY one of these SAT standard domains:
Reading & Writing section domains:
- "Information and Ideas"
- "Craft and Structure"
- "Expression of Ideas"
- "Standard English Conventions"

Math section domains:
- "Algebra"
- "Advanced Math"
- "Problem Solving and Data Analysis"
- "Geometry and Trigonometry"

DIFFICULTY: Use Easy / Medium / Hard based on typical SAT difficulty conventions. When unsure, mark Medium.

SKILL: A more specific skill within the domain (e.g., "Linear equations in one variable", "Inferences", "Transitions", etc.)
CONCEPT: Even finer-grained concept (e.g., "Solving for x", "Author's purpose", "Comma usage").

OUTPUT: Return valid JSON only. No markdown, no explanation text, no code fences. Just the raw JSON object.`;

// ────────────────────────────────────────────
// Main function
// ────────────────────────────────────────────

export async function parsePdfToQuestions(
  pdfUrl: string,
  moduleMetadata: ModuleMetadata,
  callerUserId?: string
): Promise<ParsedQuestion[]> {
  // Fetch PDF as base64
  let pdfBase64: string;
  try {
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    pdfBase64 = Buffer.from(buffer).toString("base64");
  } catch (err) {
    console.error("[parse-pdf] PDF fetch error:", err);
    throw new Error(`Could not fetch PDF from URL: ${pdfUrl}`);
  }

  const userPrompt = `Please extract all SAT questions from this PDF.

Module context:
- Section: ${moduleMetadata.section}
- Difficulty hint: ${moduleMetadata.difficulty_hint}
- Module number: ${moduleMetadata.moduleNumber ?? "unknown"}

Extract every question you can find. Return a JSON object with a "questions" array containing all extracted questions.`;

  let result;
  try {
    result = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: ParsedQuestionsSchema,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: pdfBase64,
              mediaType: "application/pdf",
            },
            {
              type: "text",
              text: userPrompt,
            },
          ],
        },
      ],
      maxRetries: 2,
    });
  } catch (err) {
    console.error("[parse-pdf] generateObject error:", err);
    // Log failed attempt to usage log (best-effort)
    await logUsage({
      userId: callerUserId,
      route: "parse-pdf",
      tokensInput: 0,
      tokensOutput: 0,
      model: "claude-sonnet-4-6",
      costCents: 0,
      metadata: { error: String(err), pdfUrl },
    });
    return [];
  }

  // Log usage
  const usage = result.usage;
  if (usage) {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    // Claude Sonnet 4.6: $3/M input, $15/M output
    const costCents = Math.round(
      (inputTokens / 1_000_000) * 300 + (outputTokens / 1_000_000) * 1500
    );
    await logUsage({
      userId: callerUserId,
      route: "parse-pdf",
      tokensInput: inputTokens,
      tokensOutput: outputTokens,
      model: "claude-sonnet-4-6",
      costCents,
      metadata: { pdfUrl, questionCount: result.object.questions.length },
    });
  }

  return result.object.questions as ParsedQuestion[];
}

// ────────────────────────────────────────────
// Usage logging helper
// ────────────────────────────────────────────

interface UsageLogEntry {
  userId?: string;
  route: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  costCents: number;
  metadata: Record<string, unknown>;
}

export async function logUsage(entry: UsageLogEntry): Promise<void> {
  try {
    const db = getServiceClient();
    await db.from("ai_usage_log").insert({
      user_id: entry.userId ?? null,
      route: entry.route,
      tokens_input: entry.tokensInput,
      tokens_output: entry.tokensOutput,
      model: entry.model,
      cost_cents: entry.costCents,
      metadata: entry.metadata,
    });
  } catch (err) {
    // Never crash on logging failure
    console.error("[parse-pdf] logUsage error:", err);
  }
}

// ────────────────────────────────────────────
// Simple embedding: first 200-char hash for dedup
// ────────────────────────────────────────────

export function simpleEmbedding(text: string): { hash: string; excerpt: string } {
  const excerpt = text.slice(0, 200).toLowerCase().replace(/\s+/g, " ").trim();
  // Simple character-frequency vector for cosine similarity
  const freq: Record<string, number> = {};
  for (const ch of excerpt) {
    freq[ch] = (freq[ch] ?? 0) + 1;
  }
  return { hash: excerpt, excerpt };
}

export function cosineSimilarity(
  a: { hash: string; excerpt: string },
  b: { hash: string; excerpt: string }
): number {
  // Simple overlap-based similarity for 200-char excerpts
  const setA = new Set(a.excerpt.split(" ").filter(Boolean));
  const setB = new Set(b.excerpt.split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return intersection / Math.sqrt(setA.size * setB.size);
}
