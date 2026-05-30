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

// Lighter schema for Reading & Writing modules. R&W passages are token-heavy
// and the section rarely contains tables/formulas, so we drop image_regions /
// has_table / has_formula entirely — saving extraction tokens and keeping
// long modules from blowing the Vercel function timeout.
const ParsedQuestionRwSchema = z.object({
  original_question_number: z.number().describe("Positive integer question number"),
  question_text: z.string().describe("Question text (non-empty)"),
  choices: z
    .array(
      z.object({
        label: z.enum(["A", "B", "C", "D"]),
        text: z.string(),
      }),
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
  page_number: z.number().describe("Positive integer page number"),
  ai_confidence_score: z.number().describe("Confidence between 0 and 1"),
});

const ParsedQuestionsRwSchema = z.object({
  questions: z.array(ParsedQuestionRwSchema),
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
13. **REQUIRED — IMAGE_REGIONS BOUNDING BOXES**: For EVERY image, graph, diagram, chart, scatter plot, geometric figure, or table that belongs to a question, you MUST populate image_regions with a tight bounding box around it. THIS IS NOT OPTIONAL. The downstream system literally crops these rectangles out of the PDF — without bounding boxes, students see questions like "Refer to the figure" with no figure. Coordinates are fractions of the page dimensions, where (0, 0) is the top-left corner and (1, 1) is the bottom-right corner of the rendered page.
    - **HARD RULE**: If has_image=true OR has_table=true, image_regions MUST contain at least one entry. An empty array when has_image=true is a BUG — do not emit it.
    - **CONCRETE EXAMPLE** of a valid region for a graph occupying the upper-middle of page 3: { "page": 3, "x_pct": 0.12, "y_pct": 0.18, "w_pct": 0.55, "h_pct": 0.32, "alt": "Scatter plot of mass vs. time with line of best fit" }. Numbers are fractions in [0, 1], NOT pixels and NOT percentages out of 100.
    - Include the FULL visual element with a small 1–3% padding on every side so axis labels, captions, and units are not clipped.
    - Do NOT include the question stem text or answer choices in the bounding box.
    - If a single question has multiple visuals (e.g., two side-by-side graphs), emit one entry per visual.
    - If a question has no visual element AT ALL (pure text/algebra problem), image_regions must be an empty array [] AND has_image must be false AND has_table must be false.
    - The page field on each region is 1-indexed and may differ from page_number if the visual sits on a facing page.
    - alt should briefly describe the content (e.g., "Scatter plot of x vs. y with line of best fit", "Right triangle with sides 3, 4, 5", "Frequency table of test scores").
    - If you genuinely cannot pinpoint the bounding box but you know the visual is somewhere on page N, you may emit a full-page region { "page": N, "x_pct": 0, "y_pct": 0, "w_pct": 1, "h_pct": 1, "alt": "<best guess>" } — the cropper will use the whole page. NEVER emit an empty image_regions when has_image=true.

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

CURRENCY (CRITICAL — this has caused production bugs):
- Dollar amounts in word problems (e.g. \\$950, \\$1,150, \\$0.40) are PROSE, not math.
- ALWAYS write currency with an escaped backslash-dollar: "\\$950 for the first 2 hours" — never bare "$950" and never math-wrapped "$\\$950$" or "$950$".
- A bare "$" followed by a number will be interpreted by the markdown renderer as opening inline math, swallowing the rest of the sentence into italicised KaTeX.
- Right: "Bennett opened an account with \\$600 and earned \\$2.40 in interest."
- Wrong: "Bennett opened an account with $600 and earned $2.40 in interest."
- Wrong: "Bennett opened an account with $\\$600$ and earned $\\$2.40$ in interest."
- This rule applies to question_text, choice text, correct_answer, AND explanation.

MIXED CURRENCY + EQUATION (CRITICAL — production bug 2026-05-11):
When a choice or sentence has BOTH currency AND a non-trivial equation (operators, variables, parentheses), DO NOT lump the whole thing inside a single escaped-dollar wrap or a math wrap. Currency stays escaped, equation pieces stay in math wrap, English connectors stay as prose.

- WRONG: "\\$950 + 50(t - 2) = 1{,}150\\$"
  (whole string treated as literal currency; the LaTeX thin-space macro for thousand grouping is meaningless outside a math context and renders as garbage)
- WRONG: "$950 + 50(t - 2) = 1{,}150$"
  (the outer dollars are taken as math delimiters, so the leading \\$950 opens math instead of being currency)
- WRONG: "$\\$950 + 50(t - 2) = \\$1{,}150$"
  (escaped currency inside a math wrap — escapes don't work that way)
- RIGHT: "\\$950 + $50(t - 2)$ = \\$1{,}150"
  (currency escaped with backslash-dollar; only the algebraic middle is in math wrap)
- RIGHT (equation form, no currency on LHS/RHS): "$950(t - 2) + 50t = 1{,}150$"
  (no currency anywhere → the whole equation is math; the LaTeX thin-space macro is fine inside math)

Decision rule:
  1. Identify each dollar-amount token. If it's a real monetary amount in prose ("rent the bus for \\$950"), write it with the backslash-dollar — never inside math.
  2. Identify each algebraic chunk (variables, operators, =, parentheses around variables). Wrap each chunk in single-dollar math delimiters.
  3. Connectors like " for ", " and ", " is " stay as plain English between the math chunks.
  4. NEVER emit raw LaTeX macros (the thin-space comma macro, \\frac, \\sqrt, etc.) outside a math wrap. If you see a number with the LaTeX thin-space for thousand grouping, that ONLY belongs inside math; otherwise write the comma directly (1,150, not the LaTeX thin-space form).

MULTIPLE CHOICE QUESTIONS (CRITICAL — never drop the choices):
Every SAT question marked Multiple Choice in this PDF has exactly four labelled options A, B, C, D. The downstream system stores them in a JSON array and uses that array to render the choice buttons; if the array is empty or missing the student sees the stem with no options to pick from.
- For every question you classify as question_type="Multiple Choice", the choices array MUST contain exactly 4 entries.
- Each entry's label is "A", "B", "C", or "D" (uppercase, single character) and text is the choice prose copied verbatim from the PDF.
- If you can see the question stem clearly but cannot read one or more of the A/B/C/D options (cut off, blurry, glued to the next page), DO NOT silently classify it as "Student Produced Response". Keep question_type="Multiple Choice", include the choices you can read, lower ai_confidence_score below 0.7, and put a short note in question_text or skip the row — but never emit MCQ with an empty choices array.
- "Student Produced Response" is reserved for SAT Math grid-in questions where there are genuinely no A/B/C/D options on the page. R&W never has SPR — every R&W question is Multiple Choice.

FILL-IN-THE-BLANK PROMPTS (CRITICAL — SAT R&W transition / vocab questions):
SAT Reading & Writing transition questions and word-in-context questions present a passage with a blank line where the student's choice fits. In the PDF this looks like "with millions of years of material missing in between. ______ time did not stand still during these intervening years" — a row of underscores marking the gap.
- Render the blank as a run of underscores (use exactly 6 underscores: "______").
- DO NOT add the literal English word "blank" anywhere near the underscores. The PDF underscore IS the blank — emitting "______ blank" makes the passage read nonsensically to the student.
- Preserve the surrounding spacing and punctuation as-is. Example: write "...material missing in between. ______ time did not stand still..." NOT "...material missing in between. ______ blank time did not stand still..."
- This applies to question_text and choice text.

TABLES (CRITICAL — preserve table structure):
When a question's passage includes a data table, emit it as a GitHub-flavored markdown table inside question_text so the renderer can display it as an actual <table>. The renderer pipeline (remark-gfm + react-markdown) parses pipe-separated rows into a real table only when the table is line-separated AND the header row is followed by a separator row of dashes.
- Use this exact shape (one row per line; header separator with dashes; one cell per column per row):
  | Hoard name | Date of contents | Year of discovery | Description |
  | --- | --- | --- | --- |
  | Broighter Hoard | 1st century BCE | 1896 | gold pieces |
  | Balline Hoard | 4th century CE | 1940 | silver pieces |
- DO NOT inline a table as a single run of pipe-separated text like "Hoard name | Date of contents | ... Broighter Hoard | 1st century BCE | 1896 | gold pieces Balline Hoard | ..." — that flattens the structure and renders as prose.
- Each cell is one logical value. Don't merge two cells with a slash if the source shows them separately.
- If the passage references the table in the question stem ("Which choice most effectively uses data from the table…"), leave the stem text as-is and just place the markdown table above it.
- Set has_table=true on any question that includes a table.

UNDERLINED PORTIONS (CRITICAL — SAT R&W question type):
SAT Reading & Writing has a question family that asks "Which choice best describes the function of the underlined portion in the text…". For those questions, the PDF passage has an actual underline under one word, phrase, clause, or sentence. The student CANNOT answer the question without seeing which portion is underlined, and the AI solver downstream CANNOT score the question without that signal either.
- When you see an underlined run in a passage, wrap that exact run in HTML <u>…</u> tags inside question_text.
- The tag goes around the underlined text only — not surrounding prose. Keep punctuation that's clearly underlined inside the tag and punctuation that isn't outside.
- Do NOT use markdown emphasis (_, *) for this — that has different semantics and the renderer will misinterpret it.
- Do NOT skip the tag just because the question stem already says "the underlined portion" — the tag is what makes the underline visible.
- Example: "They also saw signs of what might be a synganglion, a brain-like mass of nerve tissue, in the animal's head. <u>This evidence is exciting because it could help us better understand how M. symmetrica is related to other arthropods, such as cave crickets and krill.</u>"
- If the underlined portion contains math, the math wrap goes INSIDE the <u> tag: "<u>$y = 3x + 2$ is the line of best fit</u>".
- Same rule applies to choice text when an SAT question quotes an underlined fragment in one of the choices.

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
// Answer-key extractor — read the last page(s) of the PDF and pull the
// official answer for every numbered question if present.
// ────────────────────────────────────────────

const ANSWER_KEY_SCHEMA = z.object({
  found: z.boolean().describe("True only if a clear, unambiguous answer key is visible. Bibliographies, scratch work, or stray letters do not count."),
  answers: z
    .array(
      z.object({
        question_number: z.number().describe("Question number (positive integer)"),
        answer: z
          .string()
          .describe(
            'Exact answer: A | B | C | D for multiple choice, or the numeric/expression value for student-produced response (e.g. "12", "3/4", "0.5")',
          ),
      }),
    )
    .describe("Empty array when found=false."),
  notes: z.string().nullable().describe("Optional one-line note about ambiguity or partial extraction."),
});

export interface AnswerKey {
  found: boolean;
  /** question_number → official answer */
  answers: Record<number, string>;
  notes: string | null;
}

const ANSWER_KEY_SYSTEM_PROMPT = `You are an SAT module answer-key extractor. The PDF you receive contains a SAT practice module that may or may not include an answer key — typically printed on the last page or last few pages, sometimes labelled "Answer Key", "Answers", "Solutions", "Answer Explanations", or rendered as a simple table, list, or grid.

Your job:
1. Scan EVERY page of the PDF for an answer-key block. The block is most often on the very last page, but it can also appear earlier (e.g. mid-document for combined Math + R&W booklets). It is a separate roster of correct answers, NOT the practice questions themselves.
2. If a clear answer key is present, extract EVERY (question_number, answer) pair printed in the key. Do not skip questions just because they appear later in the list — keep reading until the key roster ends. Common SAT modules have 22-27 numbered answers; missing the last few is a known failure mode you must avoid.
3. For multiple-choice questions answer must be exactly one of: A, B, C, D.
4. For student-produced response (numeric / fill-in-the-blank) answers, return the literal value as printed (e.g. "12", "3/4", "0.5", "1.25", "7"). Do NOT wrap in LaTeX or quotes. Do NOT convert decimals to fractions or vice versa — return what the key prints.
5. If you can only read part of the key (e.g. some letters are smudged or cut off at a page break), still return what you can. Set notes to describe which question numbers you couldn't read.
6. If no answer key is visible at all, set found=false and answers=[]. Do not invent answers from your own solving.

Return STRICT JSON matching the schema. No prose, no markdown, no explanations.`;

export async function extractAnswerKey(
  pdfBase64: string,
  callerUserId?: string,
): Promise<AnswerKey> {
  let result;
  try {
    // Sonnet 4.6 instead of Haiku 4.5: answer-key extraction was
    // missing the last 1-2 entries on Haiku for SAT modules with 22+
    // questions, leaving those questions to fall back on the (less
    // reliable) AI solver. Sonnet is slower but the probe still fits
    // comfortably in the 60s `maxDuration` of the route.
    result = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: ANSWER_KEY_SCHEMA,
      system: ANSWER_KEY_SYSTEM_PROMPT,
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
              text: `Scan the entire PDF for an answer-key block (likely the last page, but scan every page). Extract every (question_number, answer) pair printed in the key — do not stop early.`,
            },
          ],
        },
      ],
      maxRetries: 1,
    });
  } catch (err) {
    console.error("[parse-pdf] answer-key extractor error:", err);
    await logUsage({
      userId: callerUserId,
      route: "extract-answer-key",
      tokensInput: 0,
      tokensOutput: 0,
      model: "claude-haiku-4-5",
      costCents: 0,
      metadata: { error: String(err) },
    });
    throw new Error(
      `Answer-key extractor error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const usage = result.usage;
  if (usage) {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const costCents = Math.round(
      (inputTokens / 1_000_000) * 100 + (outputTokens / 1_000_000) * 500,
    );
    await logUsage({
      userId: callerUserId,
      route: "extract-answer-key",
      tokensInput: inputTokens,
      tokensOutput: outputTokens,
      model: "claude-haiku-4-5",
      costCents,
      metadata: { found: result.object.found, count: result.object.answers.length },
    });
  }

  const out: AnswerKey = {
    found: result.object.found,
    answers: {},
    notes: result.object.notes ?? null,
  };
  for (const a of result.object.answers) {
    out.answers[a.question_number] = a.answer.trim();
  }
  return out;
}

// ────────────────────────────────────────────
// PDF fetch helper (shared by classifier + extractor)
// ────────────────────────────────────────────

export async function fetchPdfAsBase64(pdfUrl: string): Promise<string> {
  // SECURITY: hard-restrict to the Vercel Blob host. `modules.pdf_url`
  // ultimately comes from a request body, and forwarding arbitrary URLs
  // to fetch() is SSRF — an attacker could point this at internal
  // metadata services (e.g. 169.254.169.254) or any host that receives
  // the Authorization Bearer header below.
  let parsed: URL;
  try {
    parsed = new URL(pdfUrl);
  } catch {
    throw new Error("Invalid PDF URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".blob.vercel-storage.com")) {
    throw new Error("PDF URL must be a Vercel Blob URL");
  }

  // Project may have multiple Vercel Blob stores (each with its own
  // read-write token). A token from store A returns 403 against store
  // B. Try every available token in turn so the parser works no
  // matter which store the PDF lives in.
  const tokens = [
    process.env.BLOB_READ_WRITE_TOKEN,
    process.env.PUBLIC_BLOB_READ_WRITE_TOKEN,
  ].filter((t): t is string => Boolean(t));

  let lastStatus = 0;
  let lastStatusText = "";
  for (const token of tokens.length > 0 ? tokens : [undefined]) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(pdfUrl, { headers });
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString("base64");
    }
    lastStatus = response.status;
    lastStatusText = response.statusText;
    // If it's not an auth issue, no point trying another token.
    if (response.status !== 401 && response.status !== 403) break;
  }
  throw new Error(`Failed to fetch PDF: ${lastStatus} ${lastStatusText}`);
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
    pdfBase64 = await fetchPdfAsBase64(pdfUrl);
  } catch (err) {
    console.error("[parse-pdf] PDF fetch error:", err);
    throw new Error(
      `Could not fetch PDF from URL: ${pdfUrl} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const isReadingWriting = moduleMetadata.section === "Reading & Writing";

  // SAT Math/RW modules typically contain 22-27 numbered questions per module.
  // Without this explicit hint, Sonnet often stops at 15-17 thinking it's done.
  // Telling it to scan EVERY page and keep going until the last numbered
  // question yields full coverage in our tests.
  //
  // R&W modules: explicitly skip image_regions / has_table / has_formula in
  // the prompt and use a lighter schema, since long passages already eat
  // most of the token budget and the figure pipeline is being replaced by
  // an inline-iframe approach on the rendering side anyway.
  const rwAddendum = isReadingWriting
    ? `\n\nThis is Reading & Writing — questions are passage-based and almost never include images, tables, or formulas. Set has_image=false unless a question literally references an embedded figure. Do NOT emit image_regions / has_table / has_formula fields; the lighter R&W schema does not include them.`
    : "";
  const userPrompt = `This PDF is a SAT exam module. Extract EVERY numbered question. SAT modules normally contain 22-27 questions. Do NOT stop early — read every page top to bottom and keep extracting until you reach the last numbered question in the PDF.

Module context:
- Section: ${moduleMetadata.section}
- Difficulty hint: ${moduleMetadata.difficulty_hint}
- Module number: ${moduleMetadata.moduleNumber ?? "unknown"}

Return all questions in order via the schema. Confirm you have not missed any before responding.${rwAddendum}`;

  // Run extraction; if Sonnet returns way too few questions (sometimes it
  // treats a single passage cluster as "done" and stops at 2-5), retry
  // once with an explicit short-count callout so it scans the whole PDF.
  // SAT modules are reliably 22-27 questions, so anything <15 is a parse
  // miss, not a tiny custom module.
  const MIN_EXPECTED_QUESTIONS = 15;
  async function runExtraction(extraInstruction: string) {
    return await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: isReadingWriting ? ParsedQuestionsRwSchema : ParsedQuestionsSchema,
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
              text: userPrompt + extraInstruction,
            },
          ],
        },
      ],
      maxRetries: 2,
      // R&W modules contain ~22-27 questions, each with a long passage and
      // 4 choices. 8K output tokens truncates the JSON mid-stream and the
      // SDK fails with "No object generated: could not parse the response."
      // Sonnet 4.6 supports up to 64K output; 32K is plenty of headroom for
      // even the longest module while still fitting inside the 5-minute
      // Vercel function budget.
      ...(isReadingWriting ? { maxOutputTokens: 32000 } : { maxOutputTokens: 16000 }),
    });
  }

  let result;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  try {
    result = await runExtraction("");
    totalInputTokens += result.usage?.inputTokens ?? 0;
    totalOutputTokens += result.usage?.outputTokens ?? 0;

    if (result.object.questions.length < MIN_EXPECTED_QUESTIONS) {
      console.warn(
        `[parse-pdf] First pass returned only ${result.object.questions.length} questions (< ${MIN_EXPECTED_QUESTIONS}). Retrying with stronger instruction.`,
      );
      const retry = await runExtraction(
        `\n\nIMPORTANT — RETRY: A previous extraction attempt against this same PDF returned only ${result.object.questions.length} questions, but every SAT module reliably contains 22-27 numbered questions. You MUST scan EVERY single page in this PDF from page 1 to the last page and extract ALL numbered questions. Do not stop after the first passage block. Do not skip questions just because their passage is shared with an earlier question. Re-check page ranges you may have skipped: middle pages, the second half of the booklet, and any pages immediately before the answer key. Return the complete set.`,
      );
      totalInputTokens += retry.usage?.inputTokens ?? 0;
      totalOutputTokens += retry.usage?.outputTokens ?? 0;
      if (retry.object.questions.length > result.object.questions.length) {
        result = retry;
      }
    }
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

  // Log usage. totalInputTokens / totalOutputTokens cover the initial
  // pass plus any retry pass, so cost reflects what was actually spent.
  if (totalInputTokens || totalOutputTokens) {
    // Claude Sonnet 4.6: $3/M input, $15/M output
    const costCents = Math.round(
      (totalInputTokens / 1_000_000) * 300 + (totalOutputTokens / 1_000_000) * 1500
    );
    await logUsage({
      userId: callerUserId,
      route: "parse-pdf",
      tokensInput: totalInputTokens,
      tokensOutput: totalOutputTokens,
      model: "claude-sonnet-4-6",
      costCents,
      metadata: { pdfUrl, questionCount: result.object.questions.length },
    });
  }

  // Normalize: the R&W schema omits image_regions / has_table / has_formula,
  // so backfill safe defaults before downstream code accesses those fields.
  // The new inline-iframe rendering path doesn't need image_regions, but
  // keeping the field shape consistent avoids ad-hoc undefined checks
  // throughout the parse route.
  const questions: ParsedQuestion[] = result.object.questions.map((q) => ({
    ...q,
    has_table: "has_table" in q ? (q as { has_table: boolean }).has_table : false,
    has_formula:
      "has_formula" in q ? (q as { has_formula: boolean }).has_formula : false,
    image_regions:
      "image_regions" in q
        ? (q as { image_regions: ParsedImageRegion[] }).image_regions
        : [],
  })) as ParsedQuestion[];

  // Post-extraction fallback (Math only): any question flagged has_image /
  // has_table that came back with empty image_regions gets a full-page region
  // stamped on so the cropper at least crops the entire page. R&W skips this
  // because the iframe renderer is the primary path and image_regions stays
  // empty by design.
  let fallbackCount = 0;
  if (!isReadingWriting) {
    for (const q of questions) {
      const needsVisual = q.has_image || q.has_table;
      const hasRegions = Array.isArray(q.image_regions) && q.image_regions.length > 0;
      if (needsVisual && !hasRegions) {
        console.warn(
          `[parse-pdf] q${q.original_question_number}: has_image=${q.has_image} has_table=${q.has_table} but image_regions=[]; stamping full-page fallback on page ${q.page_number}`,
        );
        q.image_regions = [
          {
            page: q.page_number,
            x_pct: 0,
            y_pct: 0,
            w_pct: 1,
            h_pct: 1,
            alt: "Full-page fallback (AI did not provide bounding box)",
          },
        ];
        fallbackCount++;
      }
    }
  }
  if (fallbackCount > 0) {
    console.warn(
      `[parse-pdf] stamped full-page fallback on ${fallbackCount}/${questions.length} questions with missing image_regions`,
    );
  }

  return questions;
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
