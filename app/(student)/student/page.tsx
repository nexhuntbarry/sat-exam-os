import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { Clock, ClipboardList, User } from "lucide-react";
import Link from "next/link";
import { clsx } from "clsx";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";

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

  const { data: membership } = await db
    .from("class_group_members")
    .select("class_group_id")
    .eq("student_id", userId);
  const classGroupIds = (membership ?? []).map((m) => m.class_group_id);

  const { data: allAssignments } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids");

  const matchedTestIds = new Set<string>();
  for (const a of allAssignments ?? []) {
    const sIds: string[] = a.student_ids ?? [];
    const cgIds: string[] = a.class_group_ids ?? [];
    if (sIds.includes(userId) || classGroupIds.some((cg: string) => cgIds.includes(cg))) {
      matchedTestIds.add(a.test_id);
    }
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
    .select("test_id, status")
    .eq("student_id", userId)
    .in("test_id", testIds);

  const subMap: Record<string, string> = {};
  for (const s of submissions ?? []) {
    if (!subMap[s.test_id]) subMap[s.test_id] = s.status;
  }

  return (tests ?? []).map((t) => ({
    ...t,
    testStatus: subMap[t.id] ?? "Not Started",
  }));
}

export default async function StudentDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const isPending = user.accountStatus === "pending";
  const [profile, upcomingTests] = isPending
    ? [null, []]
    : await Promise.all([getStudentProfile(user.userId), getUpcomingTests(user.userId)]);

  if (isPending) {
    return (
      <div className="max-w-2xl mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6">
        <div className="p-6 rounded-full bg-status-warning/10 border border-status-warning/20">
          <Clock size={40} className="text-status-warning" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-3">Account Pending Approval</h1>
          <p className="text-mid-gray leading-relaxed">
            Your registration has been submitted successfully. An administrator will review
            and approve your account shortly. You will receive an email notification once
            your account is approved.
          </p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl p-5 w-full text-left space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-soft-mute">Name</span>
            <span className="text-charcoal">{user.displayName}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-soft-mute">Email</span>
            <span className="text-charcoal">{user.email}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-soft-mute">Status</span>
            <span className="text-status-warning font-medium">Pending Approval</span>
          </div>
        </div>
      </div>
    );
  }

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
          <span className="text-xl font-bold text-warm-coral">
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
            <ClipboardList size={16} className="text-warm-coral" />
            Upcoming Tests
          </h2>
          <Link href="/student/tests" className="text-xs text-warm-coral hover:underline">
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
                    <p className="text-charcoal text-sm font-medium truncate">{t.test_name}</p>
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
                          ? "bg-warm-coral/15 text-warm-coral hover:bg-warm-coral/25"
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
