import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import Logo from "@/components/Logo";
import RoleConfirmCard from "./RoleConfirmCard";

type Row = { role: string | null; accountStatus: string };

/**
 * Webhook hasn't created the users row yet (svix can lag the redirect) —
 * create a PENDING teacher + teacher_profiles here, like
 * /api/student/complete-registration does for students. A unique
 * violation means the webhook won the race: re-select its row.
 */
async function createPendingTeacher(clerkId: string): Promise<Row | null> {
  const db = getServiceClient();
  const cu = await currentUser();
  const email =
    cu?.primaryEmailAddress?.emailAddress ?? cu?.emailAddresses?.[0]?.emailAddress ?? "";
  if (!email) return null;
  const displayName =
    [cu?.firstName, cu?.lastName].filter(Boolean).join(" ") ||
    cu?.username ||
    email.split("@")[0];

  const { data: created, error } = await db
    .from("users")
    .insert({
      clerk_user_id: clerkId,
      email,
      display_name: displayName,
      role: "teacher",
      account_status: "pending",
      metadata: { self_signup: true },
    })
    .select("id, role, account_status")
    .single();

  if (created) {
    const { error: profErr } = await db
      .from("teacher_profiles")
      .upsert({ user_id: created.id }, { onConflict: "user_id", ignoreDuplicates: true });
    if (profErr) console.error("[register/role] teacher_profiles insert failed:", profErr);
    return { role: created.role, accountStatus: created.account_status };
  }

  if (error?.code !== "23505") {
    console.error("[register/role] users insert failed:", error);
    return null;
  }
  const { data: raced } = await db
    .from("users")
    .select("role, account_status")
    .eq("clerk_user_id", clerkId)
    .maybeSingle();
  return raced ? { role: raced.role, accountStatus: raced.account_status } : null;
}

// /register/role?as=teacher — landing spot after Teacher Sign-up and
// Teacher Sign In. Approved accounts (any role) go to their dashboard; a
// pending teacher sees the teacher pending screen; a pending STUDENT is
// asked whether they meant to sign up as a teacher (never converted
// silently). as=student goes to the student profile form.
export default async function RegisterRolePage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string | string[] }>;
}) {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  const as = (await searchParams).as === "teacher" ? "teacher" : "student";
  if (as === "student") redirect("/register/profile");

  // getCurrentUser also links an invited (pre-created) row by email.
  const current = await getCurrentUser();
  const row: Row | null = current
    ? { role: current.role, accountStatus: current.accountStatus }
    : await createPendingTeacher(clerkId);

  if (row) {
    if (row.role === "admin" || row.accountStatus === "approved") redirect("/dashboard");
    // Pending teacher → teacher pending screen; suspended anyone → their
    // layout's suspended screen.
    if (row.role !== "student" || row.accountStatus !== "pending") redirect("/dashboard");
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-24 bg-cream">
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full opacity-15 blur-3xl bg-warm-coral pointer-events-none" />
      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-md">
        <div className="flex flex-col items-center gap-3">
          <Logo size={48} />
          <h1 className="text-xl font-semibold text-charcoal">SAT Exam OS</h1>
        </div>
        {row ? (
          <RoleConfirmCard />
        ) : (
          <div className="bg-surface border border-divider rounded-2xl p-6 w-full text-center space-y-2">
            <h2 className="font-bold text-charcoal text-lg">We couldn&rsquo;t set up your account</h2>
            <p className="text-mid-gray text-sm leading-relaxed">
              This email may already belong to another account. Please refresh this page in a
              moment, or contact your administrator.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
