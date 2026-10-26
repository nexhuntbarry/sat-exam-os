// QA isolation. Hidden QA accounts live on production next to real users;
// a QA user is any `users.email` starting with `qa-test-`. Rule everywhere:
// a viewer only sees rows whose QA-ness matches their own (user.isQa).
// QA entities: users with a QA email; tests / class_groups / bug_reports
// whose creator is a QA user; submissions & answer_records of a QA student.
// The shared question bank (modules/questions) is visible to both sides,
// but QA users may not mutate it (see forbidQa).
import { cache } from "react";
import { NextResponse } from "next/server";
import { getServiceClient } from "./supabase";

export const QA_EMAIL_PREFIX = "qa-test-";
const QA_ILIKE = `${QA_EMAIL_PREFIX}%`;

export function isQaEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().startsWith(QA_EMAIL_PREFIX);
}

// Loose structural view of a PostgREST filter builder, so these helpers
// work on any `.from(...).select(...)` chain without fighting its generics.
interface FilterLike {
  ilike(column: string, pattern: string): FilterLike;
  not(column: string, operator: string, value: unknown): FilterLike;
  in(column: string, values: readonly unknown[]): FilterLike;
  or(filters: string): FilterLike;
}

/**
 * Restrict a users query to the viewer's side. `column` is "email" when
 * querying `users` directly, or "users.email" for an embedded
 * `users!inner(...)` join.
 */
export function scopeUsers<Q>(query: Q, viewerIsQa: boolean, column = "email"): Q {
  const q = query as unknown as FilterLike;
  return (viewerIsQa ? q.ilike(column, QA_ILIKE) : q.not(column, "ilike", QA_ILIKE)) as unknown as Q;
}

/**
 * Restrict a query on an id column (student_id, test id, class group id…)
 * to the viewer's side, given the set of QA ids for that column. Pass
 * `nullable` for columns like reporter_user_id so NULL rows stay on the
 * real side (a bare NOT IN would drop them).
 */
export function scopeIds<Q>(
  query: Q,
  column: string,
  qaIds: Set<string>,
  viewerIsQa: boolean,
  nullable = false,
): Q {
  const q = query as unknown as FilterLike;
  if (viewerIsQa) return q.in(column, Array.from(qaIds)) as unknown as Q;
  if (qaIds.size === 0) return query;
  const list = `(${Array.from(qaIds).join(",")})`;
  return (nullable
    ? q.or(`${column}.is.null,${column}.not.in.${list}`)
    : q.not(column, "in", list)) as unknown as Q;
}

/** JS-side check: does this id belong to the viewer's side? */
export function onSide(id: string | null | undefined, qaIds: Set<string>, viewerIsQa: boolean): boolean {
  return (!!id && qaIds.has(id)) === viewerIsQa;
}

// Per-request caches. QA accounts are few, so plain id sets are fine.
export const getQaUserIds = cache(async (): Promise<Set<string>> => {
  const db = getServiceClient();
  const { data, error } = await db.from("users").select("id").ilike("email", QA_ILIKE);
  // Fail closed: an empty set here would silently show QA rows to real users.
  if (error) throw new Error(`QA user lookup failed: ${error.message}`);
  return new Set((data ?? []).map((u) => u.id as string));
});

async function idsCreatedByQa(table: "tests" | "class_groups"): Promise<Set<string>> {
  const qaUsers = await getQaUserIds();
  if (qaUsers.size === 0) return new Set();
  const db = getServiceClient();
  const { data, error } = await db.from(table).select("id").in("created_by", Array.from(qaUsers));
  if (error) throw new Error(`QA ${table} lookup failed: ${error.message}`);
  return new Set((data ?? []).map((r) => r.id as string));
}

export const getQaTestIds = cache(() => idsCreatedByQa("tests"));
export const getQaClassGroupIds = cache(() => idsCreatedByQa("class_groups"));

/** QA users may not mutate the shared question bank / global settings. */
export function forbidQa(user: { isQa: boolean }): NextResponse | null {
  if (!user.isQa) return null;
  return NextResponse.json(
    { error: "QA accounts cannot modify shared data" },
    { status: 403 },
  );
}

/**
 * Cross-side linking guard: every referenced user / test / class group must
 * have the same QA-ness as the acting user. Returns a 403 response or null.
 */
export async function forbidCrossSide(
  user: { isQa: boolean },
  refs: { userIds?: Iterable<string>; testIds?: Iterable<string>; classGroupIds?: Iterable<string> },
): Promise<NextResponse | null> {
  const checks: [Iterable<string> | undefined, () => Promise<Set<string>>][] = [
    [refs.userIds, getQaUserIds],
    [refs.testIds, getQaTestIds],
    [refs.classGroupIds, getQaClassGroupIds],
  ];
  for (const [ids, load] of checks) {
    const list = Array.from(ids ?? []).filter(Boolean);
    if (list.length === 0) continue;
    const qaIds = await load();
    if (list.some((id) => !onSide(id, qaIds, user.isQa))) {
      return NextResponse.json(
        { error: "Cannot link QA and real accounts/data" },
        { status: 403 },
      );
    }
  }
  return null;
}
