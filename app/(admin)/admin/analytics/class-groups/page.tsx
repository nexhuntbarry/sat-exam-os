import Link from "next/link";
import { getServiceClient } from "@/lib/supabase";
import { scaleSectionScore } from "@/lib/scoring";
import { BarChart3, Users, ChevronLeft, ClipboardList } from "lucide-react";

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
  percentage: number | string | null;
  scaled_score: number | null;
  session_id: string | null;
  adaptive_track: string | null;
};

// One logical attempt (a two-module adaptive session collapses to one).
type Attempt = {
  studentId: string;
  testId: string;
  percentage: number | null;
  scaledScore: number | null;
};

// Per-test aggregate within a single class group.
type TestStat = {
  testId: string;
  testName: string;
  createdAt: string | null;
  studentsSubmitted: number;
  avgPercentage: number | null;
  avgScaledScore: number | null;
};

type GroupStat = {
  id: string;
  name: string;
  campus: string | null;
  grade: string | null;
  memberCount: number;
  tests: TestStat[];
  overallAvgPercentage: number | null;
};

// ── Attempt building (mirrors teacher buildSubmissionAttempts, simplified) ───
// Two-module adaptive attempts produce two submission rows sharing one
// session_id; collapse each session into a single attempt by averaging the
// per-module percentages/scaled scores so a student isn't double-counted.
// Rows with a NULL session_id are standalone attempts.
function buildAttempts(rows: SubmissionRow[]): Attempt[] {
  const bySession = new Map<string, SubmissionRow[]>();
  const attempts: Attempt[] = [];

  const toPct = (v: number | string | null): number | null =>
    v != null && v !== "" ? Number(v) : null;

  const scaledForAttempt = (
    rowScaledScores: (number | null)[],
    avgPct: number | null,
  ): number | null => {
    const stored = rowScaledScores.filter(
      (s): s is number => s != null,
    );
    if (stored.length > 0) {
      return Math.round(stored.reduce((a, b) => a + b, 0) / stored.length);
    }
    return avgPct != null ? scaleSectionScore(avgPct) : null;
  };

  for (const r of rows) {
    if (r.session_id) {
      const list = bySession.get(r.session_id) ?? [];
      list.push(r);
      bySession.set(r.session_id, list);
    } else {
      const pct = toPct(r.percentage);
      attempts.push({
        studentId: r.student_id,
        testId: r.test_id,
        percentage: pct,
        scaledScore: scaledForAttempt([r.scaled_score], pct),
      });
    }
  }

  for (const list of bySession.values()) {
    const pcts = list
      .map((r) => toPct(r.percentage))
      .filter((p): p is number => p != null);
    const avgPct =
      pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
    attempts.push({
      studentId: list[0].student_id,
      testId: list[0].test_id,
      percentage: avgPct,
      scaledScore: scaledForAttempt(
        list.map((r) => r.scaled_score),
        avgPct,
      ),
    });
  }

  return attempts;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function getClassGroupAnalytics(): Promise<GroupStat[]> {
  const db = getServiceClient();

  const [groupsRes, membersRes, testsRes, submissionsRes] = await Promise.all([
    db
      .from("class_groups")
      .select("id, name, campus, grade, created_at")
      .order("created_at", { ascending: false }),
    db.from("class_group_members").select("class_group_id, student_id"),
    db.from("tests").select("id, test_name, created_at"),
    db
      .from("submissions")
      .select(
        "id, student_id, test_id, status, percentage, scaled_score, session_id, adaptive_track",
      )
      .in("status", ["Submitted", "Late"]),
  ]);

  const groups = (groupsRes.data ?? []) as ClassGroupRow[];
  const members = (membersRes.data ?? []) as MemberRow[];
  const tests = (testsRes.data ?? []) as TestRow[];
  const attempts = buildAttempts(
    (submissionsRes.data ?? []) as SubmissionRow[],
  );

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
      const avgScaledScore = mean(
        list
          .map((a) => a.scaledScore)
          .filter((s): s is number => s != null),
      );
      testStats.push({
        testId,
        testName: t.test_name,
        createdAt: t.created_at,
        studentsSubmitted: students.size,
        avgPercentage,
        avgScaledScore: avgScaledScore != null ? Math.round(avgScaledScore) : null,
      });
    }

    testStats.sort((a, b) => {
      if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      if (a.createdAt) return -1;
      if (b.createdAt) return 1;
      return a.testName.localeCompare(b.testName);
    });

    const overallAvgPercentage = mean(
      testStats
        .map((t) => t.avgPercentage)
        .filter((p): p is number => p != null),
    );

    return {
      id: g.id,
      name: g.name,
      campus: g.campus,
      grade: g.grade,
      memberCount,
      tests: testStats,
      overallAvgPercentage,
    };
  });
}

export default async function ClassGroupAnalyticsPage() {
  const groups = await getClassGroupAnalytics();

  return (
    <div className="max-w-5xl mx-auto space-y-6">
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
            Average score per test for each class group.
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
                  <div className="text-soft-mute text-xs">Overall Avg</div>
                  <div className="text-xl font-bold text-warm-amber tabular-nums">
                    {g.overallAvgPercentage != null
                      ? `${g.overallAvgPercentage.toFixed(1)}%`
                      : "—"}
                  </div>
                </div>
              </div>

              {g.tests.length === 0 ? (
                <div className="py-10 text-center text-soft-mute text-sm flex flex-col items-center gap-2">
                  <ClipboardList size={18} className="text-mid-gray" />
                  No tests taken by this group yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-divider text-soft-mute">
                        <th className="text-left px-5 py-3 font-medium">Test</th>
                        <th className="text-right px-5 py-3 font-medium">Submitted</th>
                        <th className="text-right px-5 py-3 font-medium">Avg %</th>
                        <th className="text-right px-5 py-3 font-medium">Avg Scaled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.tests.map((t) => (
                        <tr
                          key={t.testId}
                          className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                        >
                          <td className="px-5 py-3 text-charcoal font-medium">
                            {t.testName}
                          </td>
                          <td className="px-5 py-3 text-right text-mid-gray tabular-nums">
                            {t.studentsSubmitted} / {g.memberCount}
                          </td>
                          <td className="px-5 py-3 text-right text-charcoal tabular-nums">
                            {t.avgPercentage != null
                              ? `${t.avgPercentage.toFixed(1)}%`
                              : "—"}
                          </td>
                          <td className="px-5 py-3 text-right text-warm-coral font-medium tabular-nums">
                            {t.avgScaledScore != null ? `${t.avgScaledScore}/800` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
