// lib/full-length.ts
//
// Full-length SAT (plan: .omc/plans/full-length-sat.md). A full-length
// test is a `tests` row of kind 'full_length' (the parent) with two hidden
// 'fl_section' children: section_order 1 = Reading and Writing, 2 = Math.
// Submissions belong to the children; assignments, dates, answer settings
// and retake grants belong to the parent.
//
// Phase 0 helpers: child ↔ parent mapping for the shared code that reads
// tests / submissions by test id. With no full-length tests in the
// database every helper here is a no-op (empty maps, ids unchanged).
//
// The links are read through one small query (every child row), memoized
// per Supabase client object for a few seconds (each request makes its own
// client). Until migration 0031 is applied the columns don't exist and no
// full-length test can exist either, so a "column missing" error reads as
// "no links". Any other error is thrown by fullLengthLinks / parentOf /
// childrenOf / expandFullLength / childTestIds (callers fail closed);
// fullLengthLinksOrNone, resolveParentTestId, reviewSectionTests,
// hasOpenFullLengthAttempt and labelFullLengthChildren never throw on it
// and behave as if there were no full-length tests.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";

export interface FullLengthChildren {
  /** Reading and Writing child (section_order 1). */
  rw: string | null;
  /** Math child (section_order 2). */
  math: string | null;
}

export interface FullLengthLinks {
  /** child id → parent id */
  parentOf: Map<string, string>;
  /** parent id → its children */
  childrenOf: Map<string, FullLengthChildren>;
}

const EMPTY_LINKS = (): FullLengthLinks => ({ parentOf: new Map(), childrenOf: new Map() });

function isMissingColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const msg = err.message ?? "";
  return /parent_test_id|section_order/.test(msg) && /does not exist|schema cache/.test(msg);
}

/** Pure: build the maps from child rows. */
export function buildFullLengthLinks(
  rows: { id: string; parent_test_id: string | null; section_order: number | null }[],
): FullLengthLinks {
  const out = EMPTY_LINKS();
  for (const r of rows) {
    if (!r.parent_test_id) continue;
    out.parentOf.set(r.id, r.parent_test_id);
    const kids = out.childrenOf.get(r.parent_test_id) ?? { rw: null, math: null };
    if (r.section_order === 1) kids.rw = r.id;
    else if (r.section_order === 2) kids.math = r.id;
    out.childrenOf.set(r.parent_test_id, kids);
  }
  return out;
}

type ChildRow = { id: string; parent_test_id: string | null; section_order: number | null };

async function queryLinks(db: SupabaseClient): Promise<FullLengthLinks> {
  const { data, error } = await fetchAllRows<ChildRow>((from, to) =>
    db
      .from("tests")
      .select("id, parent_test_id, section_order")
      .not("parent_test_id", "is", null)
      .order("id")
      .range(from, to),
  );
  if (error) {
    const err = error as { code?: string; message?: string };
    if (isMissingColumn(err)) return EMPTY_LINKS();
    throw new Error(`full-length links lookup failed: ${err.message ?? String(error)}`);
  }
  return buildFullLengthLinks(data);
}

// Memo per client object (one per request in practice). The short TTL
// keeps a long-lived client from serving stale links; failures aren't kept.
const LINKS_TTL_MS = 10_000;
const memo = new WeakMap<object, { at: number; links: Promise<FullLengthLinks> }>();

function loadLinks(db: SupabaseClient): Promise<FullLengthLinks> {
  const hit = memo.get(db);
  if (hit && Date.now() - hit.at < LINKS_TTL_MS) return hit.links;
  const links = queryLinks(db);
  memo.set(db, { at: Date.now(), links });
  links.catch(() => {
    if (memo.get(db)?.links === links) memo.delete(db);
  });
  return links;
}

/** Every child → parent and parent → children link. */
export function fullLengthLinks(db: SupabaseClient): Promise<FullLengthLinks> {
  return loadLinks(db);
}

/**
 * fullLengthLinks for student-facing lists: on a lookup error, no links
 * (rows stay under their own test id, as before full-length existed)
 * instead of failing the student's page.
 */
export async function fullLengthLinksOrNone(db: SupabaseClient): Promise<FullLengthLinks> {
  try {
    return await loadLinks(db);
  } catch (e) {
    console.error("[full-length] links lookup failed", e);
    return EMPTY_LINKS();
  }
}

/** child id → parent id, for the children among `testIds`. */
export async function parentOf(db: SupabaseClient, testIds: Iterable<string>): Promise<Map<string, string>> {
  const links = await loadLinks(db);
  const out = new Map<string, string>();
  for (const id of testIds) {
    const p = links.parentOf.get(id);
    if (p) out.set(id, p);
  }
  return out;
}

