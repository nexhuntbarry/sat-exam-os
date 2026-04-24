import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function DashboardRedirectPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/sign-in");
  }

  if (user.role === "admin") {
    redirect("/admin");
  }
  if (user.role === "teacher") {
    redirect("/teacher");
  }
  // student or unknown → student dashboard
  redirect("/student");
}
