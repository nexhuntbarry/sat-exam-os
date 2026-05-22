import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";
import { scaleSectionScore } from "@/lib/scoring";

const MODULE_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};

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

  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { data: assignment } = await db
    .from("test_assignments")
    .select("student_ids, class_group_ids")
    .eq("test_id", testId)
    .maybeSingle();
  if (!assignment) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }
  const studentAllowlist =
    access.mode === "class" ? access.studentAllowlist : null;

  // Fetch test
  const { data: test } = await db
    .from("tests")
    .select(`id, test_name, time_limit_minutes, due_date, open_date, status,
      modules!module_id(module_name, section, module_number)`)
    .eq("id", testId)
    .single();

  if (!test) return NextResponse.json({ error: "Test not found" }, { status: 404 });

  // Roster size for "not started" calculation. For a class-scoped
  // teacher, "assigned" means the intersection of their class roster
  // with the test's student_ids — that's the count they actually
  // teach for this test.
  const assignmentStudentIds: string[] = (assignment.student_ids as string[] | null) ?? [];
  const studentIds = studentAllowlist
    ? assignmentStudentIds.filter((sid) => studentAllowlist!.has(sid))
    : assignmentStudentIds;

  // Fetch submissions with student profiles. Filter to the allowlist
  // when present so the class teacher only sees their own students'
  // rows + averages.
  let submissionsQuery = db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds, scaled_score, session_id, adaptive_track,
      users!inner(display_name, email, student_profiles(grade, class_group))
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: false });
  if (studentAllowlist) {
    submissionsQuery = submissionsQuery.in(
      "student_id",
      Array.from(studentAllowlist),
    );
  }
  const { data: submissions } = await submissionsQuery;

  type RawSub = {
    id: string;
    student_id: string;
    status: string;
    score: number | null;
    correct_count: number | null;
    total_questions: number | null;
    percentage: number | string | null;
    submitted_at: string | null;
    time_spent_seconds: number | null;
    scaled_score: number | null;
    session_id: string | null;
    adaptive_track: string | null;
    users: {
      display_name: string;
      email: string;
      student_profiles?:
        | { grade?: string; class_group?: string }
        | { grade?: string; class_group?: string }[]
        | null;
    };
  };
  const subs = (submissions ?? []) as unknown as RawSub[];

  // Two-module attempts produce two submission rows sharing a
  // session_id; group siblings so the dashboard shows one row per
  // attempt with a combined headline plus per-module breakdown.
  // Legacy single-module rows (session_id NULL) stay as their own
  // group keyed by submission id.
  const sessionGroups = new Map<string, RawSub[]>();
  for (const s of subs) {
    const key = s.session_id ?? `solo:${s.id}`;
    const list = sessionGroups.get(key) ?? [];
    list.push(s);
    sessionGroups.set(key, list);
  }

  type StudentRow = {
    submissionId: string;
    studentId: string;
    studentName: string;
    email: string;
    grade: string | null;
    classGroup: string | null;
    status: string;
    score: number | null;
    percentage: number | null;
    scaledScore: number | null;
    correctCount: number;
    totalQuestions: number;
    timeSpentSeconds: number | null;
    submittedAt: string | null;
    modules?: {
      submissionId: string;
      label: string;
      correctCount: number;
      totalQuestions: number;
      percentage: number | null;
      scaledScore: number | null;
    }[];
  };

  const studentRows: StudentRow[] = [];
  for (const list of sessionGroups.values()) {
    const sorted = [...list].sort((a, b) => {
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      return rank(a.adaptive_track) - rank(b.adaptive_track);
    });
    const head = sorted[0];
    const u = head.users;
    const spRaw = u.student_profiles ?? null;
    const sp = (Array.isArray(spRaw) ? spRaw[0] : spRaw) as
      | { grade?: string; class_group?: string }
      | null;

    if (sorted.length === 1) {
      const p = head.percentage != null ? Number(head.percentage) : null;
      studentRows.push({
        submissionId: head.id,
        studentId: head.student_id,
        studentName: u.display_name,
        email: u.email,
        grade: sp?.grade ?? null,
        classGroup: sp?.class_group ?? null,
        status: head.status,
        score: head.score != null ? Number(head.score) : null,
        percentage: p,
        scaledScore: head.scaled_score ?? (p != null ? scaleSectionScore(p) : null),
        correctCount: head.correct_count ?? 0,
        totalQuestions: head.total_questions ?? 0,
        timeSpentSeconds: head.time_spent_seconds ?? null,
        submittedAt: head.submitted_at ?? null,
      });
      continue;
    }
    const correct = sorted.reduce((s, r) => s + (r.correct_count ?? 0), 0);
    const total = sorted.reduce((s, r) => s + (r.total_questions ?? 0), 0);
    const time = sorted.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0);
    const pct = total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
    const statuses = sorted.map((r) => r.status);
    const status = statuses.includes("In Progress")
      ? "In Progress"
      : statuses.includes("Late")
      ? "Late"
      : statuses[statuses.length - 1] ?? "Submitted";
    const lastSubmittedAt =
      sorted
        .map((r) => r.submitted_at)
        .filter((d): d is string => !!d)
        .sort()
        .pop() ?? null;
    studentRows.push({
      // The detail link routes to the Module 2 (last) submission so the
      // result view can stitch both modules via session_id.
      submissionId: sorted[sorted.length - 1].id,
      studentId: head.student_id,
      studentName: u.display_name,
      email: u.email,
      grade: sp?.grade ?? null,
      classGroup: sp?.class_group ?? null,
      status,
      score: null,
      percentage: pct,
      scaledScore: pct != null ? scaleSectionScore(pct) : null,
      correctCount: correct,
      totalQuestions: total,
      timeSpentSeconds: time,
      submittedAt: lastSubmittedAt,
      modules: sorted.map((r) => {
        const p = r.percentage != null ? Number(r.percentage) : null;
        return {
          submissionId: r.id,
          label: MODULE_LABEL[r.adaptive_track ?? ""] ?? "Module",
          correctCount: r.correct_count ?? 0,
          totalQuestions: r.total_questions ?? 0,
          percentage: p,
          scaledScore: r.scaled_score ?? (p != null ? scaleSectionScore(p) : null),
        };
      }),
    });
  }

  // Sort newest-first to match the legacy submitted_at desc ordering.
  studentRows.sort((a, b) => {
    if (a.submittedAt && b.submittedAt) return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });

  // Summary stats — computed over attempts (grouped rows) so multi-
  // module sessions don't double-count.
  const submitted = studentRows.filter((r) => r.status === "Submitted" || r.status === "Late");
  // Clamp at 0 — for class-scoped teachers, `studentIds` is the
  // intersection of assignment.student_ids and the class roster, while
  // `studentRows` already filters to that roster. Students who
  // submitted but weren't explicitly on assignment.student_ids (e.g.
  // test was assigned by class_group, not by individual) would
  // otherwise produce a negative "not started" count.
  const notStarted = Math.max(0, studentIds.length - studentRows.length);
  const inProgress = studentRows.filter((r) => r.status === "In Progress").length;
  const late = studentRows.filter((r) => r.status === "Late").length;

  const scores = submitted.map((r) => r.percentage ?? 0);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  const highestSub = submitted.length > 0
    ? submitted.reduce((a, b) => ((a.percentage ?? 0) > (b.percentage ?? 0) ? a : b))
    : null;
  const lowestSub = submitted.length > 0
    ? submitted.reduce((a, b) => ((a.percentage ?? 0) < (b.percentage ?? 0) ? a : b))
    : null;

  const avgTime = submitted.length > 0
    ? submitted.reduce((sum, r) => sum + (r.timeSpentSeconds ?? 0), 0) / submitted.length
    : null;

  // Score distribution buckets (0-10%, 10-20%, ..., 90-100%)
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    label: `${i * 10}-${(i + 1) * 10}%`,
    count: 0,
  }));
  for (const r of submitted) {
    const pct = r.percentage ?? 0;
    const idx = Math.min(Math.floor(pct / 10), 9);
    buckets[idx].count++;
  }

  // Submission timeline (group by day)
  const timelineMap: Record<string, number> = {};
  for (const r of submitted) {
    if (!r.submittedAt) continue;
    const day = r.submittedAt.slice(0, 10);
    timelineMap[day] = (timelineMap[day] ?? 0) + 1;
  }
  const timeline = Object.entries(timelineMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

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
        percentage: highestSub.percentage ?? 0,
        studentName: highestSub.studentName,
      } : null,
      lowestScore: lowestSub ? {
        percentage: lowestSub.percentage ?? 0,
        studentName: lowestSub.studentName,
      } : null,
      avgTimeSeconds: avgTime,
    },
    scoreDistribution: buckets,
    submissionTimeline: timeline,
    students: studentRows,
  });
}
