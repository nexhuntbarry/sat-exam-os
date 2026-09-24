import type { getServiceClient } from "@/lib/supabase";

type DbClient = ReturnType<typeof getServiceClient>;

// ── Per-question completeness gate ───────────────────────────────────
// A question is only fit to be Approved/live if it's actually complete:
// a real stem, four non-empty choices for MCQ, and a stored answer. Anything
// missing gets demoted to Needs Review so an incomplete question never reaches
// students. Runs before auto-promote.
export async function enforceCompleteness(
  moduleId: string,
  db: DbClient,
): Promise<{ checked: number; demoted: number; reasons: Record<string, number> }> {
  const { data } = await db
    .from("questions")
    .select("id, original_question_number, question_text, choices, correct_answer, question_type, parsing_status, parsing_notes")
    .eq("module_id", moduleId);
  const rows = (data ?? []) as {
    id: string;
    original_question_number: number;
    question_text: string | null;
    choices: unknown;
    correct_answer: string | null;
    question_type: string | null;
    parsing_status: string;
    parsing_notes: string | null;
  }[];

  const reasons: Record<string, number> = {};
  let demoted = 0;
  for (const q of rows) {
    if (q.parsing_status === "Needs Review" || q.parsing_status === "Rejected") continue; // already flagged
    const problems: string[] = [];
    if (!q.question_text || q.question_text.trim().length < 15) problems.push("empty/short stem");
    if (q.question_type === "Multiple Choice") {
      const ch = Array.isArray(q.choices) ? q.choices : [];
      const good = ch.filter((c) => {
        const t = (typeof c === "string" ? c : (c as { text?: string })?.text) || "";
        return t.trim().length > 0 && !/partially visible|no text|placeholder|not visible/i.test(t);
      });
      if (good.length < 4) problems.push(`${good.length}/4 choices`);
    }
    if (!q.correct_answer || !q.correct_answer.trim()) problems.push("no answer");
    if (problems.length === 0) continue;

    demoted++;
    for (const p of problems) reasons[p] = (reasons[p] ?? 0) + 1;
    const base = (q.parsing_notes || "").trim();
    const note = `Completeness gate: ${problems.join(", ")}`;
    await db
      .from("questions")
      .update({
        parsing_status: "Needs Review",
        parsing_notes: base && !base.includes("Completeness gate") ? `${base}; ${note}` : note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", q.id);
  }
  console.log(`[completeness-gate] module=${moduleId} checked=${rows.length} demoted=${demoted} reasons=${JSON.stringify(reasons)}`);
  return { checked: rows.length, demoted, reasons };
}

// ── Question-number contiguity check ─────────────────────────────────
// SAT modules number their questions 1..N with no gaps. A gap means the parser
// dropped a question. This reports the gap so the module can be flagged /
// re-parsed (it can't invent the missing question, so it doesn't auto-fix).
export async function checkNumberContiguity(
  moduleId: string,
  db: DbClient,
): Promise<{ count: number; expectedMax: number; missing: number[] }> {
  const { data } = await db
    .from("questions")
    .select("original_question_number")
    .eq("module_id", moduleId)
    .order("original_question_number");
  const nums = (data ?? []).map((r) => r.original_question_number).filter((n) => typeof n === "number");
  if (nums.length === 0) return { count: 0, expectedMax: 0, missing: [] };
  const max = Math.max(...nums);
  const present = new Set(nums);
  const missing: number[] = [];
  for (let i = 1; i <= max; i++) if (!present.has(i)) missing.push(i);
  if (missing.length > 0) {
    console.warn(`[contiguity] module=${moduleId} has gaps — missing question numbers: ${missing.join(", ")}`);
  }
  return { count: nums.length, expectedMax: max, missing };
}
