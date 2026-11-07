// ── Consensus solve (for questions with NO official answer key) ──────
//
// Some Math modules have no answer key printed in the PDF, so there is no
// authoritative answer to reconcile against. For a flagged question in that
// situation we do NOT want to trust a single AI guess. Instead we solve it
// INDEPENDENTLY three times, then run a fourth verification pass. Only when all
// three independent solves agree AND the verifier confirms that answer do we
// treat it as settled and auto-approve. Any disagreement → leave it in Needs
// Review for a human. This is consensus-with-verification, not guessing.

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { getServiceClient } from "@/lib/supabase";
import {
  SPR_COMPUTATION_RULE,
  extractFinalAnswer,
  fetchImageAsBase64,
  inferImpliedAnswer,
  looksTruncated,
  TRUNCATION_NOTE,
} from "@/lib/ai/solve-question";
import { findParsePlaceholder, placeholderNote } from "@/lib/parse-guards";
import { SPR_TYPE, answersAgreeForQuestion, checkComputedAnswer, keyFormNote, keyTypeProblem, sprValue } from "@/lib/answer-key";
import { QUOTE_RULE } from "@/lib/ai/parse-pdf";
import { KEY_ROW_SELECT, prepareKeyChange } from "@/lib/key-change";
import { rescoreQuestion } from "@/lib/rescore";
import type { AutoFixRow } from "@/lib/explanation-autofix";

type DbClient = ReturnType<typeof getServiceClient>;

// Figures for the model; a graph choice's image is preceded by a "Choice X:" label.
type ImageBlock = { type: "image"; image: string; mediaType: string } | { type: "text"; text: string };

const SolveSchema = z.object({
  answer: z.string().describe("The final answer. MCQ: single letter A/B/C/D. SPR: the numeric value."),
  answer_expression: z
    .string()
    .describe("SPR only: the final computation as a plain arithmetic expression (numbers, + - * / ** ( ), sqrt(), abs(), pi), UNROUNDED. Empty for MCQ."),
  check_equation: z
    .string()
    .describe("SPR only, optional: an equation the answer must satisfy, with ans for the answer (e.g. 3*ans + 7 == 31). Empty if none."),
  explanation: z.string().describe("Complete step-by-step solution."),
});
const VerifySchema = z.object({
  own_answer: z.string().describe("The answer YOU get working the problem from scratch (MCQ letter or SPR value)."),
  correct: z.boolean().describe("Is the proposed answer actually correct for this question?"),
  reason: z.string(),
});

const SOLVE_SYS = `You are an expert SAT solver. Solve the question rigorously and independently. For MCQ give a single letter A/B/C/D; for student-produced response give the exact value. Show your work in the explanation.

${SPR_COMPUTATION_RULE}

${QUOTE_RULE}`;
const VERIFY_SYS = `You are a strict SAT answer checker. You are given a question and a PROPOSED answer. Work the problem yourself from scratch, put your own result in own_answer, then judge whether the proposed answer is correct. Be skeptical — only say correct=true if you independently arrive at the same answer. Your reason is shown to students as the explanation: end it with the answer.

${QUOTE_RULE}`;

function norm(v: string): string { return String(v).trim().toUpperCase().replace(/\s+/g, ""); }
function num(v: string): number | null {
  const c = v.replace(/^\$+|\$+$/g, "").trim();
  const f = c.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (f) { const n = parseFloat(f[1]), d = parseFloat(f[2]); if (d) return n / d; }
  const n = parseFloat(c);
  return Number.isFinite(n) ? n : null;
}
function agree(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = num(a), nb = num(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < 1e-6;
  return norm(a) === norm(b);
}

interface QRow {
  id: string;
  original_question_number: number;
  question_text: string | null;
  choices: unknown;
  question_type: string | null;
  parsing_notes: string | null;
  has_image?: boolean | null;
  image_urls?: unknown;
}

function choicesText(q: QRow): string {
  return Array.isArray(q.choices)
    ? (q.choices as unknown[])
        .map((c) => {
          if (typeof c === "string") return c;
          const cc = c as { label?: string; text?: string; image_url?: string | null };
          return `${cc.label}) ${cc.text || (cc.image_url ? `(graph — see the attached image labelled "Choice ${cc.label}")` : "")}`;
        })
        .join("\n")
    : "";
}

/**
 * One independent solve. Fill-in: the answer is the run's computation
 * evaluated in code with the stem's rounding applied; a run whose own
 * computation, stated answer, plug-back check or explanation disagree comes
 * back with `problems` (→ needs human).
 */
async function solveOnce(q: QRow, variant: number, images: ImageBlock[]): Promise<{ answer: string | null; problems: string[] } | null> {
  // Vary the framing per attempt so the three solves are genuinely independent
  // rather than the same cached reasoning.
  const framings = [
    "Solve this step by step.",
    "Work this problem carefully from first principles.",
    "Solve, double-checking each step of your arithmetic/algebra.",
  ];
  try {
    const r = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: SolveSchema,
      system: SOLVE_SYS,
      maxRetries: 2,
      messages: [{ role: "user", content: [...images, { type: "text", text: `${framings[variant % framings.length]}\n\nQuestion ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${choicesText(q)}${images.length ? "\n\n(Refer to the attached figure.)" : ""}` }] }],
    });
    const o = r.object;
    if (q.question_type !== SPR_TYPE) return { answer: o.answer, problems: [] };
    const c = checkComputedAnswer({ declared: o.answer, expression: o.answer_expression, checkEquation: o.check_equation, questionText: q.question_text });
    if (!o.answer_expression?.trim()) c.problems.push("no computation to check");
    const explained = extractFinalAnswer(o.explanation) ?? inferImpliedAnswer(o.explanation, false);
    if (c.answer && explained && sprValue(explained) !== null && !answersAgreeForQuestion(explained, c.answer, q.question_text)) {
      c.problems.push(`explanation ends with ${explained}, computation gives ${c.answer}`);
    }
    return { answer: c.answer, problems: c.problems };
  } catch {
    return null;
  }
}

