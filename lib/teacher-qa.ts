// lib/teacher-qa.ts
//
// Per-test admin switch "Teachers can view & print questions/answers"
// (tests.teacher_qa_enabled, migration 0032). When off, teachers can't open
// the Questions & answers (Class Review) page or print the test; they still
// see results and scores. Admins are never blocked. A full-length SAT
// section follows its parent's switch. Separate from tests.review_unlocked
// (the students' class-review lock): neither affects the other.
//
// The only place that reads or writes the column. Until 0032 is applied the
// column doesn't exist: reads treat that as ON, writes report it so the API
// can answer 503 "database update pending".

import type { SupabaseClient } from "@supabase/supabase-js";
import { parentOf } from "@/lib/full-length";

type DbError = { code?: string; message?: string; status?: number } | null | undefined;

/** Pure: the error is "teacher_qa_enabled doesn't exist yet" (migration 0032 not applied). */
export function isTeacherQaColumnMissing(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "42703") return true;
  const msg = err.message ?? "";
  if (!/teacher_qa_enabled/.test(msg)) return false;
  return err.code === "PGRST204" || err.code === "400" || err.status === 400 || /does not exist|schema cache/.test(msg);
}

export type TeacherQaDecision = "allow" | "no-access" | "off";

/**
 * Pure gate for the teacher Questions & answers page and teacher print.
 * no-access: not an admin or an approved teacher who can open the test
 * (getTeacherTestAccess) — the caller answers 404 / redirect.
 * off: an approved teacher with access, but the admin turned the switch off.
 */
export function decideTeacherQa(input: {
  role: string | null | undefined;
  accountStatus?: string | null;
  hasAccess: boolean;
  qaEnabled: boolean;
}): TeacherQaDecision {
  if (!input.hasAccess) return "no-access";
  if (input.role === "admin") return "allow";
  if (input.role !== "teacher") return "no-access";
  if (input.accountStatus != null && input.accountStatus !== "approved") return "no-access";
  return input.qaEnabled ? "allow" : "off";
}

/**
 * test id → switch value, for each of `testIds`. A full-length section
 * reads its parent's value; an unknown id reads true. A missing column
 * reads true; any other error throws (callers fail closed or catch).
 */
export async function readTeacherQaEnabled(db: SupabaseClient, testIds: Iterable<string>): Promise<Map<string, boolean>> {
  const ids = Array.from(new Set(testIds));
  const out = new Map<string, boolean>(ids.map((id) => [id, true]));
  if (ids.length === 0) return out;
  const parents = await parentOf(db, ids);
  const governing = (id: string) => parents.get(id) ?? id;
  const { data, error } = await db
    .from("tests")
    .select("id, teacher_qa_enabled")
    .in("id", Array.from(new Set(ids.map(governing))));
  if (error) {
    if (isTeacherQaColumnMissing(error)) return out;
    throw new Error(`teacher_qa_enabled lookup failed: ${error.message}`);
  }
  const value = new Map(
    ((data ?? []) as { id: string; teacher_qa_enabled: boolean | null }[]).map((r) => [r.id, r.teacher_qa_enabled !== false]),
  );
  for (const id of ids) out.set(id, value.get(governing(id)) ?? true);
  return out;
}

/**
 * For greying out Questions & answers buttons: the ids among `testIds` whose
 * switch is off, for a teacher viewer (empty for admins). A failed read
 * leaves the buttons enabled — the review page and print read it again and
 * fail closed.
 */
export async function teacherQaOffIds(
  db: SupabaseClient,
  user: { role: string | null | undefined },
  testIds: Iterable<string>,
): Promise<Set<string>> {
  if (user.role !== "teacher") return new Set();
  try {
    const enabled = await readTeacherQaEnabled(db, testIds);
    return new Set([...enabled].filter(([, on]) => !on).map(([id]) => id));
  } catch (e) {
    console.error("[teacher-qa] switch read failed:", e);
    return new Set();
  }
}

/** Set the switch on one test (a full-length parent, never a section). Throws on errors other than the missing column. */
export async function writeTeacherQaEnabled(
  db: SupabaseClient,
  testId: string,
  enabled: boolean,
): Promise<"ok" | "column-missing"> {
  const { error } = await db
    .from("tests")
    .update({ teacher_qa_enabled: enabled, updated_at: new Date().toISOString() })
    .eq("id", testId);
  if (!error) return "ok";
  if (isTeacherQaColumnMissing(error)) return "column-missing";
  throw new Error(`teacher_qa_enabled update failed: ${error.message}`);
}

/**
 * getTeacherTestAccess + the switch, for one test. `access` is the
 * getTeacherTestAccess result (scope queries with it as usual).
 */
export async function teacherQaGate(
  db: SupabaseClient,
  user: { userId: string; role: string | null | undefined; isQa: boolean; accountStatus?: string | null },
  testId: string,
) {
  // Loaded lazily so the pure helpers above stay importable by unit tests
  // (teacher-access pulls in next/server through lib/qa).
  const { getTeacherTestAccess } = await import("@/lib/teacher-access");
  const access = await getTeacherTestAccess(db, user, testId);
  const qaEnabled =
    user.role === "teacher" && access.mode !== null ? (await readTeacherQaEnabled(db, [testId])).get(testId) ?? true : true;
  return { decision: decideTeacherQa({ ...user, hasAccess: access.mode !== null, qaEnabled }), access };
}
