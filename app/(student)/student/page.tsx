import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { Clock, ClipboardList, User } from "lucide-react";

async function getStudentProfile(userId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("student_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();
  return data;
}

export default async function StudentDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const isPending = user.accountStatus === "pending";
  const profile = isPending ? null : await getStudentProfile(user.userId);

  if (isPending) {
    return (
      <div className="max-w-2xl mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6">
        <div className="p-6 rounded-full bg-amber/10 border border-amber/20">
          <Clock size={40} className="text-amber" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white mb-3">Account Pending Approval</h1>
          <p className="text-soft-gray/60 leading-relaxed">
            Your registration has been submitted successfully. An administrator will review
            and approve your account shortly. You will receive an email notification once
            your account is approved.
          </p>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-2xl p-5 w-full text-left space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-soft-gray/50">Name</span>
            <span className="text-soft-gray">{user.displayName}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-soft-gray/50">Email</span>
            <span className="text-soft-gray">{user.email}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-soft-gray/50">Status</span>
            <span className="text-amber font-medium">Pending Approval</span>
          </div>
        </div>
      </div>
    );
  }

  const hasCompleteProfile = profile?.grade && profile?.school;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">
          Welcome, {user.displayName}!
        </h1>
        <p className="text-soft-gray/50 text-sm mt-1">Your SAT Exam OS dashboard.</p>
      </div>

      {!hasCompleteProfile && (
        <div className="bg-amber/10 border border-amber/20 rounded-2xl p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <User size={18} className="text-amber shrink-0" />
            <p className="text-soft-gray/80 text-sm">
              Your profile is incomplete. Add your grade, school, and other info to help your teacher.
            </p>
          </div>
          <a
            href="/student/profile"
            className="shrink-0 px-4 py-2 rounded-lg bg-amber/20 hover:bg-amber/30 text-amber text-sm font-medium transition-colors"
          >
            Complete Profile
          </a>
        </div>
      )}

      {/* Profile card */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-6 flex items-start gap-5">
        <div className="w-14 h-14 rounded-full bg-electric-blue/20 border border-electric-blue/30 flex items-center justify-center shrink-0">
          <span className="text-xl font-bold text-electric-blue">
            {user.displayName?.charAt(0)?.toUpperCase() ?? "S"}
          </span>
        </div>
        <div className="flex-1 space-y-1">
          <p className="font-semibold text-white">{user.displayName}</p>
          <p className="text-soft-gray/50 text-sm">{user.email}</p>
          {profile?.grade && (
            <p className="text-soft-gray/50 text-sm">
              Grade {profile.grade}{profile.school ? ` · ${profile.school}` : ""}
            </p>
          )}
          {profile?.target_score && (
            <p className="text-soft-gray/50 text-sm">
              Target Score: <span className="text-lime-green font-medium">{profile.target_score}</span>
            </p>
          )}
        </div>
      </div>

      {/* Upcoming tests placeholder */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-8 text-center">
        <ClipboardList size={40} className="text-soft-gray/20 mx-auto mb-4" />
        <p className="text-soft-gray/50 text-sm">
          Your upcoming tests will appear here once your teacher assigns them.
        </p>
      </div>
    </div>
  );
}
