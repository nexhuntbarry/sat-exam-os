import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import StudentSidebar from "@/components/nav/StudentSidebar";
import Topbar from "@/components/nav/Topbar";
import AccountStatusScreen from "@/components/account/AccountStatusScreen";

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
    return (
      <AccountStatusScreen
        role="student"
        displayName={user.displayName}
        email={user.email}
        accountStatus={user.accountStatus}
      />
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