async function verify(q: QRow, answer: string, images: ImageBlock[]): Promise<{ ok: boolean; explanation: string; ownAnswer: string } | null> {
  try {
    const r = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: VerifySchema,
      system: VERIFY_SYS,
      maxRetries: 2,
      messages: [{ role: "user", content: [...images, { type: "text", text: `Question ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${choicesText(q)}${images.length ? "\n\n(Refer to the attached figure.)" : ""}\n\nProposed answer: ${answer}\n\nIs it correct?` }] }],
    });
    return { ok: r.object.correct, explanation: r.object.reason, ownAnswer: r.object.own_answer };
  } catch {
    return null;
  }
}

async function loadImages(q: QRow): Promise<ImageBlock[]> {
  const urls = Array.isArray(q.image_urls) ? (q.image_urls as string[]) : [];
  const blocks: ImageBlock[] = [];
  for (const url of urls) {
    const f = await fetchImageAsBase64(url);
    if (f) blocks.push({ type: "image", image: f.base64, mediaType: f.mediaType });
  }
  // Graph answer choices: each choice's image, labelled with its letter.
  for (const c of Array.isArray(q.choices) ? (q.choices as { label?: string; image_url?: string | null }[]) : []) {
    if (!c?.image_url) continue;
    const f = await fetchImageAsBase64(c.image_url);
    if (f) blocks.push({ type: "text", text: `Choice ${c.label}:` }, { type: "image", image: f.base64, mediaType: f.mediaType });
  }
  return blocks;
}

/**
 * Consensus-solve every Needs-Review question in the module that has NO
 * official answer (nothing to reconcile against). Settles only unanimous +
 * verified ones; leaves the rest for a human.
 */
