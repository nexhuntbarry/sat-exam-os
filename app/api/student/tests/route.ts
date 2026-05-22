import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { scaleSectionScore } from "@/lib/scoring";

const MODULE_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};

// GET /api/student/tests
export async function GET() {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const db = getServiceClient();

  // Get student's class groups
  const { data: membership } = await db
    .from("class_group_members")
    .select("class_group_id")
    .eq("student_id", user.userId);

  const classGroupIds = (membership ?? []).map((m) => m.class_group_id);

  // Find assignments where student is directly assigned or in a class group
  const { data: allAssignments } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids");

  const matchedTestIds = new Set<string>();
  for (const a of allAssignments ?? []) {
    const studentIds: string[] = a.student_ids ?? [];
    const cgIds: string[] = a.class_group_ids ?? [];
    if (studentIds.includes(user.userId)) {
      matchedTestIds.add(a.test_id);
    } else if (classGroupIds.some((cg) => cgIds.includes(cg))) {
      matchedTestIds.add(a.test_id);
    }
  }

  if (matchedTestIds.size === 0) {
    return NextResponse.json({ data: [] });
  }

  const testIds = Array.from(matchedTestIds);

  const { data: tests, error } = await db
    .from("tests")
    .select(`
      id, test_name, module_id, time_limit_minutes, open_date, due_date,
      allow_retake, status, created_at, is_adaptive,
      modules!module_id(module_name, section, module_number)
    `)
    .in("id", testIds)
    .in("status", ["Published", "Closed"])
    .order("due_date", { ascending: true });

  if (error) {
    console.error("[student/tests/get]", error);
    return NextResponse.json({ error: "Failed to fetch tests" }, { status: 500 });
  }

  // Get submissions for this student
  const { data: submissions } = await db
    .from("submissions")
    .select(
      "test_id, id, status, score, correct_count, total_questions, percentage, submitted_at, attempt_number, session_id, adaptive_track",
    )
    .eq("student_id", user.userId)
    .in("test_id", testIds)
    .order("attempt_number", { ascending: false });

  type SubRow = {
    test_id: string;
    id: string;
    status: string;
    score: number | null;
    correct_count: number | null;
    total_questions: number | null;
    percentage: number | string | null;
    submitted_at: string | null;
    attempt_number: number | null;
    session_id: string | null;
    adaptive_track: string | null;
  };

  // Group submissions per test, then collapse two-module session
  // siblings into one attempt with module breakdown. The previous map
  // was first-match-wins, which surfaced only one module's percentage
  // for two-module tests.
  const byTest = new Map<string, SubRow[]>();
  for (const s of (submissions ?? []) as SubRow[]) {
    const list = byTest.get(s.test_id) ?? [];
    list.push(s);
    byTest.set(s.test_id, list);
  }

  type ModuleView = {
    label: string;
    submissionId: string;
    correctCount: number;
    totalQuestions: number;
    percentage: number | null;
    scaledScore: number | null;
  };
  type Attempt = {
    id: string;
    status: string;
    score: number | null;
    percentage: number | null;
    scaledScore: number | null;
    correctCount: number;
    totalQuestions: number;
    submittedAt: string | null;
    detailSubmissionId: string;
    isMultiModule: boolean;
    modules: ModuleView[];
  };

  function buildLatestAttempt(rows: SubRow[]): Attempt | null {
    if (rows.length === 0) return null;
    const latestAttempt = rows[0].attempt_number ?? 1;
    const sameAttempt = rows.filter((r) => (r.attempt_number ?? 1) === latestAttempt);

    const bySession = new Map<string, SubRow[]>();
    const singletons: SubRow[] = [];
    for (const r of sameAttempt) {
      if (r.session_id) {
        const list = bySession.get(r.session_id) ?? [];
        list.push(r);
        bySession.set(r.session_id, list);
      } else {
        singletons.push(r);
      }
    }

    for (const list of bySession.values()) {
      if (list.length >= 2) {
        const sorted = [...list].sort((a, b) => {
          const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
          return rank(a.adaptive_track) - rank(b.adaptive_track);
        });
        const correct = sorted.reduce((s, r) => s + (r.correct_count ?? 0), 0);
        const total = sorted.reduce((s, r) => s + (r.total_questions ?? 0), 0);
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
        return {
          id: sorted[0].session_id ?? sorted[0].id,
          status,
          score: null,
          percentage: pct,
          scaledScore: pct != null ? scaleSectionScore(pct) : null,
          correctCount: correct,
          totalQuestions: total,
          submittedAt: lastSubmittedAt,
          detailSubmissionId: sorted[sorted.length - 1].id,
          isMultiModule: true,
          modules: sorted.map((r) => {
            const p = r.percentage != null ? Number(r.percentage) : null;
            return {
              label: MODULE_LABEL[r.adaptive_track ?? ""] ?? "Module",
              submissionId: r.id,
              correctCount: r.correct_count ?? 0,
              totalQuestions: r.total_questions ?? 0,
              percentage: p,
              scaledScore: p != null ? scaleSectionScore(p) : null,
            };
          }),
        };
      }
    }
    const first = singletons[0] ?? sameAttempt[0];
    if (!first) return null;
    const p = first.percentage != null ? Number(first.percentage) : null;
    return {
      id: first.id,
      status: first.status,
      score: first.score,
      percentage: p,
      scaledScore: p != null ? scaleSectionScore(p) : null,
      correctCount: first.correct_count ?? 0,
      totalQuestions: first.total_questions ?? 0,
      submittedAt: first.submitted_at,
      detailSubmissionId: first.id,
      isMultiModule: false,
      modules: [],
    };
  }

  const enriched = (tests ?? []).map((t) => {
    const rows = byTest.get(t.id) ?? [];
    const attempt = buildLatestAttempt(rows);
    let testStatus = "Not Started";
    if (attempt) {
      if (attempt.status === "In Progress") testStatus = "In Progress";
      else if (attempt.status === "Submitted" || attempt.status === "Late")
        testStatus = "Submitted";
    }
    // Preserve legacy `submission` shape so existing API consumers keep
    // working, while exposing the richer combined-attempt view + per-
    // module breakdown for new UIs.
    return {
      ...t,
      submission: attempt
        ? {
            id: attempt.detailSubmissionId,
            status: attempt.status,
            score: attempt.score,
            percentage: attempt.percentage,
            submitted_at: attempt.submittedAt,
          }
        : null,
      attempt,
      testStatus,
    };
  });

  return NextResponse.json({ data: enriched });
}
