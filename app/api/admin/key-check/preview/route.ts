import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, onSide } from "@/lib/qa";
import { previewKeyChange } from "@/lib/key-check";
import { keyTypeProblem } from "@/lib/answer-key";
import { liveQuestionIds } from "@/lib/live-questions";

// POST /api/admin/key-check/preview
// Body: { id, correct_answer?, question_type?, clear_choices? }
//
// Read-only. What applying this correction would do: whether the result
// still mismatches, whether the question is in a live test, and every graded
// attempt whose correctness would flip (student, test, old → new score).
export async function POST(req: Request) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const db = getServiceClient();
  const { data: q } = await db
    .from("questions")
    .select("id, question_text, choices, question_type, correct_answer, parsing_status")
    .eq("id", id)
    .maybeSingle();
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  const nextType = typeof body.question_type === "string" ? body.question_type : (q.question_type as string | null);
  const nextKey = typeof body.correct_answer === "string" ? body.correct_answer.trim() : ((q.correct_answer as string | null) ?? "");
  const nextChoices = body.clear_choices || nextType === "Student Produced Response" ? [] : q.choices;
  const problem = keyTypeProblem({ question_type: nextType, correct_answer: nextKey, question_text: q.question_text as string | null, choices: nextChoices });

  const qaIds = await getQaUserIds();
  const preview = await previewKeyChange(db, id, nextKey, (studentId) => onSide(studentId, qaIds, auth.isQa));
  const live = q.parsing_status === "Approved" ? (await liveQuestionIds(db, [id])).has(id) : false;
  return NextResponse.json({
    ...preview,
    keyChanged: (q.correct_answer ?? "") !== nextKey,
    stillMismatched: problem?.reason ?? null,
    live,
  });
}
