import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import AdminSidebar from "@/components/nav/AdminSidebar";
import TeacherSidebar from "@/components/nav/TeacherSidebar";
import Topbar from "@/components/nav/Topbar";

// Layout for the reviewer route — accessible to admins (implicit) and
// to teachers whose `can_review_questions` flag is on. Renders the
// caller's role-specific sidebar so navigation context stays put while
// they review questions.
export default async function ReviewerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/sign-in");
  }
  if (!user.canReviewQuestions) {
    redirect("/dashboard");
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
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
