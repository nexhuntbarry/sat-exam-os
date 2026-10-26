// Validation helpers shared by the admin test / class-group / assignment
// routes. Every function returns an error string (safe to show to the
// admin) or null, so callers can do `if (err) return 400`.
import { getServiceClient } from "@/lib/supabase";
import { getQaClassGroupIds, scopeIds } from "@/lib/qa";

type Db = ReturnType<typeof getServiceClient>;

export const TEST_NAME_MAX = 150;
export const TIME_LIMIT_MIN = 1;
export const TIME_LIMIT_MAX = 180;
export const TEST_STATUSES = ["Draft", "Published", "Closed"] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function testNameError(v: unknown): string | null {
  const name = typeof v === "string" ? v.trim() : "";
  if (!name) return "Test name is required";
  if (name.length > TEST_NAME_MAX) return `Test name must be at most ${TEST_NAME_MAX} characters`;
  return null;
}

/** null/undefined are allowed (column is nullable); numbers must be whole minutes in range. */
export function timeLimitError(v: unknown, label: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < TIME_LIMIT_MIN || v > TIME_LIMIT_MAX) {
    return `${label} must be a whole number between ${TIME_LIMIT_MIN} and ${TIME_LIMIT_MAX} minutes`;
  }
  return null;
}

export function thresholdError(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
    return "Adaptive threshold must be between 0 and 100";
  }
  return null;
}

/**
 * Parse an open/due timestamp. Only absolute timestamps are accepted: a
 * timezone-less "2026-10-27T10:00" would be stored as UTC by Postgres and
 * shift by the admin's UTC offset, so it's rejected outright.
 */
export function parseTimestamp(
  v: unknown,
  label: string,
): { value: string | null; error: string | null } {
  if (v === null || v === undefined || v === "") return { value: null, error: null };
  if (typeof v !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(v.trim())) {
    return { value: null, error: `${label} must be an ISO timestamp with a timezone` };
  }
  const d = new Date(v);
  if (isNaN(d.getTime())) return { value: null, error: `${label} is not a valid date` };
  return { value: d.toISOString(), error: null };
}

export function dateOrderError(open: string | null, due: string | null): string | null {
  if (open && due && new Date(due).getTime() <= new Date(open).getTime()) {
    return "Due date must be after the open date";
  }
  return null;
}

/** All ids exist and belong to one section (Math vs Reading & Writing). */
export async function moduleSetError(db: Db, ids: string[]): Promise<string | null> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return null;
  const { data, error } = await db.from("modules").select("id, section").in("id", unique);
  if (error) return "Could not verify modules";
  if ((data ?? []).length !== unique.length) return "One or more selected modules do not exist";
  if (new Set((data ?? []).map((m) => m.section)).size > 1) {
    return "All modules in a test must be from the same section";
  }
  return null;
}

/**
 * Students only see Approved questions, so a module still holding Draft /
 * Needs Review questions would be graded against questions nobody saw.
 * Returns a message naming the incomplete modules, or null.
 */
export async function moduleApprovalError(db: Db, ids: string[]): Promise<string | null> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return null;
  const [{ data: pending, error: pendingErr }, { data: approved, error: approvedErr }, { data: mods }] =
    await Promise.all([
      db.from("questions")
        .select("module_id")
        .in("module_id", unique)
        .not("parsing_status", "in", "(Approved,Rejected)"),
      db.from("questions")
        .select("module_id")
        .in("module_id", unique)
        .eq("parsing_status", "Approved"),
      db.from("modules").select("id, module_name").in("id", unique),
    ]);
  if (pendingErr || approvedErr) return "Could not verify module question status";
  const pendingIds = new Set((pending ?? []).map((q) => q.module_id as string));
  const approvedIds = new Set((approved ?? []).map((q) => q.module_id as string));
  const bad = unique.filter((id) => pendingIds.has(id) || !approvedIds.has(id));
  if (bad.length === 0) return null;
  const names = bad.map((id) => (mods ?? []).find((m) => m.id === id)?.module_name ?? id);
  return `These modules still have questions that are not Approved: ${names.join(", ")}. Approve or reject every question first.`;
}

/** Every id must be a user with the given role. */
export async function roleError(
  db: Db,
  ids: string[] | undefined,
  role: "student" | "teacher",
): Promise<string | null> {
  const unique = Array.from(new Set((ids ?? []).filter(Boolean)));
  if (unique.length === 0) return null;
  const { data, error } = await db.from("users").select("id").in("id", unique).eq("role", role);
  if (error) return "Could not verify users";
  if ((data ?? []).length !== unique.length) {
    return `Only ${role}s can be added here`;
  }
  return null;
}

/** Case-insensitive name clash on the caller's side (QA vs real). */
export async function classNameTaken(
  db: ReturnType<typeof getServiceClient>,
  name: string,
  viewerIsQa: boolean,
  excludeId?: string,
): Promise<boolean> {
  let q = scopeIds(
    db.from("class_groups").select("id").ilike("name", name.replace(/[\\%_]/g, "\\$&")),
    "id",
    await getQaClassGroupIds(),
    viewerIsQa,
  );
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q.limit(1);
  return (data ?? []).length > 0;
}
