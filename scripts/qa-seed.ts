/**
 * Seed (or tear down) the hidden QA cast used for production testing.
 *
 * Usage:
 *   npx tsx scripts/qa-seed.ts            # create everything (idempotent)
 *   npx tsx scripts/qa-seed.ts --cleanup  # delete every QA row + Clerk user
 *
 * Every QA user has an email starting with `qa-test-` (lib/qa.ts), which is
 * what hides it from real accounts. Clerk logins use `+clerk_test` emails so
 * the dev instance never sends real mail. Only LOGIN_* users get a Clerk
 * account (the dev instance caps at 100 users); the rest are DB-only
 * students that test harnesses log in as by re-linking clerk_user_id.
 *
 * Writes the cast to .omc/qa/cast.json for the harness.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
  const [k, ...rest] = line.split("=");
  if (k && !process.env[k]) process.env[k] = rest.join("=").trim().replace(/^"|"$/g, "");
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const CLERK = process.env.CLERK_SECRET_KEY!;

const N_ADMINS = 3;
const N_TEACHERS = 10;
const N_STUDENTS = 100;
const LOGIN_STUDENTS = 7;
const CLASSES = ["A", "B", "C", "D", "E"];
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const email = (kind: string, n: string) => `qa-test-${kind}-${n}+clerk_test@example.com`;

async function clerk(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CLERK}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Clerk ${path} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function upsertUser(e: string, name: string, role: string) {
  const { data: existing } = await db.from("users").select("id, clerk_user_id").eq("email", e).maybeSingle();
  if (existing) return existing as { id: string; clerk_user_id: string | null };
  const { data, error } = await db
    .from("users")
    .insert({ email: e, display_name: name, role, account_status: "approved", metadata: { qa: true } })
    .select("id, clerk_user_id")
    .single();
  if (error) throw error;
  return data as { id: string; clerk_user_id: string | null };
}

async function ensureClerk(e: string, name: string, userId: string, current: string | null) {
  if (current) return current;
  const found = await clerk(`/users?email_address=${encodeURIComponent(e)}`);
  const [first, ...last] = name.split(" ");
  const u = found[0] ?? (await clerk("/users", {
    method: "POST",
    body: JSON.stringify({ email_address: [e], first_name: first, last_name: last.join(" "), skip_password_requirement: true }),
  }));
  await db.from("users").update({ clerk_user_id: u.id }).eq("id", userId);
  return u.id as string;
}

async function seed() {
  const cast: Record<string, unknown[]> = { admins: [], teachers: [], students: [], classes: [] };

  for (let i = 1; i <= N_ADMINS; i++) {
    const e = email("admin", pad(i, 2));
    const name = `TEST Admin ${pad(i, 2)}`;
    const u = await upsertUser(e, name, "admin");
    const clerkId = await ensureClerk(e, name, u.id, u.clerk_user_id);
    cast.admins.push({ id: u.id, email: e, name, clerkId });
  }
  const adminId = (cast.admins[0] as { id: string }).id;

  for (let i = 1; i <= N_TEACHERS; i++) {
    const e = email("teacher", pad(i, 2));
    const name = `TEST Teacher ${pad(i, 2)}`;
    const u = await upsertUser(e, name, "teacher");
    await db.from("teacher_profiles").upsert({ user_id: u.id, specialty: i % 2 ? "Math" : "Reading & Writing" }, { onConflict: "user_id" });
    const clerkId = await ensureClerk(e, name, u.id, u.clerk_user_id);
    cast.teachers.push({ id: u.id, email: e, name, clerkId, subject: i % 2 ? "Math" : "Reading & Writing" });
  }

  for (let i = 1; i <= N_STUDENTS; i++) {
    const e = email("student", pad(i, 3));
    const name = `TEST Student ${pad(i, 3)}`;
    const u = await upsertUser(e, name, "student");
    const cls = CLASSES[(i - 1) % CLASSES.length];
    await db.from("student_profiles").upsert(
      { user_id: u.id, grade: String(9 + (i % 4)), school: "TEST School", campus: "TEST", class_group: `TEST Class ${cls}`, target_score: 1200 + (i % 7) * 50 },
      { onConflict: "user_id" },
    );
    const clerkId = i <= LOGIN_STUDENTS ? await ensureClerk(e, name, u.id, u.clerk_user_id) : u.clerk_user_id;
    cast.students.push({ id: u.id, email: e, name, clerkId, class: cls });
  }

  for (const [ci, cls] of CLASSES.entries()) {
    const name = `TEST Class ${cls}`;
    let { data: group } = await db.from("class_groups").select("id").eq("name", name).eq("created_by", adminId).maybeSingle();
    if (!group) {
      ({ data: group } = await db.from("class_groups").insert({ name, campus: "TEST", grade: "11", created_by: adminId }).select("id").single());
    }
    const gid = group!.id as string;
    const members = (cast.students as { id: string; class: string }[]).filter((s) => s.class === cls);
    await db.from("class_group_members").upsert(members.map((s) => ({ class_group_id: gid, student_id: s.id })), { onConflict: "class_group_id,student_id" });
    // Two teachers per class: odd = Math, even = English.
    const math = cast.teachers[ci * 2] as { id: string };
    const eng = cast.teachers[ci * 2 + 1] as { id: string };
    await db.from("class_group_teachers").upsert(
      [
        { class_group_id: gid, teacher_id: math.id, assigned_by: adminId, subject: "Math" },
        { class_group_id: gid, teacher_id: eng.id, assigned_by: adminId, subject: "Reading & Writing" },
      ],
      { onConflict: "class_group_id,teacher_id" },
    );
    cast.classes.push({ id: gid, name, mathTeacher: math.id, englishTeacher: eng.id, students: members.length });
  }

  mkdirSync(".omc/qa", { recursive: true });
  writeFileSync(".omc/qa/cast.json", JSON.stringify(cast, null, 2));
  console.log(`admins ${cast.admins.length}, teachers ${cast.teachers.length}, students ${cast.students.length}, classes ${cast.classes.length}`);
}

async function cleanup() {
  const { data: qa } = await db.from("users").select("id, clerk_user_id").ilike("email", "qa-test-%");
  const ids = (qa ?? []).map((u) => u.id);
  console.log(`QA users: ${ids.length}`);
  if (ids.length === 0) return;
  // Tests / classes they created (cascades assignments, submissions, members).
  const { data: tests } = await db.from("tests").select("id").in("created_by", ids);
  if (tests?.length) await db.from("tests").delete().in("id", tests.map((t) => t.id));
  await db.from("submissions").delete().in("student_id", ids);
  await db.from("class_groups").delete().in("created_by", ids);
  await db.from("bug_reports").delete().in("reporter_user_id", ids);
  await db.from("notifications").delete().in("user_id", ids);
  for (const u of qa ?? []) {
    if (u.clerk_user_id) await clerk(`/users/${u.clerk_user_id}`, { method: "DELETE" }).catch((e) => console.warn(String(e)));
  }
  const { error } = await db.from("users").delete().in("id", ids);
  if (error) console.error("users delete:", error);
  console.log(`removed tests ${tests?.length ?? 0}, users ${ids.length}`);
}

(process.argv.includes("--cleanup") ? cleanup() : seed()).catch((e) => {
  console.error(e);
  process.exit(1);
});
