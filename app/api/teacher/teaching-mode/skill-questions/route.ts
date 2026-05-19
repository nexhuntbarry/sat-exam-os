import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestScope } from "@/lib/teacher-access";

// GET /api/teacher/teaching-mode/skill-questions?skill=Linear+equations&limit=10
// Returns candidate practice questions for that skill, sorted by class error
// rate (where the teacher's classes have answer history) and then by
// difficulty descending. Used to seed the quick-create practice set modal.
export async function GET(req: Request) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { searchParams } = new URL(req.url);
  const skill = searchParams.get("skill");
  const limit = Math.min(Number(searchParams.get("limit") ?? 10), 30);

  if (!skill) {
    return NextResponse.json({ error: "skill is required" }, { status: 400 });
  }

  const db = getServiceClient();

  // 1. Pull every approved question with this skill
  const { data: candidates } = await db
    .from("questions")
    .select("id, original_question_number, question_text, domain, skill, difficulty, has_image, module_id")
    .eq("skill", skill)
    .limit(200);

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ questions: [] });
  }

  // 2. Find the teacher's classes' error history for these questions.
  // Sources of history:
  //  - admin: every submission
  //  - direct-assigned tests: every submission on those tests
  //  - class teacher: every submission of their class students (any test)
  const scope = await getTeacherTestScope(db, user);
  const errorRateByQ = new Map<string, { total: number; wrong: number }>();

  let subsQuery = db
    .from("submissions")
    .select("id, test_id, student_id")
    .in("status", ["Submitted", "Late"]);
  const { data: allSubs } = await subsQuery;
  const subs = (allSubs ?? []).filter((s) => {
    if (scope.isAdmin) return true;
    if (scope.directTestIds.has(s.test_id as string)) return true;
    return scope.myStudentIds.has(s.student_id as string);
  });
  void subsQuery;

  const subIds = subs.map((s) => s.id as string);
  if (subIds.length > 0) {
    const qIds = candidates.map((q) => q.id);
    const { data: ars } = await db
      .from("answer_records")
      .select("question_id, is_correct")
      .in("submission_id", subIds)
      .in("question_id", qIds);

    for (const ar of ars ?? []) {
      let e = errorRateByQ.get(ar.question_id);
      if (!e) {
        e = { total: 0, wrong: 0 };
        errorRateByQ.set(ar.question_id, e);
      }
      e.total++;
      if (!ar.is_correct) e.wrong++;
    }
  }

  const difficultyRank: Record<string, number> = { Hard: 3, Medium: 2, Easy: 1 };

  const enriched = candidates
    .map((q) => {
      const stats = errorRateByQ.get(q.id);
      const errorRate = stats && stats.total > 0 ? (stats.wrong / stats.total) * 100 : null;
      return {
        questionId: q.id,
        questionNumber: q.original_question_number,
        questionText: q.question_text,
        domain: q.domain,
        skill: q.skill,
        difficulty: q.difficulty,
        hasImage: q.has_image,
        moduleId: q.module_id,
        classTotal: stats?.total ?? 0,
        classWrong: stats?.wrong ?? 0,
        classErrorRate: errorRate,
      };
    })
    .sort((a, b) => {
      // Highest known class error rate first; otherwise hardest difficulty
      const ar = a.classErrorRate ?? -1;
      const br = b.classErrorRate ?? -1;
      if (br !== ar) return br - ar;
      return (difficultyRank[b.difficulty ?? ""] ?? 0) - (difficultyRank[a.difficulty ?? ""] ?? 0);
    })
    .slice(0, limit);

  return NextResponse.json({ questions: enriched });
}
