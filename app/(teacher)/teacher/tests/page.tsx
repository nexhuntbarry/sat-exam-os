import { getServiceClient } from "@/lib/supabase";
import { asParentRows, closedFullLengthAttemptKeys, expandWithChildren, fullLengthLinks, hideChildTests } from "@/lib/full-length";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { getQaTestIds, getQaUserIds, scopeIds } from "@/lib/qa";
import { getAssignedStudentIds, getTeacherTestScope, seesAllStudents } from "@/lib/teacher-access";
import { manageDecision, type ManageUser } from "@/lib/test-manage";
import TeacherTestsTable, { type TeacherTestRow } from "./TeacherTestsTable";

async function getTeacherTests(user: ManageUser & { role: string | null }): Promise<TeacherTestRow[]> {
  const db = getServiceClient();

  // Admins see every test; teachers see tests they're directly assigned
  // to plus tests assigned to / taken by their classes (subject-scoped).
  const scope = await getTeacherTestScope(db, user);
  if (scope.testIds.size === 0) return [];
  const testIds = Array.from(scope.testIds);
  const flLinks = await fullLengthLinks(db);

  const [{ data: tests, error: testsError }, { data: assignments, error: assignError }, { data: subData, error: subError }] = await Promise.all([
    hideChildTests(
      db.from("tests")
        .select(`
        id, test_name, status, due_date, time_limit_minutes, created_by, parent_test_id, test_kind,
        modules!module_id(module_name, section, module_number)
      `)
        .in("id", testIds),
      new Set(flLinks.parentOf.keys()),
    ).order("due_date", { ascending: true }),
    db.from("test_assignments")
      .select("test_id, student_ids, class_group_ids, teacher_ids")
      .in("test_id", testIds),
    scopeIds(db.from("submissions")
      .select(
        "test_id, student_id, status, correct_count, total_questions, percentage, session_id, attempt_number, adaptive_track",
      )
      .in("test_id", expandWithChildren(testIds, flLinks)), "student_id", await getQaUserIds(), user.isQa),
  ]);
  if (testsError) throw new Error(`tests lookup failed: ${testsError.message}`);
  if (assignError) throw new Error(`test_assignments lookup failed: ${assignError.message}`);
  if (subError) throw new Error(`submissions lookup failed: ${subError.message}`);

  // Roster per test = student_ids ∪ class_group members, limited to the
  // teacher's own students unless they see the whole test.
  const rosterSize: Record<string, number> = {};
  await Promise.all((assignments ?? []).map(async (a) => {
    const allowlist = seesAllStudents(scope, a.test_id as string) ? null : scope.myStudentIds;
    rosterSize[a.test_id as string] = (await getAssignedStudentIds(db, a, user.isQa, allowlist)).size;
  }));

  type SubRow = {
    test_id: string;
    student_id: string;
    status: string;
    correct_count: number | null;
    total_questions: number | null;
    percentage: number | string | null;
    session_id: string | null;
    attempt_number: number | null;
    adaptive_track: string | null;
  };
  // Two-module attempts produce two submission rows sharing one
  // session_id; avg over raw submission rows would double-count each
  // attempt. Group session siblings, compute combined % per attempt,
  // then average those.
  const subsByTest = new Map<string, SubRow[]>();
  // A full-length SAT's rows are on its children: one attempt under the parent.
  for (const s of asParentRows((subData ?? []) as SubRow[], flLinks, await closedFullLengthAttemptKeys(db, flLinks))) {
    if (!seesAllStudents(scope, s.test_id) && !scope.myStudentIds.has(s.student_id)) continue;
    const list = subsByTest.get(s.test_id) ?? [];
    list.push(s);
    subsByTest.set(s.test_id, list);
  }

  const aggregates: Record<string, { done: number; pcts: number[] }> = {};
  for (const [testId, rows] of subsByTest) {
    const completed = rows.filter(
      (r) => r.status === "Submitted" || r.status === "Late",
    );
    // Group by session_id (multi-module) + per-student fallback for
    // legacy single-module rows (session_id NULL).
    const sessions = new Map<string, SubRow[]>();
    for (const r of completed) {
      const key = r.session_id ?? `solo:${r.student_id}:${r.test_id}`;
      const list = sessions.get(key) ?? [];
      list.push(r);
      sessions.set(key, list);
    }
    const pcts: number[] = [];
    for (const group of sessions.values()) {
      const correct = group.reduce((s, r) => s + (r.correct_count ?? 0), 0);
      const total = group.reduce((s, r) => s + (r.total_questions ?? 0), 0);
      if (total > 0) {
        pcts.push((correct / total) * 100);
      } else if (group[0]?.percentage != null) {
        pcts.push(Number(group[0].percentage));
      }
    }
    aggregates[testId] = { done: sessions.size, pcts };
  }

  // Status menu only on tests the teacher manages (same rule as the
  // /api/teacher/tests/[id]/{publish,…} routes, lib/test-manage).
  const qaTestIds = await getQaTestIds();
  const teacherIdsByTest = new Map<string, unknown[]>();
  for (const a of assignments ?? []) {
    const ids = Array.isArray(a.teacher_ids) ? (a.teacher_ids as unknown[]) : [];
    teacherIdsByTest.set(a.test_id as string, [...(teacherIdsByTest.get(a.test_id as string) ?? []), ...ids]);
  }

  return (tests ?? []).map((t) => {
    const agg = aggregates[t.id] ?? { done: 0, pcts: [] };
    const avgScore = agg.pcts.length > 0
      ? agg.pcts.reduce((a, b) => a + b, 0) / agg.pcts.length
      : null;
    const mod = t.modules as unknown as { section: string; module_number: number | null } | null;
    return {
      id: t.id as string,
      test_name: t.test_name as string,
      status: t.status as string,
      due_date: (t.due_date as string | null) ?? null,
      module: mod ? { section: mod.section, module_number: mod.module_number } : null,
      isFullLength: flLinks.childrenOf.has(t.id),
      totalStudents: rosterSize[t.id] ?? 0,
      submittedCount: agg.done,
      avgScore,
      manages: manageDecision({
        user,
        test: {
          id: t.id as string,
          created_by: (t.created_by as string | null) ?? null,
          parent_test_id: (t.parent_test_id as string | null) ?? null,
          test_kind: (t.test_kind as string | null) ?? null,
        },
        teacherIds: teacherIdsByTest.get(t.id as string) ?? [],
        qaTestIds,
      }).ok,
    };
  });
}

export default async function TeacherTestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const [tests, tf] = await Promise.all([getTeacherTests(user), getTranslations("fullLength")]);

  return (
    <div className="space-y-6">
      <PageIntro tKey="teacher.tests" />
      <h1 className="text-2xl font-bold text-charcoal">My Tests</h1>

      {tests.length === 0 ? (
        <div className="py-16 px-6 text-center space-y-3 max-w-md mx-auto">
          <ClipboardList size={40} className="text-charcoal/20 mx-auto" />
          <p className="text-soft-mute text-sm">No tests assigned to you yet.</p>
          <p className="text-mid-gray text-xs">
            Build a Draft test in{" "}
            <Link href="/teacher/teaching-mode" className="text-warm-coral-text hover:underline">
              Teaching Mode
            </Link>
            {" "}or ask your admin to assign one. The{" "}
            <Link href="/teacher/help" className="text-warm-coral-text hover:underline">
              Quick Start
            </Link>
            {" "}walks through the full flow.
          </p>
        </div>
      ) : (
        <TeacherTestsTable tests={tests} flTag={tf("tag")} />
      )}
    </div>
  );
}
