import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, onSide } from "@/lib/qa";
import { previewKeyChange } from "@/lib/key-check";
import { keyTypeProblem } from "@/lib/answer-key";
import { liveQuestionIds } from "@/lib/live-questions";

// POST /api/admin/review-queue/preview
// Body: { id, correct_answer }
//
// Read-only, like /api/admin/key-check/preview but for question reviewers:
// which graded answers would flip if the key became `correct_answer`, whether
// the key fits the question type, and whether the question is in a live test.
export async function POST(req: Request) {
  const auth = await requireQuestionReviewer();
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  const nextKey = typeof body.correct_answer === "string" ? body.correct_answer.trim() : "";
  if (!id || !nextKey) return NextResponse.json({ error: "id and correct_answer are required" }, { status: 400 });

  const db = getServiceClient();
  const { data: q } = await db
    .from("questions")
    .select("id, question_text, choices, question_type, correct_answer, parsing_status")
    .eq("id", id)
    .maybeSingle();
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  const problem = keyTypeProblem({
    question_type: q.question_type as string | null,
    correct_answer: nextKey,
    question_text: q.question_text as string | null,
    choices: q.choices,
  });
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
