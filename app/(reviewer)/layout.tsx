import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import Topbar from "@/components/nav/Topbar";

// Layout for the reviewer route — accessible to admins (implicit) and to
// teachers whose `can_review_questions` flag is on. Wraps the
// QuestionReviewPanel surface so a "key teacher" can approve, reject,
// and resolve mismatches without seeing the rest of the admin console.
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

  return (
    <div className="flex flex-col h-screen bg-cream text-charcoal">
      <Topbar title="Question Review" />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
