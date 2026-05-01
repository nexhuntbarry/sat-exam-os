import { clerkClient } from "@clerk/nextjs/server";
import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import AdminsClient from "./AdminsClient";
import PageIntro from "@/components/shared/PageIntro";

async function getAdmins() {
  const db = getServiceClient();
  const { data } = await db
    .from("users")
    .select("id, email, display_name, account_status, created_at, clerk_user_id, is_super_admin")
    .eq("role", "admin")
    .order("created_at", { ascending: true });
  const admins = data ?? [];

  const clerkIds = admins
    .map((a) => a.clerk_user_id as string | null)
    .filter((id): id is string => Boolean(id));

  let lastSignInById: Record<string, number | null> = {};
  if (clerkIds.length > 0) {
    try {
      const cc = await clerkClient();
      const resp = await cc.users.getUserList({ userId: clerkIds, limit: clerkIds.length });
      lastSignInById = Object.fromEntries(
        resp.data.map((u) => [u.id, u.lastSignInAt ?? null]),
      );
    } catch (err) {
      console.error("[admins] Clerk getUserList failed:", err);
    }
  }

  return admins.map((a) => ({
    ...a,
    last_sign_in_at: a.clerk_user_id ? lastSignInById[a.clerk_user_id as string] ?? null : null,
  }));
}

export default async function AdminsPage() {
  const me = await getCurrentUser();
  const admins = await getAdmins();
  return (
    <>
      <PageIntro tKey="admin.admins" />
      <AdminsClient
        admins={admins}
        currentUserId={me?.userId ?? null}
        canInvite={Boolean(me?.isSuperAdmin)}
      />
    </>
  );
}
