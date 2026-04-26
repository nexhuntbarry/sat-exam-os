import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { solveQuestionsAndPersist } from "@/lib/ai/solve-question";
import type { ParsedQuestion } from "@/lib/ai/parse-pdf";

export const maxDuration = 300;

// POST /api/admin/modules/[id]/run-solver
// Re-runs the solver pass on every question in a module that's missing an
// explanation. Used to backfill modules that were parsed before the inline
// solver fix landed (or any module where solver crashed).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const db = getServiceClient();

  const { data: rows, error } = await db
    .from("questions")
    .select("original_question_number, question_text, choices, question_type, image_urls")
    .eq("module_id", id)
    .order("original_question_number");
  if (error || !rows) {
    return NextResponse.json({ error: "Failed to fetch questions" }, { status: 500 });
  }

  const { data: mod } = await db
    .from("modules")
    .select("section, difficulty")
    .eq("id", id)
    .single();
  const section = (mod?.section ?? "Math") as "Math" | "Reading & Writing";

  const parsed: ParsedQuestion[] = rows.map((r) => ({
    original_question_number: r.original_question_number,
    question_text: r.question_text,
    choices: (r.choices ?? []) as ParsedQuestion["choices"],
    correct_answer: null,
    explanation: null,
    difficulty: "Medium",
    domain: "",
    skill: "",
    concept: "",
    question_type: r.question_type as ParsedQuestion["question_type"],
    has_image: false,
    has_table: false,
    has_formula: false,
    page_number: 1,
    ai_confidence_score: 1,
    image_regions: [],
    section,
  } as unknown as ParsedQuestion));

  const imagesByQuestion = new Map<number, { urls: string[] }>();
  for (const r of rows) {
    if (Array.isArray(r.image_urls) && r.image_urls.length > 0) {
      imagesByQuestion.set(r.original_question_number, { urls: r.image_urls });
    }
  }

  const t0 = Date.now();
  const stats = await solveQuestionsAndPersist(
    parsed,
    imagesByQuestion,
    id,
    db,
    auth.userId,
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  return NextResponse.json({
    ok: true,
    elapsed_s: parseFloat(elapsed),
    ...stats,
  });
}
