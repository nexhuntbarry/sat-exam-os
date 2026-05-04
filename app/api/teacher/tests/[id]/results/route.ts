import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/tests/[id]/results
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId } = await params;
  const db = getServiceClient();

  // Verify teacher access
  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids, student_ids, class_group_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  if (
    user.role !== "admin" &&
    !(assignment.teacher_ids as string[]).includes(user.userId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch test
  const { data: test } = await db
    .from("tests")
    .select(`id, test_name, time_limit_minutes, due_date, open_date, status,
      modules!inner(module_name, section, module_number)`)
    .eq("id", testId)
    .single();

  if (!test) return NextResponse.json({ error: "Test not found" }, { status: 404 });

  const studentIds: string[] = assignment.student_ids ?? [];

  // Fetch submissions with student profiles
  const { data: submissions } = await db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds,
      users!inner(display_name, email, student_profiles(grade, class_group))
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: false });

  const subs = submissions ?? [];

  // Build student rows
  const studentRows = subs.map((s) => {
    const u = s.users as unknown as {
      display_name: string;
      email: string;
      student_profiles?: { grade?: string; class_group?: string } | { grade?: string; class_group?: string }[] | null;
    };
    const spRaw = u.student_profiles ?? null;
    const sp = (Array.isArray(spRaw) ? spRaw[0] : spRaw) as { grade?: string; class_group?: string } | null;
    return {
      submissionId: s.id,
      studentName: u.display_name,
      email: u.email,
      grade: sp?.grade ?? null,
      classGroup: sp?.class_group ?? null,
      status: s.status,
      score: s.score != null ? Number(s.score) : null,
      percentage: s.percentage != null ? Number(s.percentage) : null,
      correctCount: s.correct_count ?? 0,
      totalQuestions: s.total_questions ?? 0,
      timeSpentSeconds: s.time_spent_seconds ?? null,
      submittedAt: s.submitted_at ?? null,
    };
  });

  // Summary stats
  const submitted = subs.filter((s) => s.status === "Submitted" || s.status === "Late");
  const notStarted = studentIds.length - subs.length;
  const inProgress = subs.filter((s) => s.status === "In Progress").length;
  const late = subs.filter((s) => s.status === "Late").length;

  const scores = submitted.map((s) => Number(s.percentage ?? 0));
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  const highestSub = submitted.length > 0
    ? submitted.reduce((a, b) => (Number(a.percentage) > Number(b.percentage) ? a : b))
    : null;
  const lowestSub = submitted.length > 0
    ? submitted.reduce((a, b) => (Number(a.percentage) < Number(b.percentage) ? a : b))
    : null;

  const avgTime = submitted.length > 0
    ? submitted.reduce((sum, s) => sum + (s.time_spent_seconds ?? 0), 0) / submitted.length
    : null;

  // Score distribution buckets (0-10%, 10-20%, ..., 90-100%)
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    label: `${i * 10}-${(i + 1) * 10}%`,
    count: 0,
  }));
  for (const s of submitted) {
    const pct = Number(s.percentage ?? 0);
    const idx = Math.min(Math.floor(pct / 10), 9);
    buckets[idx].count++;
  }

  // Submission timeline (group by day)
  const timelineMap: Record<string, number> = {};
  for (const s of submitted) {
    if (!s.submitted_at) continue;
    const day = s.submitted_at.slice(0, 10);
    timelineMap[day] = (timelineMap[day] ?? 0) + 1;
  }
  const timeline = Object.entries(timelineMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const getStudentName = (sub: typeof subs[number]) => {
    const u = sub.users as unknown as { display_name: string };
    return u.display_name;
  };

  return NextResponse.json({
    test,
    stats: {
      totalAssigned: studentIds.length,
      submittedCount: submitted.length,
      notStartedCount: notStarted,
      inProgressCount: inProgress,
      lateCount: late,
      avgScore,
      highestScore: highestSub ? {
        percentage: Number(highestSub.percentage),
        studentName: getStudentName(highestSub),
      } : null,
      lowestScore: lowestSub ? {
        percentage: Number(lowestSub.percentage),
        studentName: getStudentName(lowestSub),
      } : null,
      avgTimeSeconds: avgTime,
    },
    scoreDistribution: buckets,
    submissionTimeline: timeline,
    students: studentRows,
  });
}