export async function consensusResolve(
  moduleId: string,
  db: DbClient,
): Promise<{ attempted: number; settled: number; unresolved: number; skippedBlind: number }> {
  const { data } = await db
    .from("questions")
    .select("id, original_question_number, question_text, choices, question_type, parsing_notes, official_answer, section, has_image, image_urls")
    .eq("module_id", moduleId)
    .eq("parsing_status", "Needs Review")
    .is("official_answer", null)
    // The audit doubted this key — an admin decides, not another AI vote.
    .or("parsing_notes.is.null,parsing_notes.not.ilike.*AI thinks the answer key may be wrong*");
  // Only computational/verifiable questions (Math). R&W "consensus" on reading
  // interpretation is not reliable enough to auto-settle.
  const targets = (data ?? []).filter((q) => (q.section ?? "Math") === "Math") as unknown as QRow[];

  let settled = 0, unresolved = 0, skippedBlind = 0;
  for (const q of targets) {
    // Placeholder text in the stem/choices means the question itself is
    // incomplete — no amount of solving makes it safe to approve.
    const placeholder = findParsePlaceholder(q.question_text as string | null, q.choices);
    if (placeholder) {
      unresolved++;
      const base = ((q.parsing_notes as string | null) || "").trim();
      const note = placeholderNote(placeholder);
      await db.from("questions").update({
        parsing_notes: base && !base.includes("parser placeholder text") ? `${base}; ${note}` : note,
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
      continue;
    }
    const images = await loadImages(q);
    // A question that needs a figure but has none can only be guessed blind —
    // never auto-settle those, no matter how "confident" a text-only solve is.
    if (q.has_image && images.length === 0) {
      skippedBlind++;
      await db.from("questions").update({
        parsing_notes: "Needs figure but none attached — cannot auto-solve; needs human",
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
      continue;
    }
    const runs = await Promise.all([solveOnce(q, 0, images), solveOnce(q, 1, images), solveOnce(q, 2, images)]);
    const [a1, a2, a3] = runs.map((r) => r?.answer ?? null);
    // Unanimous or nothing — never a majority vote (Math Module 001 Q17 got
    // 249 from a 2-of-3 vote; the computed value was 248.2 → 248).
    const runProblems = runs.flatMap((r, i) => (r?.problems ?? []).map((p) => `run ${i + 1}: ${p}`));
    const unanimous = a1 && a2 && a3 && agree(a1, a2) && agree(a2, a3) && runProblems.length === 0;
    if (!unanimous) {
      unresolved++;
      await db.from("questions").update({
        parsing_notes: `Consensus solve NOT unanimous (${a1 ?? "?"}/${a2 ?? "?"}/${a3 ?? "?"})${runProblems.length ? ` — ${runProblems.join(", ").replace(/;/g, ",")}` : ""} — needs human`,
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
      continue;
    }
    // The settled key must fit the type (accepted SPR form, rounding, A–D).
    const keyProblem = keyTypeProblem({ question_type: q.question_type, correct_answer: a1, question_text: q.question_text, choices: q.choices });
    if (keyProblem) {
      unresolved++;
      await db.from("questions").update({
        parsing_notes: `3 solves agreed on ${a1} but ${keyFormNote(keyProblem)} — needs human`,
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
      continue;
    }
    let v = await verify(q, a1, images);
    // Truncation guard: if verifier explanation looks cut off, retry once.
    if (v && v.ok && looksTruncated(v.explanation)) {
      const retry = await verify(q, a1, images);
      if (retry) v = retry;
    }
    // The verifier's own answer and the answer its explanation ends on must
    // both match too (solve vs explanation disagreement → needs human).
    const explained = v ? extractFinalAnswer(v.explanation) : null;
    const verifierDisagrees =
      !!v &&
      v.ok &&
      ((v.ownAnswer.trim() !== "" && !answersAgreeForQuestion(v.ownAnswer, a1, q.question_text)) ||
        (explained !== null && !answersAgreeForQuestion(explained, a1, q.question_text)));
    if (v && verifierDisagrees) {
      unresolved++;
      await db.from("questions").update({
        parsing_notes: `3 solves agreed on ${a1} but the verifier's own work gives ${explained ?? v.ownAnswer} — needs human`,
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
      continue;
    }
    if (v && v.ok && !looksTruncated(v.explanation)) {
      // The key goes through the one key-change path (lib/key-change.ts): the
      // explanation is written after a solve that never saw the key, checked,
      // and saved in the same write. No checked explanation → not approved.
      const { data: full } = await db.from("questions").select(KEY_ROW_SELECT).eq("id", q.id).maybeSingle();
      if (!full) continue;
      const cur = full as AutoFixRow;
      const settledNote = "Auto-settled: 3 independent solves agreed + verified (no answer key available)";
      const keyChanged = (cur.correct_answer ?? "") !== a1;
      const prepared = await prepareKeyChange(
        db as unknown as Parameters<typeof prepareKeyChange>[0],
        { ...cur, correct_answer: a1, parsing_notes: settledNote },
        { live: false, keyChanged, route: "consensus-solve" },
      );
      const update: Record<string, unknown> = { correct_answer: a1, parsing_notes: settledNote, ...prepared.patch, updated_at: new Date().toISOString() };
      if (prepared.ok) {
        settled++;
        update.parsing_status = "Approved";
      } else {
        unresolved++;
      }
      const { data: written } = await db.from("questions").update(update).eq("id", q.id).eq("parsing_status", "Needs Review").select("id");
      // Answers already graded against the old key are re-graded (same as every key-change path).
      if (keyChanged && written?.length) {
        try {
          await rescoreQuestion(db as unknown as Parameters<typeof rescoreQuestion>[0], q.id);
        } catch (e) {
          console.error(`[consensus-resolve] rescore ${q.id}:`, e);
        }
      }
    } else if (v && v.ok && looksTruncated(v.explanation)) {
      // Verifier agreed but its explanation is still truncated after retry.
      unresolved++;
      await db.from("questions").update({
        parsing_notes: `3 solves agreed on ${a1} and verifier confirmed, but ${TRUNCATION_NOTE}`,
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
    } else {
      unresolved++;
      await db.from("questions").update({
        parsing_notes: `3 solves agreed on ${a1} but verifier disagreed — needs human`,
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
    }
  }
  console.log(`[consensus-resolve] module=${moduleId} attempted=${targets.length} settled=${settled} unresolved=${unresolved} skippedBlind=${skippedBlind}`);
  return { attempted: targets.length, settled, unresolved, skippedBlind };
}
