import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestScope } from "@/lib/teacher-access";

// GET /api/teacher/teaching-mode/skill-stats?domain=Algebra
// Returns top weakest skills (by error rate) within the requested domain,
// aggregated across every submission in the teacher's assigned tests.
// If no domain is provided, returns the list of available domains so the UI
// can populate the pills.
export async function GET(req: Request) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain");

  const db = getServiceClient();

  const scope = await getTeacherTestScope(db, user);
  let testIds: string[];
  if (scope.isAdmin) {
    const { data: all } = await db.from("test_assignments").select("test_id");
    testIds = (all ?? []).map((a) => a.test_id as string);
  } else {
    const union = new Set<string>([
      ...Array.from(scope.directTestIds),
      ...Array.from(scope.classTestIds),
    ]);
    testIds = Array.from(union);
  }
  if (testIds.length === 0) {
    return NextResponse.json({ domains: [], skills: [] });
  }

  // Get every Submitted/Late submission for those tests. Class teachers
  // get a denominator restricted to their own students (so their
  // weakest-skill ranking reflects their actual class, not a global
  // population they don't teach).
  let subsQuery = db
    .from("submissions")
    .select("id, student_id, test_id")
    .in("test_id", testIds)
    .in("status", ["Submitted", "Late"]);
  const { data: subsRaw } = await subsQuery;
  const subs = (subsRaw ?? []).filter((s) => {
    if (scope.isAdmin) return true;
    if (scope.directTestIds.has(s.test_id as string)) return true;
    return scope.myStudentIds.has(s.student_id as string);
  });
  void subsQuery;

  const subIds = (subs ?? []).map((s) => s.id);
  if (subIds.length === 0) return NextResponse.json({ domains: [], skills: [] });

  // Pull all answer records (cap not strictly needed; SAT modules are bounded)
  const { data: ars } = await db
    .from("answer_records")
    .select("question_id, is_correct")
    .in("submission_id", subIds);

  if (!ars || ars.length === 0) return NextResponse.json({ domains: [], skills: [] });

  const qIds = Array.from(new Set(ars.map((a) => a.question_id)));

  const { data: qmeta } = await db
    .from("questions")
    .select("id, domain, skill")
    .in("id", qIds);

  const metaMap = new Map((qmeta ?? []).map((q) => [q.id, q]));

  // Compute the available domain list
  const allDomains = Array.from(
    new Set((qmeta ?? []).map((q) => q.domain).filter(Boolean) as string[])
  ).sort();

  // Per-skill aggregation, optionally filtered by domain
  const perSkill = new Map<
    string,
    { total: number; wrong: number; domain: string | null }
  >();
  for (const ar of ars) {
    const m = metaMap.get(ar.question_id);
    if (!m?.skill) continue;
    if (domain && m.domain !== domain) continue;
    let e = perSkill.get(m.skill);
    if (!e) {
      e = { total: 0, wrong: 0, domain: m.domain ?? null };
      perSkill.set(m.skill, e);
    }
    e.total++;
    if (!ar.is_correct) e.wrong++;
  }

  const skills = Array.from(perSkill.entries())
    .map(([skill, v]) => ({
      skill,
      domain: v.domain,
      total: v.total,
      wrong: v.wrong,
      errorRate: v.total > 0 ? (v.wrong / v.total) * 100 : 0,
    }))
    .sort((a, b) => b.errorRate - a.errorRate)
    .slice(0, 5);

  return NextResponse.json({ domains: allDomains, skills });
}
