// ── Phase 6: semantic content audit ──────────────────────────────────
//
// The post-parse-cleanup pass (Phase 4) is a STRUCTURAL linter — it fixes
// blank-word artifacts, missing underlines, empty MCQ choices, escaped
// currency, etc. It does NOT judge whether a question is actually *correct*:
// whether the math symbols render as sane math, whether a question that needs
// a figure actually has one, or whether the explanation's reasoning supports
// the stored answer.
//
// This pass closes that gap. For every question in a module it asks Claude to
// read the question the way a student sees it and flag three failure classes:
//   1. LaTeX / math-symbol corruption (garbled markup, unbalanced $, raw
//      backslashes leaking into the stem, nonsensical operators).
//   2. Missing figure — the stem refers to "the figure/graph/table shown" (or
//      has_image=true) but no image is attached.
//   3. Answer↔explanation inconsistency — the explanation is empty, truncated,
//      a placeholder, or reasons to a different answer than correct_answer.
//   4. MCQ choice sanity — fewer than four distinct, plausible options.
//
// Anything flagged is demoted to parsing_status="Needs Review" with a
// parsing_note naming the issue, so a human verifies before students see it.
// Runs BEFORE auto-promote in the parse pipeline so broken rows never get
// auto-approved, and is exposed as a standalone endpoint so it can re-audit
// modules that were parsed before this pass existed.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { logUsage } from "./parse-pdf";

// How many questions to send to Claude per call. Small enough that the model
// gives each question real attention and the JSON stays reliable; large enough
// to keep the call count (and per-call fixed cost) down. A 22-question module
// becomes ~4 calls.
const AUDIT_CHUNK_SIZE = 6;

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      question_number: z
        .number()
        .describe("The original_question_number this verdict is for"),
      latex_ok: z
        .boolean()
        .describe(
          "true if all math/symbols in the stem, choices and explanation render as sane math. false if there is garbled LaTeX, unbalanced $, raw backslash commands leaking as text, or nonsensical operators.",
        ),
      figure_ok: z
        .boolean()
        .describe(
          "true if the question does NOT need a figure, OR needs one and has one. false only if the stem clearly references a figure/graph/table/diagram that is not attached.",
        ),
      answer_explanation_ok: z
        .boolean()
        .describe(
          "true if the explanation is present, coherent, and its reasoning supports correct_answer. false if the explanation is empty, a placeholder, truncated, or concludes a DIFFERENT answer than correct_answer.",
        ),
      choices_ok: z
        .boolean()
        .describe(
          "For Multiple Choice: true if there are four distinct, plausible options. For non-MCQ: always true.",
        ),
      issues: z
        .array(z.string())
        .describe(
          "Short human-readable description of each problem found. Empty array if everything is ok.",
        ),
    }),
  ),
});

const AUDIT_SYSTEM_PROMPT = `You are a meticulous SAT question-bank quality auditor. You are given a batch of already-parsed SAT questions (stem, answer choices, the stored correct answer, and the AI-generated explanation) plus metadata about whether an image is attached.

For EACH question return a verdict on four dimensions. Be strict but fair — only flag REAL problems a student would notice, not stylistic nits.

1. latex_ok — Check every math expression in the stem, choices, and explanation. Flag (false) when you see: unbalanced "$", raw LaTeX commands showing as literal text (e.g. "\\frac" or "\\sqrt" appearing unrendered), doubly-escaped backslashes, stray backslash-space, mojibake, or operators that make no mathematical sense. Plain-text questions with no math are latex_ok=true.

2. figure_ok — Read the stem. If it says things like "the figure shown", "the graph above", "the table", "the diagram", "as shown", or is a data/geometry question that is meaningless without a visual, then it NEEDS a figure. You are told whether an image is attached (has_image_attached). If it needs a figure but has_image_attached is false, set figure_ok=false. If it needs no figure, figure_ok=true.

3. answer_explanation_ok — The explanation must be present, coherent, and actually justify correct_answer. Flag (false) if the explanation is empty/blank, is an obvious placeholder ("Pending AI answer", "TODO"), is cut off mid-sentence, self-contradicts, or reasons to a different final answer than correct_answer.

4. choices_ok — Only meaningful for Multiple Choice. Flag (false) if there are fewer than four options, options are duplicated, or an option is empty/garbled. For Student Produced Response / non-MCQ, choices_ok=true.

Put a concise note in issues[] for every dimension you flag. If a question is completely fine, all four booleans are true and issues is [].

Return a verdict for EVERY question number you are given, in any order.`;

export interface SemanticAuditSummary {
  audited: number;
  flagged: number;
  latexIssues: number;
  figureIssues: number;
  explanationIssues: number;
  choiceIssues: number;
  errors: string[];
}

