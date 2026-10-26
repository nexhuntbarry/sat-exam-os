import { redirect } from "next/navigation";
import { Clock, Ban } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import StudentSidebar from "@/components/nav/StudentSidebar";
import Topbar from "@/components/nav/Topbar";

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/sign-in");
  }

  if (user.role !== "student") {
    redirect("/dashboard");
  }

  // Pending and suspended students keep a valid session, so every
  // student page (not just the dashboard) shows the account screen
  // instead of its content. The /api/student/* routes enforce the same
  // rule server-side (lib/rbac.ts).
  if (user.accountStatus !== "approved") {
    const isPending = user.accountStatus === "pending";
    return (
      <div className="flex flex-col h-screen bg-cream text-charcoal">
        <Topbar title="Student" />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6">
            <div
              className={
                isPending
                  ? "p-6 rounded-full bg-status-warning/10 border border-status-warning/20"
                  : "p-6 rounded-full bg-status-error/10 border border-status-error/20"
              }
            >
              {isPending ? (
                <Clock size={40} className="text-status-warning" />
              ) : (
                <Ban size={40} className="text-status-error" />
              )}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-charcoal mb-3">
                {isPending ? "Account Pending Approval" : "Account Suspended"}
              </h1>
              <p className="text-mid-gray leading-relaxed">
                {isPending
                  ? "Your registration has been submitted successfully. An administrator will review and approve your account shortly. You will receive an email notification once your account is approved."
                  : "Your account is currently suspended, so tests and results are unavailable. Please contact your teacher or an administrator."}
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
                <span
                  className={
                    isPending
                      ? "text-status-warning font-medium"
                      : "text-status-error font-medium"
                  }
                >
                  {isPending ? "Pending Approval" : "Suspended"}
                </span>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-cream text-charcoal">
      <Topbar title="Student" />
      <div className="flex flex-1 min-h-0">
        <StudentSidebar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
