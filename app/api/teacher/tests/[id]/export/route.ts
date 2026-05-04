import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/tests/[id]/export
// Streams a CSV of all student results
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId } = await params;
  const db = getServiceClient();

  // Verify access
  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (
    user.role !== "admin" &&
    !(assignment.teacher_ids as string[]).includes(user.userId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch test name + questions
  const { data: test } = await db
    .from("tests")
    .select("id, test_name, module_id, question_ids")
    .eq("id", testId)
    .single();

  if (!test) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let questionQuery = db
    .from("questions")
    .select("id, original_question_number, correct_answer")
    .order("original_question_number", { ascending: true });

  const qIds = test.question_ids as string[] | null;
  if (qIds && qIds.length > 0) {
    questionQuery = questionQuery.in("id", qIds);
  } else {
    questionQuery = questionQuery.eq("module_id", test.module_id);
  }

  const { data: questions } = await questionQuery;
  const questionList = questions ?? [];

  // Fetch submissions
  const { data: submissions } = await db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds,
      users!inner(display_name, email, student_profiles(grade, class_group))
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: true });

  const subs = submissions ?? [];
  if (subs.length === 0) {
    const headers = new Headers({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="test-results.csv"`,
    });
    return new Response("No submissions yet.", { headers });
  }

  const subIds = subs.map((s) => s.id);

  // Fetch all answer records
  const { data: answerRecords } = await db
    .from("answer_records")
    .select("submission_id, question_id, student_answer")
    .in("submission_id", subIds);

  // Build answer map: submissionId -> questionId -> student_answer
  const answerMap: Record<string, Record<string, string>> = {};
  for (const ar of answerRecords ?? []) {
    if (!answerMap[ar.submission_id]) answerMap[ar.submission_id] = {};
    answerMap[ar.submission_id][ar.question_id] = ar.student_answer ?? "";
  }

  // Build CSV via ReadableStream for large datasets
  const qHeaders = questionList.map((q) => `Q${q.original_question_number}`).join(",");
  const csvHeader = `Student,Email,Grade,Class,Status,Score,Correct,Total,Percentage,Time Spent,Submitted At,${qHeaders}\n`;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(csvHeader));

      for (const sub of subs) {
        const u = sub.users as unknown as { display_name: string; email: string };
        const usersWithProfile = sub.users as unknown as {
          display_name: string;
          email: string;
          student_profiles?: { grade?: string; class_group?: string } | { grade?: string; class_group?: string }[] | null;
        };
        const spRaw = usersWithProfile.student_profiles ?? null;
        const sp = (Array.isArray(spRaw) ? spRaw[0] : spRaw) as { grade?: string; class_group?: string } | null;

        const timeSpent = sub.time_spent_seconds != null
          ? `${Math.floor(sub.time_spent_seconds / 60)}m ${sub.time_spent_seconds % 60}s`
          : "";

        const submittedAt = sub.submitted_at
          ? new Date(sub.submitted_at).toISOString()
          : "";

        const pct = sub.percentage != null ? Number(sub.percentage).toFixed(1) + "%" : "";

        const questionAnswers = questionList
          .map((q) => answerMap[sub.id]?.[q.id] ?? "")
          .join(",");

        const row = [
          `"${(u.display_name ?? "").replace(/"/g, '""')}"`,
          `"${(u.email ?? "").replace(/"/g, '""')}"`,
          sp?.grade ?? "",
          `"${(sp?.class_group ?? "").replace(/"/g, '""')}"`,
          sub.status,
          sub.score ?? "",
          sub.correct_count ?? "",
          sub.total_questions ?? "",
          pct,
          timeSpent,
          submittedAt,
          questionAnswers,
        ].join(",") + "\n";

        controller.enqueue(new TextEncoder().encode(row));
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${test.test_name.replace(/[^a-z0-9]/gi, "_")}-results.csv"`,
      "Transfer-Encoding": "chunked",
    },
  });
}