/** parent id → { rw, math }, for the full-length parents among `parentIds`. */
export async function childrenOf(
  db: SupabaseClient,
  parentIds: Iterable<string>,
): Promise<Map<string, FullLengthChildren>> {
  const links = await loadLinks(db);
  const out = new Map<string, FullLengthChildren>();
  for (const id of parentIds) {
    const c = links.childrenOf.get(id);
    if (c) out.set(id, c);
  }
  return out;
}

/** Pure: testIds ∪ the children of any full-length parent among them (input order kept). */
export function expandWithChildren(testIds: Iterable<string>, links: FullLengthLinks): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const id of testIds) {
    push(id);
    const c = links.childrenOf.get(id);
    if (c) {
      push(c.rw);
      push(c.math);
    }
  }
  return out;
}

/**
 * testIds ∪ children: use wherever submissions are fetched by test_id for
 * a test that may be a full-length parent (its submissions are on the
 * children). Unchanged for section tests.
 */
export async function expandFullLength(db: SupabaseClient, testIds: Iterable<string>): Promise<string[]> {
  return expandWithChildren(testIds, await loadLinks(db));
}

/**
 * The parent of `testId` when it is a full-length child, else `testId`.
 * Never throws: on a lookup error it returns `testId`, which only ever
 * narrows access (a child has no assignments of its own) and keeps the
 * section-test pages that call it (landing, take, result) loading.
 */
export async function resolveParentTestId(db: SupabaseClient, testId: string): Promise<string> {
  try {
    return (await loadLinks(db)).parentOf.get(testId) ?? testId;
  } catch (e) {
    console.error("[full-length] parent lookup failed", testId, e);
    return testId;
  }
}

/** Every full-length child test id (to hide them from lists). */
export async function childTestIds(db: SupabaseClient): Promise<Set<string>> {
  return new Set((await loadLinks(db)).parentOf.keys());
}

interface FilterLike {
  not(column: string, operator: string, value: unknown): FilterLike;
}

/**
 * Leave full-length children out of a tests query (`column` = the test id
 * column). Same shape as lib/qa scopeIds; a no-op when there are none.
 */
export function hideChildTests<Q>(query: Q, childIds: Set<string>, column = "id"): Q {
  if (childIds.size === 0) return query;
  return (query as unknown as FilterLike).not(column, "in", `(${Array.from(childIds).join(",")})`) as unknown as Q;
}

// ------------------------------------------------------------------ attempts

const DONE = new Set(["Submitted", "Late"]);
const isModule2 = (t: string | null | undefined) =>
  t === "module_2" || t === "module_2_easy" || t === "module_2_hard";

export interface FullLengthRow {
  test_id: string;
  student_id: string;
  status: string;
  attempt_number?: number | null;
  adaptive_track?: string | null;
}

/**
 * Is this full-length attempt finished? Finished = the Math child's
 * Module 2 is graded (every source section test has two modules). `rows`
 * are one student's rows of one attempt, on either child.
 */
export function fullLengthAttemptDone(rows: FullLengthRow[], children: FullLengthChildren): boolean {
  return rows.some((r) => r.test_id === children.math && isModule2(r.adaptive_track) && DONE.has(r.status));
}

/** One student's child rows grouped by attempt_number. */
function byAttempt<T extends FullLengthRow>(rows: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    const n = r.attempt_number ?? 1;
    out.set(n, [...(out.get(n) ?? []), r]);
  }
  return out;
}

/**
 * Answer-visibility inputs of one student on one full-length test, from
 * their rows on both children. An attempt counts as submitted only when
 * the whole attempt is done (so R&W answers never show while Math is
 * still to come); closed attempts (full_length_attempts.closed_at — Math
 * can no longer be started) count as finished.
 */
export function fullLengthVisibilityState(
  rows: FullLengthRow[],
  children: FullLengthChildren,
  closedAttempts: Set<number> = new Set(),
): { hasSubmitted: boolean; retakeInProgress: boolean; examInProgress: boolean } {
  const attempts = byAttempt(rows);
  const finished = new Set<number>();
  for (const [n, list] of attempts) {
    if (fullLengthAttemptDone(list, children) || closedAttempts.has(n)) finished.add(n);
  }
  const minFinished = Math.min(...finished);
  let retakeInProgress = false;
  let examInProgress = false;
  for (const n of attempts.keys()) {
    if (finished.has(n)) continue;
    examInProgress = true;
    if (n > minFinished) retakeInProgress = true;
  }
  return { hasSubmitted: finished.size > 0, retakeInProgress, examInProgress };
}

/**
 * Counting view for list pages: rows of full-length children re-labelled
 * under the parent, one session per full-length attempt
 * (`fl:<parent>:<student>:<attempt>`), and every row of an attempt that
 * isn't finished counted as In Progress (an attempt on its break is in
 * progress, not done). Rows of other tests are returned as they are, so
 * section tests count exactly as before. Never written back.
 */
