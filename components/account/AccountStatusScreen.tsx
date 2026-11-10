import { Clock, Ban } from "lucide-react";
import Topbar from "@/components/nav/Topbar";
import SwitchRoleButton from "./SwitchRoleButton";

const COPY = {
  student: {
    title: "Student",
    pending:
      "Your registration has been submitted successfully. An administrator will review and approve your account shortly. You will receive an email notification once your account is approved.",
    suspended:
      "Your account is currently suspended, so tests and results are unavailable. Please contact your teacher or an administrator.",
  },
  teacher: {
    title: "Teacher",
    pending:
      "Your teacher sign-up has been received. An administrator will review and approve your account shortly. You will receive an email notification once your account is approved.",
    suspended:
      "Your teacher account is currently suspended, so classes and results are unavailable. Please contact an administrator.",
  },
} as const;

/**
 * Full-page Pending / Suspended screen for a student or teacher whose
 * account_status isn't "approved". Rendered by the (student) and
 * (teacher) layouts instead of their content; the matching /api routes
 * enforce the same rule (lib/rbac.ts). A PENDING account can switch
 * between student and teacher itself (POST /api/account/role).
 */
export default function AccountStatusScreen({
  role,
  displayName,
  email,
  accountStatus,
}: {
  role: "student" | "teacher";
  displayName: string;
  email: string;
  accountStatus: string;
}) {
  const isPending = accountStatus === "pending";
  const copy = COPY[role];
  return (
    <div className="flex flex-col h-screen bg-cream text-charcoal">
      <Topbar title={copy.title} />
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
              {isPending ? copy.pending : copy.suspended}
            </p>
          </div>
          <div className="bg-surface border border-divider rounded-2xl p-5 w-full text-left space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-soft-mute">Name</span>
              <span className="text-charcoal">{displayName}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-soft-mute">Email</span>
              <span className="text-charcoal">{email}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-soft-mute">Role</span>
              <span className="text-charcoal">{copy.title}</span>
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
          {isPending && <SwitchRoleButton to={role === "student" ? "teacher" : "student"} />}
        </div>
      </main>
    </div>
  );
}
