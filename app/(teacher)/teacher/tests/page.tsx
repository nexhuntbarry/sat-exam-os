import { getServiceClient } from "@/lib/supabase";
import { asParentRows, expandWithChildren, fullLengthLinks, hideChildTests } from "@/lib/full-length";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { formatShortDate } from "@/lib/datetime";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import { getAssignedStudentIds, getTeacherTestScope, seesAllStudents } from "@/lib/teacher-access";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  TwoLineCell,
} from "@/components/ui/data-table";
import { StatusBadge, SubjectTag, type TestStatus } from "@/components/ui/StatusBadge";

async function getTeacherTests(user: { userId: string; role: string | null; isQa: boolean }) {
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
        id, test_name, status, due_date, time_limit_minutes,
        modules!module_id(module_name, section, module_number)
      `)
        .in("id", testIds),
      new Set(flLinks.parentOf.keys()),
    ).order("due_date", { ascending: true }),
    db.from("test_assignments")
      .select("test_id, student_ids, class_group_ids")
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
  for (const s of asParentRows((subData ?? []) as SubRow[], flLinks)) {
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

  return (tests ?? []).map((t) => {
    const agg = aggregates[t.id] ?? { done: 0, pcts: [] };
    const avgScore = agg.pcts.length > 0
      ? agg.pcts.reduce((a, b) => a + b, 0) / agg.pcts.length
      : null;
    return {
      ...t,
      totalStudents: rosterSize[t.id] ?? 0,
      submittedCount: agg.done,
      avgScore,
    };
  });
}

export default async function TeacherTestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const tests = await getTeacherTests(user);

  // Closed tests sink into a collapsed section at the bottom so the
  // list shows what's live by default.
  const activeTests = tests.filter((t) => t.status !== "Closed");
  const closedTests = tests.filter((t) => t.status === "Closed");
  const COL_SPAN = 8;

  const renderTable = (rows: typeof tests) => (
    <DataTable>
      <thead>
        <HeadRow>
          <Th kind="main" sticky="left">Test Name</Th>
          <Th priority="md">Section</Th>
          <Th>Status</Th>
          <Th priority="md">Students</Th>
          <Th>Submitted</Th>
          <Th priority="md">Avg Score</Th>
          <Th priority="lg">Due</Th>
          <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
        </HeadRow>
      </thead>
      <tbody>
        {rows.map((test) => {
          const mod = test.modules as unknown as
            | { module_name: string; section: string; module_number: number | null }
            | null;
          const section = mod ? (
            <span className="inline-flex items-center gap-1.5">
              <SubjectTag section={mod.section} />
              {mod.module_number ? <span>M{mod.module_number}</span> : null}
            </span>
          ) : (
            "Adaptive"
          );
          const dueLabel = test.due_date ? formatShortDate(test.due_date) : "—";

          return (
            <DataRow
              key={test.id}
              href={`/teacher/tests/${test.id}`}
              expandBelow="lg"
              colSpan={COL_SPAN}
              details={
                <>
                  <DetailItem label="Section" priority="md">{section}</DetailItem>
                  <DetailItem label="Students" priority="md">{String(test.totalStudents)}</DetailItem>
                  <DetailItem label="Avg Score" priority="md">{test.avgScore != null ? `${test.avgScore.toFixed(1)}%` : "—"}</DetailItem>
                  <DetailItem label="Due" priority="lg">{dueLabel}</DetailItem>
                </>
              }
            >
              <Td kind="main" sticky="left">
                <Link
                  href={`/teacher/tests/${test.id}`}
                  className="block text-charcoal hover:text-warm-coral-text transition-colors"
                >
                  <TwoLineCell main={test.test_name} wrapMain mainClassName="font-medium text-inherit" />
                </Link>
              </Td>
              <Td priority="md" className="text-mid-gray">
                {section}
              </Td>
              <Td>
                <StatusBadge kind="test" status={test.status as TestStatus} />
              </Td>
              <Td priority="md" className="text-mid-gray">{test.totalStudents}</Td>
              <Td className="text-mid-gray">{test.submittedCount}</Td>
              <Td priority="md" className="text-mid-gray">
                {test.avgScore != null ? `${test.avgScore.toFixed(1)}%` : "—"}
              </Td>
              <Td priority="lg" className="text-soft-mute">
                {dueLabel}
              </Td>
              <Td kind="actions" sticky="right">
                <ExpandToggle label={`More about ${test.test_name}`} />
              </Td>
            </DataRow>
          );
        })}
      </tbody>
    </DataTable>
  );

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
        <>
          {activeTests.length > 0 && renderTable(activeTests)}
          {closedTests.length > 0 && (
            <details className="border-t border-divider">
              <summary className="px-3 py-3 text-sm text-soft-mute cursor-pointer hover:text-charcoal select-none">
                Closed tests ({closedTests.length})
              </summary>
              {renderTable(closedTests)}
            </details>
          )}
        </>
      )}
    </div>
  );
}
