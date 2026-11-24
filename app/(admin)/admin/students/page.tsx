import { clerkClient } from "@clerk/nextjs/server";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getServiceClient } from "@/lib/supabase";
import StudentsClient from "./StudentsClient";
import PageIntro from "@/components/shared/PageIntro";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, scopeIds, scopeUsers } from "@/lib/qa";
import { fetchAllRows } from "@/lib/fetch-all-rows";

async function getStudents(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeUsers(db
    .from("users")
    .select(
      `id, email, display_name, account_status, created_at, clerk_user_id, metadata,
       student_profiles(grade, school, campus, class_group, parent_name, parent_email, parent_phone, target_score, current_level, status_reason)`
    )
    .eq("role", "student"), viewerIsQa)
    .order("created_at", { ascending: false });
  const students = data ?? [];

  const clerkIds = students
    .map((s) => s.clerk_user_id as string | null)
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
      console.error("[students] Clerk getUserList failed:", err);
    }
  }

  return students.map((s) => ({
    ...s,
    last_sign_in_at: s.clerk_user_id ? lastSignInById[s.clerk_user_id as string] ?? null : null,
  }));
}

async function getClassGroups(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeIds(db
    .from("class_groups")
    .select("id, name, campus, grade"), "id", await getQaClassGroupIds(), viewerIsQa)
    .order("name");
  return data ?? [];
}

export default async function StudentsPage() {
  const isQa = (await getCurrentUser())?.isQa ?? false;
  const [students, classGroups] = await Promise.all([
    getStudents(isQa),
    getClassGroups(isQa),
  ]);

  // Class memberships per student (only groups visible to this viewer side).
  const nameById = new Map(classGroups.map((g) => [g.id as string, g.name as string]));
  const membershipsByStudent: Record<string, { id: string; name: string }[]> = {};
  if (students.length > 0 && nameById.size > 0) {
    const memberDb = getServiceClient();
    const cgKeys = [...nameById.keys()];
    const { data: members } = await fetchAllRows<{ student_id: string; class_group_id: string }>((from, to) =>
      memberDb
        .from("class_group_members")
        .select("student_id, class_group_id")
        .in("class_group_id", cgKeys)
        .order("student_id")
        .order("class_group_id")
        .range(from, to),
    );
    for (const m of members ?? []) {
      const name = nameById.get(m.class_group_id as string);
      if (!name) continue;
      (membershipsByStudent[m.student_id as string] ??= []).push({
        id: m.class_group_id as string,
        name,
      });
    }
  }
  const withClasses = students.map((s) => ({
    ...s,
    classes: (membershipsByStudent[s.id as string] ?? []).map((m) => m.name).sort(),
    classMemberships: (membershipsByStudent[s.id as string] ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  }));

  // Teachers see a student with no display name as "Unnamed student" (never
  // the email), so list them here for the admin to name.
  const unnamed = students.filter((s) => !(s.display_name as string | null)?.trim());
  const t = await getTranslations("admin.students.unnamed");

  return (
    <>
      <PageIntro tKey="admin.students" />
      {unnamed.length > 0 && (
        <section
          id="no-display-name"
          className="mb-6 bg-status-warning/5 border border-status-warning/20 rounded-2xl overflow-hidden"
        >
          <div className="px-5 py-3 border-b border-status-warning/20">
            <h2 className="text-status-warning font-semibold text-sm">
              {t("title", { count: unnamed.length })}
            </h2>
            <p className="text-soft-mute text-xs mt-0.5">{t("hint")}</p>
          </div>
          <ul className="divide-y divide-divider">
            {unnamed.map((s) => (
              <li key={s.id as string} className="px-5 py-2.5 flex items-center justify-between gap-4 text-sm">
                <span className="text-charcoal break-all">{s.email as string}</span>
                <Link
                  href={`/admin/students/${s.id as string}?edit=name`}
                  className="shrink-0 text-warm-coral-text text-xs font-semibold hover:underline"
                >
                  {t("addName")}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <StudentsClient students={withClasses} classGroups={classGroups} />
    </>
  );
}
