import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";

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

  // Class teachers can export their class's results. Direct-assigned
  // teachers get the full test export.
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch test name + questions
  const { data: test } = await db
    .from("tests")
    .select(
      "id, test_name, module_id, module_2_id, question_ids, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id",
    )
    .eq("id", testId)
    .single();

  if (!test) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let questionQuery = db
    .from("questions")
    .select("id, original_question_number, correct_answer")
    .order("original_question_number", { ascending: true });

  const qIds = test.question_ids as string[] | null;
  if (!test.is_adaptive && qIds && qIds.length > 0) {
    questionQuery = questionQuery.in("id", qIds);
  } else if (test.is_adaptive) {
    const adaptiveModuleIds = [
      test.module_1_id,
      test.module_2_easy_id,
      test.module_2_hard_id,
    ].filter((x): x is string => Boolean(x));
    if (adaptiveModuleIds.length > 0) {
      questionQuery = questionQuery.in("module_id", adaptiveModuleIds);
    }
  } else if (test.module_2_id) {
    questionQuery = questionQuery.in(
      "module_id",
      [test.module_id, test.module_2_id].filter((x): x is string => Boolean(x)),
    );
  } else if (test.module_id) {
    questionQuery = questionQuery.eq("module_id", test.module_id);
  }

  const { data: questions } = await questionQuery;
  const questionList = questions ?? [];

  // Fetch submissions. Class teachers see only their class roster.
  let submissionsQuery = db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds,
      users!inner(display_name, email, student_profiles(grade, class_group))
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: true });
  if (access.mode === "class" && access.studentAllowlist) {
    submissionsQuery = submissionsQuery.in(
      "student_id",
      Array.from(access.studentAllowlist),
    );
  }
  const { data: submissions } = await submissionsQuery;

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
