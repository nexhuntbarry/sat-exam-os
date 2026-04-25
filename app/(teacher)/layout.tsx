import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import TeacherSidebar from "@/components/nav/TeacherSidebar";
import Topbar from "@/components/nav/Topbar";

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

  return (
    <div className="flex flex-col h-screen bg-cream text-charcoal">
      <Topbar title="Teacher" />
      <div className="flex flex-1 min-h-0">
        <TeacherSidebar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