interface QuestionRow {
  id: string;
  original_question_number: number;
  question_text: string | null;
  choices: unknown;
  correct_answer: string | null;
  explanation: string | null;
  question_type: string | null;
  has_image: boolean | null;
  image_urls: unknown;
  parsing_status: string | null;
  parsing_notes: string | null;
}

function hasAttachedImage(r: QuestionRow): boolean {
  return Array.isArray(r.image_urls) && r.image_urls.length > 0;
}

// Strip any prior "Phase 6 audit" note so re-runs don't stack duplicates.
function stripPriorAuditNote(notes: string | null): string {
  if (!notes) return "";
  return notes
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("Semantic audit:"))
    .join("; ");
}

/**
 * Run the semantic audit over every question in a module. Demotes any question
 * with a real content problem to Needs Review and appends a note. Never throws;
 * per-chunk failures are collected in summary.errors.
 */
export async function runSemanticAudit(
  moduleId: string,
  db: SupabaseClient,
  callerUserId?: string,
): Promise<SemanticAuditSummary> {
  const summary: SemanticAuditSummary = {
    audited: 0,
    flagged: 0,
    latexIssues: 0,
    figureIssues: 0,
    explanationIssues: 0,
    choiceIssues: 0,
    errors: [],
  };

  const { data, error } = await db
    .from("questions")
    .select(
      "id, original_question_number, question_text, choices, correct_answer, explanation, question_type, has_image, image_urls, parsing_status, parsing_notes",
    )
    .eq("module_id", moduleId)
    .order("original_question_number");
  if (error) {
    summary.errors.push(`select: ${error.message}`);
    return summary;
  }
  const rows = (data ?? []) as QuestionRow[];
  if (rows.length === 0) return summary;

  const byNumber = new Map<number, QuestionRow>();
  for (const r of rows) byNumber.set(r.original_question_number, r);

  for (let i = 0; i < rows.length; i += AUDIT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + AUDIT_CHUNK_SIZE);
    const payload = chunk.map((r) => ({
      question_number: r.original_question_number,
      question_type: r.question_type ?? "Multiple Choice",
      has_image_attached: hasAttachedImage(r),
      stem: r.question_text ?? "",
      choices: Array.isArray(r.choices) ? r.choices : [],
      correct_answer: r.correct_answer ?? "(none)",
      explanation: r.explanation ?? "(none)",
    }));

    try {
      const result = await generateObject({
        model: anthropic("claude-sonnet-4-6"),
        schema: VerdictSchema,
        system: AUDIT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Audit these ${payload.length} SAT questions. Return one verdict per question_number.\n\n${JSON.stringify(payload, null, 2)}`,
              },
            ],
          },
        ],
        maxRetries: 2,
      });

      const usage = result.usage;
      if (usage) {
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        // Claude Sonnet 4.6: $3/M input, $15/M output.
        const costCents = Math.round(
          (inputTokens / 1_000_000) * 300 + (outputTokens / 1_000_000) * 1500,
        );
        await logUsage({
          userId: callerUserId,
          route: "semantic-audit",
          tokensInput: inputTokens,
          tokensOutput: outputTokens,
          model: "claude-sonnet-4-6",
          costCents,
          metadata: { module_id: moduleId, batch_size: payload.length },
        });
      }

      for (const v of result.object.verdicts) {
        const row = byNumber.get(v.question_number);
        if (!row) continue;
        summary.audited++;

        const problems: string[] = [];
        if (!v.latex_ok) {
          summary.latexIssues++;
          problems.push("math/LaTeX");
        }
        if (!v.figure_ok) {
          summary.figureIssues++;
          problems.push("missing figure");
        }
        if (!v.answer_explanation_ok) {
          summary.explanationIssues++;
          problems.push("answer/explanation");
        }
        if (!v.choices_ok) {
          summary.choiceIssues++;
          problems.push("choices");
        }
        if (problems.length === 0) continue;

        summary.flagged++;
        const detail = v.issues.length
          ? v.issues.join(", ")
          : problems.join(", ");
        const note = `Semantic audit: ${detail}`;
        const base = stripPriorAuditNote(row.parsing_notes);
        const newNotes = base ? `${base}; ${note}` : note;
        const { error: upErr } = await db
          .from("questions")
          .update({
            parsing_status: "Needs Review",
            parsing_notes: newNotes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (upErr) {
          summary.errors.push(`update q${v.question_number}: ${upErr.message}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.errors.push(`chunk@${i}: ${msg}`);
      console.error(`[semantic-audit] chunk starting ${i} failed:`, msg);
    }
  }

  console.log(
    `[semantic-audit] module=${moduleId} audited=${summary.audited} flagged=${summary.flagged} latex=${summary.latexIssues} figure=${summary.figureIssues} explanation=${summary.explanationIssues} choices=${summary.choiceIssues} errors=${summary.errors.length}`,
  );
  return summary;
}
