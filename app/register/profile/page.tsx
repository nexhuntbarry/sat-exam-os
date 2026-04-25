import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getServiceClient } from "@/lib/supabase";
import Logo from "@/components/Logo";
import ProfileForm from "./ProfileForm";

export default async function RegisterProfilePage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    redirect("/sign-in");
  }

  const clerkUser = await currentUser();
  const displayName =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") ||
    clerkUser?.username ||
    clerkUser?.emailAddresses?.[0]?.emailAddress?.split("@")[0] ||
    "";

  // If the user already has a complete student profile, skip straight to dashboard.
  // Mirrors the "complete profile" check used on the student dashboard
  // (app/(student)/student/page.tsx): grade && school.
  const db = getServiceClient();
  const { data: existingUser } = await db
    .from("users")
    .select("id")
    .eq("clerk_user_id", clerkId)
    .single();

  if (existingUser?.id) {
    const { data: profile } = await db
      .from("student_profiles")
      .select("grade, school")
      .eq("user_id", existingUser.id)
      .single();

    if (profile?.grade && profile?.school) {
      redirect("/dashboard");
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-24 bg-deep-navy">
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full opacity-10 blur-3xl bg-lime-green pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-md">
        <div className="flex flex-col items-center gap-3">
          <Logo size={48} />
          <h1 className="text-xl font-semibold text-white">SAT Exam OS</h1>
          <p className="text-soft-gray/60 text-sm">Student Self-Registration</p>
        </div>

        <div className="w-full">
          <ProfileForm displayName={displayName} />
        </div>
      </div>
    </main>
  );
}