export function asParentRows<T extends FullLengthRow & { session_id?: string | null }>(
  rows: T[],
  links: FullLengthLinks,
): T[] {
  if (links.parentOf.size === 0) return rows;
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const parent = links.parentOf.get(r.test_id);
    if (!parent) continue;
    const k = `fl:${parent}:${r.student_id}:${r.attempt_number ?? 1}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const done = new Map<string, boolean>();
  for (const [k, list] of groups) {
    const parent = links.parentOf.get(list[0].test_id)!;
    done.set(k, fullLengthAttemptDone(list, links.childrenOf.get(parent) ?? { rw: null, math: null }));
  }
  return rows.map((r) => {
    const parent = links.parentOf.get(r.test_id);
    if (!parent) return r;
    const k = `fl:${parent}:${r.student_id}:${r.attempt_number ?? 1}`;
    return {
      ...r,
      test_id: parent,
      session_id: k,
      status: done.get(k) ? r.status : DONE.has(r.status) ? "In Progress" : r.status,
    };
  });
}

/**
 * Does the student have a full-length attempt on this parent that may
 * still continue: not closed, and its Math Module 2 not graded yet (an
 * attempt on its break counts)? False for every section test, and false
 * (no extra access) on any lookup error — never throws.
 */
export async function hasOpenFullLengthAttempt(
  db: SupabaseClient,
  testId: string,
  studentId: string,
): Promise<boolean> {
  let children: FullLengthChildren | undefined;
  try {
    children = (await loadLinks(db)).childrenOf.get(testId);
  } catch (e) {
    // Grants nothing on a lookup error (section tests are never parents).
    console.error("[full-length] links lookup failed", testId, e);
    return false;
  }
  if (!children) return false;
  const { data: attempt, error } = await db
    .from("full_length_attempts")
    .select("attempt_number")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .is("closed_at", null)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[full-length] attempt lookup failed", testId, error.message);
    return false;
  }
  if (!attempt) return false;
  const childIds = [children.rw, children.math].filter((x): x is string => Boolean(x));
  const { data: rows, error: rowsError } = await db
    .from("submissions")
    .select("test_id, student_id, status, attempt_number, adaptive_track")
    .in("test_id", childIds)
    .eq("student_id", studentId)
    .eq("attempt_number", attempt.attempt_number as number);
  if (rowsError) {
    console.error("[full-length] attempt rows lookup failed", testId, rowsError.message);
    return false;
  }
  return !fullLengthAttemptDone((rows ?? []) as FullLengthRow[], children);
}

/**
 * Rename full-length section children in `names` (test id → name) to
 * "<parent name> — Reading and Writing" / "— Math", so a renamed parent
 * shows up everywhere a child is named. Labels only: on any error the
 * child keeps its own name.
 */
export async function labelFullLengthChildren(db: SupabaseClient, names: Map<string, string>): Promise<void> {
  try {
    const links = await loadLinks(db);
    const kids = [...names.keys()].filter((id) => links.parentOf.has(id));
    if (kids.length === 0) return;
    const parentIds = [...new Set(kids.map((id) => links.parentOf.get(id)!))];
    const { data, error } = await db.from("tests").select("id, test_name").in("id", parentIds);
    if (error) return;
    const parentName = new Map(((data ?? []) as { id: string; test_name: string | null }[]).map((t) => [t.id, t.test_name]));
    for (const id of kids) {
      const parent = links.parentOf.get(id)!;
      const name = parentName.get(parent);
      if (!name) continue;
      const section = links.childrenOf.get(parent)?.rw === id ? "Reading and Writing" : "Math";
      names.set(id, `${name} — ${section}`);
    }
  } catch {
    // keep the children's own names
  }
}

/**
 * Class review of a test, in order: the test itself, or for a full-length
 * parent its section children (Reading and Writing, then Math) read with
 * the same `columns`, each with the label prefix its module titles get.
 */
export async function reviewSectionTests<T extends { id: string }>(
  db: SupabaseClient,
  test: T,
  columns: string,
): Promise<{ test: T; prefix: string }[]> {
  // Fail-open: on a lookup error the test is shown as a section test.
  const kids = (await fullLengthLinksOrNone(db)).childrenOf.get(test.id);
  if (!kids) return [{ test, prefix: "" }];
  const ids = [kids.rw, kids.math].filter((x): x is string => Boolean(x));
  const { data, error } = await db.from("tests").select(columns).in("id", ids);
  if (error) throw new Error(`full-length sections lookup failed: ${error.message}`);
  const rows = (data ?? []) as unknown as T[];
  return ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is T => Boolean(r))
    .map((r) => ({ test: r, prefix: r.id === kids.rw ? "Reading and Writing · " : "Math · " }));
}
