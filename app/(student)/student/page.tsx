import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getQaTestIds, getQaUserIds, onSide } from "@/lib/qa";
import { ClipboardList, User } from "lucide-react";
import Link from "next/link";
import { clsx } from "clsx";
import { sectionTitleClass } from "@/lib/section-color";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { getAssignedTestIds, isModule2Track } from "@/lib/student-exam";

async function getStudentProfile(userId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("student_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();
  return data;
}

async function getUpcomingTests(userId: string) {
  const db = getServiceClient();

  const matchedTestIds = await getAssignedTestIds(db, userId);

  // QA isolation: a student never sees a test from the other side.
  const [qaTests, qaUsers] = await Promise.all([getQaTestIds(), getQaUserIds()]);
  for (const id of Array.from(matchedTestIds)) {
    if (!onSide(id, qaTests, qaUsers.has(userId))) matchedTestIds.delete(id);
  }

  if (matchedTestIds.size === 0) return [];

  const testIds = Array.from(matchedTestIds);
  const { data: tests } = await db
    .from("tests")
    .select("id, test_name, due_date, status, modules!module_id(section)")
    .in("id", testIds)
    .eq("status", "Published")
    .order("due_date", { ascending: true })
    .limit(5);

  const { data: submissions } = await db
    .from("submissions")
    .select("test_id, status, attempt_number, adaptive_track")
    .eq("student_id", userId)
    .in("test_id", testIds)
    .order("attempt_number", { ascending: false });

  // Status of each test's latest attempt. Any In Progress module wins (a
  // submitted Module 1 must not hide an open Module 2), and a graded
  // Module 1 with no Module 2 row yet (failed handoff) is still in
  // progress — the test page offers "Continue to Module 2".
  const subMap: Record<string, string> = {};
  const byTest = new Map<string, NonNullable<typeof submissions>>();
  for (const s of submissions ?? []) {
    const list = byTest.get(s.test_id) ?? [];
    list.push(s);
    byTest.set(s.test_id, list);
  }
  for (const [testId, rows] of byTest) {
    const latest = rows.filter((r) => r.attempt_number === rows[0].attempt_number);
    const m1Done = latest.some(
      (r) => r.adaptive_track === "module_1" && (r.status === "Submitted" || r.status === "Late"),
    );
    const hasM2 = latest.some((r) => isModule2Track(r.adaptive_track));
    subMap[testId] =
      latest.some((r) => r.status === "In Progress") || (m1Done && !hasM2)
        ? "In Progress"
        : latest[0].status;
  }

  return (tests ?? []).map((t) => ({
    ...t,
    testStatus: subMap[t.id] ?? "Not Started",
  }));
}

export default async function StudentDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  // Pending / suspended accounts never reach here — app/(student)/layout.tsx
  // renders the account-status screen instead.
  const [profile, upcomingTests] = await Promise.all([
    getStudentProfile(user.userId),
    getUpcomingTests(user.userId),
  ]);

  const hasCompleteProfile = profile?.grade && profile?.school;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <PageIntro tKey="student.dashboard" />
      <div>
        <h1 className="text-2xl font-bold text-charcoal">
          Welcome, {user.displayName}!
        </h1>
        <p className="text-soft-mute text-sm mt-1">Your SAT Exam OS dashboard.</p>
      </div>

      {!hasCompleteProfile && (
        <div className="bg-status-warning/10 border border-status-warning/20 rounded-2xl p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <User size={18} className="text-status-warning shrink-0" />
            <p className="text-charcoal text-sm">
              Your profile is incomplete. Add your grade, school, and other info to help your teacher.
            </p>
          </div>
          <a
            href="/student/profile"
            className="shrink-0 px-4 py-2 rounded-lg bg-status-warning/15 hover:bg-status-warning/30 text-status-warning text-sm font-medium transition-colors"
          >
            Complete Profile
          </a>
        </div>
      )}

      {/* Profile card */}
      <div className="bg-surface border border-divider rounded-2xl p-6 flex items-start gap-5">
        <div className="w-14 h-14 rounded-full bg-warm-coral/20 border border-warm-coral/30 flex items-center justify-center shrink-0">
          <span className="text-xl font-bold text-warm-coral-text">
            {user.displayName?.charAt(0)?.toUpperCase() ?? "S"}
          </span>
        </div>
        <div className="flex-1 space-y-1">
          <p className="font-semibold text-charcoal">{user.displayName}</p>
          <p className="text-soft-mute text-sm">{user.email}</p>
          {profile?.grade && (
            <p className="text-soft-mute text-sm">
              Grade {profile.grade}{profile.school ? ` · ${profile.school}` : ""}
            </p>
          )}
          {profile?.target_score && (
            <p className="text-soft-mute text-sm">
              Target Score: <span className="text-warm-amber font-medium">{profile.target_score}</span>
            </p>
          )}
        </div>
      </div>

      {/* Upcoming tests */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-divider flex items-center justify-between">
          <h2 className="font-semibold text-charcoal flex items-center gap-2">
            <ClipboardList size={16} className="text-warm-coral-text" />
            Upcoming Tests
          </h2>
          <Link href="/student/tests" className="text-xs text-warm-coral-text hover:underline">
            View all
          </Link>
        </div>
        {upcomingTests.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <ClipboardList size={32} className="text-charcoal/20 mx-auto" />
            <p className="text-soft-mute text-sm">
              No upcoming tests yet. Your teacher will assign tests here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {upcomingTests.map((t) => {
              const mod = t.modules as unknown as { section: string } | null;
              const isInProgress = t.testStatus === "In Progress";
              const isSubmitted = t.testStatus === "Submitted" || t.testStatus === "Late";
              return (
                <div key={t.id} className="px-5 py-3 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className={clsx("text-sm font-medium truncate", sectionTitleClass(mod?.section))}>{t.test_name}</p>
                    <p className="text-soft-mute text-xs">
                      {mod?.section ?? "Adaptive"}
                      {t.due_date ? ` · Due ${formatDate(t.due_date)}` : ""}
                    </p>
                  </div>
                  {isSubmitted ? (
                    <Link
                      href={`/student/tests/${t.id}/result`}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-warm-amber/15 text-warm-amber text-xs font-medium hover:bg-warm-amber/25 transition-colors"
                    >
                      View Result
                    </Link>
                  ) : (
                    <Link
                      href={`/student/tests/${t.id}`}
                      className={clsx(
                        "shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                        isInProgress
                          ? "bg-warm-coral/15 text-warm-coral-text hover:bg-warm-coral/25"
                          : "bg-surface text-mid-gray hover:text-charcoal hover:bg-light-bg"
                      )}
                    >
                      {isInProgress ? "Resume" : "Start"}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
