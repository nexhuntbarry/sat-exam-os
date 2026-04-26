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

export interface ParsedImageRegion {
  page: number;
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
  alt: string;
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
  image_regions: ParsedImageRegion[];
}

// ────────────────────────────────────────────
// Zod schema (enforces JSON output via generateObject)
// ────────────────────────────────────────────

// Anthropic's tool/JSON schema does not accept `minimum`, `maximum`,
// `minLength`, `maxLength`, or array `maxItems` constraints — they're
// rejected at the API boundary. Keep types pure and document constraints
// in `.describe()` so the model still complies.
const ParsedQuestionSchema = z.object({
  original_question_number: z.number().describe("Positive integer question number"),
  question_text: z.string().describe("Question text (non-empty)"),
  choices: z
    .array(
      z.object({
        label: z.enum(["A", "B", "C", "D"]),
        text: z.string(),
      })
    )
    .describe("Up to 4 multiple-choice options; empty array for SPR"),
  correct_answer: z.string().nullable(),
  explanation: z.string().nullable(),
  difficulty: z.enum(["Easy", "Medium", "Hard"]),
  domain: z.string().describe("Domain (non-empty)"),
  skill: z.string().describe("Skill (non-empty)"),
  concept: z.string().describe("Concept (non-empty)"),
  question_type: z.enum(["Multiple Choice", "Student Produced Response"]),
  has_image: z.boolean(),
  has_table: z.boolean(),
  has_formula: z.boolean(),
  page_number: z.number().describe("Positive integer page number"),
  ai_confidence_score: z.number().describe("Confidence between 0 and 1"),
  image_regions: z
    .array(
      z.object({
        page: z.number().describe("1-indexed page number this region appears on"),
        x_pct: z
          .number()
          .describe("Left edge of bounding box as fraction of page width, between 0 and 1"),
        y_pct: z
          .number()
          .describe("Top edge of bounding box as fraction of page height, between 0 and 1"),
        w_pct: z
          .number()
          .describe("Width of bounding box as fraction of page width, between 0 and 1"),
        h_pct: z
          .number()
          .describe("Height of bounding box as fraction of page height, between 0 and 1"),
        alt: z.string().describe("Brief description of what the image/graph/table contains"),
      }),
    )
    .describe(
      "Bounding boxes of every image, graph, diagram, chart, or table belonging to this question. Empty array if the question has no visual element. Coordinates are fractions of the rendered page (0..1).",
    ),
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
13. For EVERY image, graph, diagram, chart, scatter plot, geometric figure, or table that belongs to a question, populate image_regions with a tight bounding box around it. Coordinates are fractions of the page dimensions, where (0, 0) is the top-left corner and (1, 1) is the bottom-right corner of the rendered page. The system will literally crop these rectangles out of the PDF and store them, so be precise:
    - Include the FULL visual element with a small 1–3% padding on every side so axis labels, captions, and units are not clipped.
    - Do NOT include the question stem text or answer choices in the bounding box.
    - If a single question has multiple visuals (e.g., two side-by-side graphs), emit one entry per visual.
    - If has_image=true or has_table=true, image_regions MUST contain at least one entry.
    - If a question has no visual element, image_regions must be an empty array [].
    - The page field on each region is 1-indexed and may differ from page_number if the visual sits on a facing page.
    - alt should briefly describe the content (e.g., "Scatter plot of x vs. y with line of best fit", "Right triangle with sides 3, 4, 5", "Frequency table of test scores").

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

MATH FORMATTING (CRITICAL):
- Every mathematical expression — even simple ones — MUST be wrapped in $...$ for inline math or $$...$$ for display math.
- Use proper LaTeX commands: \\frac{a}{b} for fractions, \\sqrt{x} for square roots, x^{2} for exponents, _{i} for subscripts.
- Examples:
  - "the slope is 1/7" → "the slope is $\\frac{1}{7}$"
  - "y = 7x - 53" → "$y = 7x - 53$"
  - "x squared plus 4" → "$x^{2} + 4$"
  - "RS = sqrt(133)" → "$RS = \\sqrt{133}$"
- This applies to question_text, every choice's text, correct_answer, AND explanation.
- Plain English prose stays unwrapped — only the math itself uses $...$.
- Do not output ASCII pseudo-math like 1/7, x^2, sqrt(x) — always use LaTeX.

OUTPUT: Return valid JSON only. No markdown, no explanation text, no code fences. Just the raw JSON object.`;

// ────────────────────────────────────────────
// Pre-parse classifier — is this PDF actually a SAT test?
// ────────────────────────────────────────────

const SAT_CLASSIFIER_SCHEMA = z.object({
  is_sat: z.boolean(),
  confidence: z.number().describe("Confidence between 0 and 1"),
  reason: z.string().describe("Brief reason"),
});

export interface SatClassification {
  is_sat: boolean;
  confidence: number;
  reason: string;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a strict SAT-content classifier. Decide whether the supplied PDF is a SAT (Scholastic Aptitude Test) practice test or test module — including SAT Math or SAT Reading & Writing modules from College Board, Khan Academy, Bluebook, Princeton Review, Kaplan, Barron's, Manhattan Prep, or any reputable SAT prep publisher. Adaptive-section modules (Module 1 / Module 2) also count.

Return STRICT JSON only matching the schema. Do not add prose.

Set confidence high (>=0.85) only when the PDF visibly contains numbered SAT-style questions with A/B/C/D choices or student-produced response answers, and the content matches SAT Math / Reading & Writing topics. If it's another standardized test (ACT, GRE, AP, IELTS, TOEFL, etc.), classroom worksheet, novel chapter, slide deck, invoice, or any non-SAT material, set is_sat=false. When unsure, prefer is_sat=false with a moderate confidence and a short reason.`;

export async function classifyPdfIsSat(
  pdfBase64: string,
  callerUserId?: string,
): Promise<SatClassification> {
  let result;
  try {
    result = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: SAT_CLASSIFIER_SCHEMA,
      system: CLASSIFIER_SYSTEM_PROMPT,
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
              text: `Is this PDF a SAT practice test or test module? Respond with strict JSON: {is_sat: boolean, confidence: 0..1, reason: string}.`,
            },
          ],
        },
      ],
      maxRetries: 1,
    });
  } catch (err) {
    console.error("[parse-pdf] classifier error:", err);
    await logUsage({
      userId: callerUserId,
      route: "classify-pdf",
      tokensInput: 0,
      tokensOutput: 0,
      model: "claude-haiku-4-5",
      costCents: 0,
      metadata: { error: String(err) },
    });
    // Re-throw so the parse route can distinguish "classifier failed"
    // (transient API/billing error) from "PDF is genuinely not SAT".
    // Mislabeling an API failure as "not SAT" surfaces a misleading message
    // to the user (e.g. when Anthropic credits run out).
    throw new Error(
      `Classifier error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const usage = result.usage;
  if (usage) {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    // Claude Haiku 4.5: $1/M input, $5/M output
    const costCents = Math.round(
      (inputTokens / 1_000_000) * 100 + (outputTokens / 1_000_000) * 500,
    );
    await logUsage({
      userId: callerUserId,
      route: "classify-pdf",
      tokensInput: inputTokens,
      tokensOutput: outputTokens,
      model: "claude-haiku-4-5",
      costCents,
      metadata: result.object,
    });
  }

  return result.object;
}

// ────────────────────────────────────────────
// PDF fetch helper (shared by classifier + extractor)
// ────────────────────────────────────────────

export async function fetchPdfAsBase64(pdfUrl: string): Promise<string> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const headers: Record<string, string> = {};
  if (blobToken && pdfUrl.includes(".blob.vercel-storage.com")) {
    headers.Authorization = `Bearer ${blobToken}`;
  }
  const response = await fetch(pdfUrl, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

// ────────────────────────────────────────────
// Main function
// ────────────────────────────────────────────

export async function parsePdfToQuestions(
  pdfUrl: string,
  moduleMetadata: ModuleMetadata,
  callerUserId?: string
): Promise<ParsedQuestion[]> {
  // Fetch PDF as base64. The Blob store is private, so URLs at
  // *.private.blob.vercel-storage.com require Authorization with the
  // BLOB_READ_WRITE_TOKEN. Public URLs ignore the header so this is safe
  // for either store mode.
  let pdfBase64: string;
  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    const headers: Record<string, string> = {};
    if (blobToken && pdfUrl.includes(".blob.vercel-storage.com")) {
      headers.Authorization = `Bearer ${blobToken}`;
    }
    const response = await fetch(pdfUrl, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    pdfBase64 = Buffer.from(buffer).toString("base64");
  } catch (err) {
    console.error("[parse-pdf] PDF fetch error:", err);
    throw new Error(`Could not fetch PDF from URL: ${pdfUrl}`);
  }

  // SAT Math/RW modules typically contain 22-27 numbered questions per module.
  // Without this explicit hint, Sonnet often stops at 15-17 thinking it's done.
  // Telling it to scan EVERY page and keep going until the last numbered
  // question yields full coverage in our tests.
  const userPrompt = `This PDF is a SAT exam module. Extract EVERY numbered question. SAT modules normally contain 22-27 questions. Do NOT stop early — read every page top to bottom and keep extracting until you reach the last numbered question in the PDF.

Module context:
- Section: ${moduleMetadata.section}
- Difficulty hint: ${moduleMetadata.difficulty_hint}
- Module number: ${moduleMetadata.moduleNumber ?? "unknown"}

Return all questions in order via the schema. Confirm you have not missed any before responding.`;

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
    await logUsage({
      userId: callerUserId,
      route: "parse-pdf",
      tokensInput: 0,
      tokensOutput: 0,
      model: "claude-sonnet-4-6",
      costCents: 0,
      metadata: { error: String(err), pdfUrl },
    });
    throw new Error(`Extractor error: ${err instanceof Error ? err.message : String(err)}`);
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
