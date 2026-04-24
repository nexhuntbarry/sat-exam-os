import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

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
      allow_retake, status, created_at,
      modules!inner(module_name, section, module_number)
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
    .select("test_id, id, status, score, percentage, submitted_at, attempt_number")
    .eq("student_id", user.userId)
    .in("test_id", testIds)
    .order("attempt_number", { ascending: false });

  // Build latest submission map
  const subMap: Record<string, { id: string; status: string; score: number | null; percentage: number | null; submitted_at: string | null }> = {};
  for (const s of submissions ?? []) {
    if (!subMap[s.test_id]) {
      subMap[s.test_id] = {
        id: s.id,
        status: s.status,
        score: s.score,
        percentage: s.percentage,
        submitted_at: s.submitted_at,
      };
    }
  }

  const enriched = (tests ?? []).map((t) => {
    const sub = subMap[t.id];
    let testStatus = "Not Started";
    if (sub) {
      if (sub.status === "In Progress") testStatus = "In Progress";
      else if (sub.status === "Submitted" || sub.status === "Late") testStatus = "Submitted";
    }
    return {
      ...t,
      submission: sub ?? null,
      testStatus,
    };
  });

  return NextResponse.json({ data: enriched });
}
