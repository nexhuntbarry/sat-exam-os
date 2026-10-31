import Link from "next/link";
import { getServiceClient } from "@/lib/supabase";
import { attemptScore, averageSat } from "@/lib/score-display";
import { getTestSections } from "@/lib/teacher-access";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaUserIds, scopeIds } from "@/lib/qa";
import { BarChart3, Users, ChevronLeft, ClipboardList } from "lucide-react";
import {
  DataRow,
  DataTable,
  EmptyRow,
  HeadRow,
  Td,
  Th,
  TruncatedText,
} from "@/components/ui/data-table";

// ── Data types ──────────────────────────────────────────────────────────────

type ClassGroupRow = {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
  created_at: string | null;
};

type MemberRow = {
  class_group_id: string;
  student_id: string;
};

type TestRow = {
  id: string;
  test_name: string;
  created_at: string | null;
};

type SubmissionRow = {
  id: string;
  student_id: string;
  test_id: string;
  status: string;
  correct_count: number | null;
  total_questions: number | null;
  session_id: string | null;
  adaptive_track: string | null;
};

// One finished attempt (a two-module session collapses to one).
type Attempt = {
  studentId: string;
  testId: string;
  sat: number | null;
  percentage: number | null;
};

// Per-test aggregate within a single class group.
type TestStat = {
  testId: string;
  testName: string;
  createdAt: string | null;
  studentsSubmitted: number;
  avgSat: number | null;
  /** % correct, secondary to avgSat. */
  avgPercentage: number | null;
};

type GroupStat = {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
  memberCount: number;
  tests: TestStat[];
  overallAvgSat: number | null;
  overallAvgPercentage: number | null;
};

