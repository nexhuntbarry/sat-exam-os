import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import TeacherSidebar from "@/components/nav/TeacherSidebar";
import AdminSidebar from "@/components/nav/AdminSidebar";
import Topbar from "@/components/nav/Topbar";
import AccountStatusScreen from "@/components/account/AccountStatusScreen";

// Admins frequently land on /teacher/* pages (cross-test results,
// per-submission detail, etc.) since those views are reused. We keep
// the admin chrome (sidebar, topbar title) so the navigation context
// doesn't suddenly jump from "Admin" to "Teacher" mid-flow — that
// confused operators in practice. Teachers still see the teacher
// sidebar; the auth check ahead is unchanged.
export default async function TeacherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/sign-in");
  }

  if (user.role !== "teacher" && user.role !== "admin") {
    redirect("/dashboard");
  }

  // Self-signed-up teachers start PENDING (admin approves under Admin →
  // Teachers); suspended teachers are locked out too. Same screen as
  // students; requireRole enforces it for the API routes. Admins pass.
  if (user.role === "teacher" && user.accountStatus !== "approved") {
    return (
      <AccountStatusScreen
        role="teacher"
        displayName={user.displayName}
        email={user.email}
        accountStatus={user.accountStatus}
      />
    );
  }

  const isAdmin = user.role === "admin";

  return (
    <div className="flex flex-col h-screen bg-cream text-charcoal">
      <Topbar title={isAdmin ? "Admin" : "Teacher"} />
      <div className="flex flex-1 min-h-0">
        {isAdmin ? (
          <AdminSidebar />
        ) : (
          <TeacherSidebar canReview={user.canReviewQuestions} />
        )}
        <main className="flex-1 min-w-0 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
