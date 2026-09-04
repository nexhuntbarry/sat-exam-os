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
import { fetchImageAsBase64 } from "@/lib/ai/solve-question";

type DbClient = ReturnType<typeof getServiceClient>;

type ImageBlock = { type: "image"; image: string; mediaType: string };

const SolveSchema = z.object({
  answer: z.string().describe("The final answer. MCQ: single letter A/B/C/D. SPR: the numeric/text value."),
  explanation: z.string().describe("Complete step-by-step solution."),
});
const VerifySchema = z.object({
  correct: z.boolean().describe("Is the proposed answer actually correct for this question?"),
  reason: z.string(),
});

const SOLVE_SYS = `You are an expert SAT solver. Solve the question rigorously and independently. For MCQ give a single letter A/B/C/D; for student-produced response give the exact value. Show your work in the explanation.`;
const VERIFY_SYS = `You are a strict SAT answer checker. You are given a question and a PROPOSED answer. Work the problem yourself from scratch, then judge whether the proposed answer is correct. Be skeptical — only say correct=true if you independently arrive at the same answer.`;

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
    ? (q.choices as unknown[]).map((c) => (typeof c === "string" ? c : `${(c as { label?: string }).label}) ${(c as { text?: string }).text}`)).join("\n")
    : "";
}

async function solveOnce(q: QRow, variant: number, images: ImageBlock[]): Promise<string | null> {
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
    return r.object.answer;
  } catch {
    return null;
  }
}

async function verify(q: QRow, answer: string, images: ImageBlock[]): Promise<{ ok: boolean; explanation: string } | null> {
  try {
    const r = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: VerifySchema,
      system: VERIFY_SYS,
      maxRetries: 2,
      messages: [{ role: "user", content: [...images, { type: "text", text: `Question ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${choicesText(q)}${images.length ? "\n\n(Refer to the attached figure.)" : ""}\n\nProposed answer: ${answer}\n\nIs it correct?` }] }],
    });
    return { ok: r.object.correct, explanation: r.object.reason };
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
    .is("official_answer", null);
  // Only computational/verifiable questions (Math). R&W "consensus" on reading
  // interpretation is not reliable enough to auto-settle.
  const targets = (data ?? []).filter((q) => (q.section ?? "Math") === "Math") as unknown as QRow[];

  let settled = 0, unresolved = 0, skippedBlind = 0;
  for (const q of targets) {
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
    const [a1, a2, a3] = await Promise.all([solveOnce(q, 0, images), solveOnce(q, 1, images), solveOnce(q, 2, images)]);
    const unanimous = a1 && a2 && a3 && agree(a1, a2) && agree(a2, a3);
    if (!unanimous) {
      unresolved++;
      await db.from("questions").update({
        parsing_notes: `Consensus solve NOT unanimous (${a1 ?? "?"}/${a2 ?? "?"}/${a3 ?? "?"}) — needs human`,
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
      continue;
    }
    const v = await verify(q, a1, images);
    if (v && v.ok) {
      settled++;
      await db.from("questions").update({
        correct_answer: a1,
        explanation: v.explanation,
        parsing_status: "Approved",
        parsing_notes: "Auto-settled: 3 independent solves agreed + verified (no answer key available)",
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