// ── Attempt building ─────────────────────────────────────────────────────────
// Two-module attempts produce two submission rows sharing one session_id;
// each session is one attempt, scored with the shared score display (SAT
// from the combined counts, only once every module is in). Rows with a NULL
// session_id are standalone attempts. Unfinished attempts are left out so
// averages use finished attempts only.
function buildAttempts(rows: SubmissionRow[], sectionOf: Map<string, string | null>): Attempt[] {
  const bySession = new Map<string, SubmissionRow[]>();
  for (const r of rows) {
    const key = r.session_id ?? `solo:${r.id}`;
    bySession.set(key, [...(bySession.get(key) ?? []), r]);
  }

  const attempts: Attempt[] = [];
  for (const list of bySession.values()) {
    const { status, score } = attemptScore(list, sectionOf.get(list[0].test_id));
    if (status !== "Submitted" && status !== "Late") continue;
    attempts.push({
      studentId: list[0].student_id,
      testId: list[0].test_id,
      sat: score?.sat ?? null,
      percentage: score?.pct ?? null,
    });
  }
  return attempts;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function getClassGroupAnalytics(viewerIsQa: boolean): Promise<GroupStat[]> {
  const db = getServiceClient();
  const [qaGroups, qaUsers] = await Promise.all([getQaClassGroupIds(), getQaUserIds()]);

  const [groupsRes, membersRes, testsRes, submissionsRes] = await Promise.all([
    scopeIds(db
      .from("class_groups")
      .select("id, name, campus, grade, created_at"), "id", qaGroups, viewerIsQa)
      .order("created_at", { ascending: false }),
    db.from("class_group_members").select("class_group_id, student_id"),
    db.from("tests").select("id, test_name, created_at"),
    scopeIds(db
      .from("submissions")
      .select(
        "id, student_id, test_id, status, correct_count, total_questions, session_id, adaptive_track",
      )
      .in("status", ["Submitted", "Late"]), "student_id", qaUsers, viewerIsQa),
  ]);

  const groups = (groupsRes.data ?? []) as ClassGroupRow[];
  const members = (membersRes.data ?? []) as MemberRow[];
  const tests = (testsRes.data ?? []) as TestRow[];
  const subRows = (submissionsRes.data ?? []) as SubmissionRow[];
  const sectionOf = await getTestSections(db, Array.from(new Set(subRows.map((r) => r.test_id))));
  const attempts = buildAttempts(subRows, sectionOf);

  // student_id -> set of group ids they belong to (may be several)
  const studentGroups = new Map<string, string[]>();
  const groupMembers = new Map<string, Set<string>>();
  for (const m of members) {
    const gl = studentGroups.get(m.student_id) ?? [];
    gl.push(m.class_group_id);
    studentGroups.set(m.student_id, gl);

    const set = groupMembers.get(m.class_group_id) ?? new Set<string>();
    set.add(m.student_id);
    groupMembers.set(m.class_group_id, set);
  }

  const testById = new Map(tests.map((t) => [t.id, t]));

  // groupId -> testId -> attempts by group members for that test
  const groupTestAttempts = new Map<string, Map<string, Attempt[]>>();
  for (const a of attempts) {
    const gids = studentGroups.get(a.studentId);
    if (!gids || !testById.has(a.testId)) continue;
    for (const gid of gids) {
      const byTest = groupTestAttempts.get(gid) ?? new Map<string, Attempt[]>();
      const list = byTest.get(a.testId) ?? [];
      list.push(a);
      byTest.set(a.testId, list);
      groupTestAttempts.set(gid, byTest);
    }
  }

  return groups.map((g) => {
    const memberCount = groupMembers.get(g.id)?.size ?? 0;
    const byTest = groupTestAttempts.get(g.id) ?? new Map<string, Attempt[]>();

    const testStats: TestStat[] = [];
    for (const [testId, list] of byTest) {
      const t = testById.get(testId);
      if (!t) continue;
      const students = new Set(list.map((a) => a.studentId));
      const avgPercentage = mean(
        list
          .map((a) => a.percentage)
          .filter((p): p is number => p != null),
      );
      testStats.push({
        testId,
        testName: t.test_name,
        createdAt: t.created_at,
        studentsSubmitted: students.size,
        avgSat: averageSat(list.map((a) => a.sat)),
        avgPercentage,
      });
    }

    testStats.sort((a, b) => {
      if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      if (a.createdAt) return -1;
      if (b.createdAt) return 1;
      return a.testName.localeCompare(b.testName);
    });

    const groupAttempts = Array.from(byTest.values()).flat();
    const overallAvgSat = averageSat(groupAttempts.map((a) => a.sat));
    const overallAvgPercentage = mean(
      groupAttempts
        .map((a) => a.percentage)
        .filter((p): p is number => p != null),
    );

    return {
      id: g.id,
      name: g.name,
      campus: g.campus,
      grade: g.grade,
      memberCount,
      tests: testStats,
      overallAvgSat,
      overallAvgPercentage,
    };
  });
}

export default async function ClassGroupAnalyticsPage() {
  const groups = await getClassGroupAnalytics((await getCurrentUser())?.isQa ?? false);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-soft-mute text-sm hover:text-charcoal transition-colors"
        >
          <ChevronLeft size={15} />
          Back to dashboard
        </Link>
      </div>

      <div className="flex items-start gap-3">
        <div className="p-3 rounded-xl bg-warm-amber/10 border border-warm-amber/20">
          <BarChart3 size={20} className="text-warm-amber" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Class Group Analytics</h1>
          <p className="text-soft-mute text-sm mt-1">
            Average SAT score per test for each class group (finished attempts only).
          </p>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="bg-surface border border-divider rounded-2xl py-12 text-center text-soft-mute text-sm">
          No class groups yet.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div
              key={g.id}
              className="bg-surface border border-divider rounded-2xl overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-divider flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-charcoal font-semibold">{g.name}</h2>
                  <div className="flex items-center gap-2 text-soft-mute text-xs mt-1">
                    {[g.campus, g.grade].filter(Boolean).length > 0 && (
                      <span>{[g.campus, g.grade].filter(Boolean).join(" · ")}</span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <Users size={12} />
                      {g.memberCount} member{g.memberCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-soft-mute text-xs">Overall Avg SAT</div>
                  <div className="text-xl font-bold text-warm-amber tabular-nums">
                    {g.overallAvgSat ?? "—"}
                  </div>
                  {g.overallAvgPercentage != null && (
                    <div className="text-soft-mute text-xs tabular-nums">
                      {g.overallAvgPercentage.toFixed(1)}% correct
                    </div>
                  )}
                </div>
              </div>

              {g.tests.length === 0 ? (
                <div className="py-10 text-center text-soft-mute text-sm flex flex-col items-center gap-2">
                  <ClipboardList size={18} className="text-mid-gray" />
                  No tests taken by this group yet.
                </div>
              ) : (
                <DataTable>
                  <thead>
                    <HeadRow>
                      <Th kind="main">Test</Th>
                      <Th className="text-right">Submitted</Th>
                      <Th className="text-right">Avg SAT</Th>
                    </HeadRow>
                  </thead>
                  <tbody>
                    {g.tests.length === 0 && (
                      <EmptyRow colSpan={3}>No tests taken by this group yet.</EmptyRow>
                    )}
                    {g.tests.map((t) => (
                      <DataRow key={t.testId} colSpan={3}>
                        <Td kind="main">
                          <TruncatedText>{t.testName}</TruncatedText>
                        </Td>
                        <Td className="text-right text-mid-gray tabular-nums">
                          {t.studentsSubmitted} / {g.memberCount}
                        </Td>
                        <Td className="text-right tabular-nums">
                          <div className="font-bold text-charcoal">{t.avgSat ?? "—"}</div>
                          {t.avgPercentage != null && (
                            <div className="text-xs text-soft-mute">{t.avgPercentage.toFixed(1)}% correct</div>
                          )}
                        </Td>
                      </DataRow>
                    ))}
                  </tbody>
                </DataTable>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
