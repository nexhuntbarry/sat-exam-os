// lib/full-length-results.ts
//
// Server reads behind the full-length SAT results screens, CSV and
// printouts (plan Phase 3): every attempt on one full-length parent, with
// the student, both sections' rows and the combined score from
// lib/full-length-score. Section tests never come through here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import type { FullLengthChildren } from "@/lib/full-length";
import type { FullLengthResultRow } from "@/components/analytics/FullLengthResultsTable";
import {
  flAttemptKey,
  flBadge,
  flModuleCells,
  scopedFlScore,
  type FlSectionScope,
  fullLengthAttemptScore,
  lastSubmittedAt,
  loadFlAttemptMeta,
  timeSpentSeconds,
  type FlAttemptMeta,
  type FlScoreRow,
  type FullLengthScore,
} from "@/lib/full-length-score";

export type FlResultRow = FlScoreRow & {
  id: string;
  test_id: string;
  student_id: string;
  status: string;
  correct_count: number | null;
  total_questions: number | null;
  percentage: number | string | null;
  submitted_at: string | null;
  time_spent_seconds: number | null;
  attempt_number: number | null;
  session_id: string | null;
  adaptive_track: string | null;
  started_at: string | null;
  module_id: string | null;
  users: {
    display_name: string | null;
    email: string;
    student_profiles?: { grade?: string | null } | { grade?: string | null }[] | null;
  };
};

export interface FlResultAttempt {
  parentId: string;
  studentId: string;
  attemptNumber: number;
  key: string;
  studentName: string;
  email: string;
  grade: string | null;
  /** Module 1 first, then Module 2. */
  rw: FlResultRow[];
  math: FlResultRow[];
  meta: FlAttemptMeta | null;
  score: FullLengthScore;
  submittedAt: string | null;
  timeSeconds: number | null;
  /** Extended-time multiplier of the attempt (1 = none). */
  multiplier: number;
}

const byModule = (a: { adaptive_track: string | null }, b: { adaptive_track: string | null }) =>
  (a.adaptive_track === "module_1" ? 0 : 1) - (b.adaptive_track === "module_1" ? 0 : 1);

/**
 * Every attempt on a full-length parent, newest submission first.
 * `studentAllowlist` (a class teacher's roster) narrows the students;
 * QA isolation follows the viewer.
 */
export async function loadFullLengthResults(
  db: SupabaseClient,
  parentId: string,
  children: FullLengthChildren,
  opts: { studentAllowlist: Set<string> | null; isQa: boolean; studentIds?: string[] },
): Promise<FlResultAttempt[]> {
  const childIds = [children.rw, children.math].filter((x): x is string => Boolean(x));
  if (childIds.length === 0) return [];
  const qaUsers = await getQaUserIds();
  // Paged (PostgREST caps a response at 1000 rows); stable order for the pages.
  const { data, error } = await fetchAllRows<FlResultRow>((from, to) => {
    let q = db
      .from("submissions")
      .select(`
        id, test_id, student_id, status, correct_count, total_questions, percentage,
        submitted_at, time_spent_seconds, attempt_number, session_id, adaptive_track, started_at, module_id,
        users!inner(display_name, email, student_profiles(grade))
      `)
      .in("test_id", childIds);
    if (opts.studentAllowlist) q = q.in("student_id", Array.from(opts.studentAllowlist));
    if (opts.studentIds) q = q.in("student_id", opts.studentIds);
    q = scopeIds(q, "student_id", qaUsers, opts.isQa);
    return q.order("id").range(from, to) as unknown as PromiseLike<{ data: FlResultRow[] | null; error: unknown }>;
  });
  if (error) throw new Error(`full-length results lookup failed: ${(error as { message?: string }).message ?? String(error)}`);
  const rows = (data ?? []) as unknown as FlResultRow[];

  const meta = await loadFlAttemptMeta(db, [parentId]);
  const groups = new Map<string, { rw: FlResultRow[]; math: FlResultRow[] }>();
  for (const r of rows) {
    const k = flAttemptKey(parentId, r.student_id, r.attempt_number ?? 1);
    const g = groups.get(k) ?? { rw: [], math: [] };
    (r.test_id === children.math ? g.math : g.rw).push(r);
    groups.set(k, g);
  }

  const out: FlResultAttempt[] = [];
  for (const [key, g] of groups) {
    g.rw.sort(byModule);
    g.math.sort(byModule);
    const head = g.rw[0] ?? g.math[0];
    const sp = head.users.student_profiles ?? null;
    const profile = (Array.isArray(sp) ? sp[0] : sp) as { grade?: string | null } | null;
    const m = meta.get(key) ?? null;
    const both = [...g.rw, ...g.math];
    const mult = Number(m?.time_multiplier ?? 1);
    out.push({
      parentId,
      studentId: head.student_id,
      attemptNumber: head.attempt_number ?? 1,
      key,
      studentName: head.users.display_name || head.users.email,
      email: head.users.email,
      grade: profile?.grade ?? null,
      rw: g.rw,
      math: g.math,
      meta: m,
      score: fullLengthAttemptScore(g.rw, g.math, m),
      submittedAt: lastSubmittedAt(both),
      timeSeconds: timeSpentSeconds(both),
      multiplier: Number.isFinite(mult) && mult > 0 ? mult : 1,
    });
  }
  out.sort((a, b) => {
    if (a.submittedAt && b.submittedAt) return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });
  return out;
}

/** The row a "View results" link opens for one section of an attempt (its last graded module), or null. */
export function sectionDetailRowId(rows: { id: string; status: string }[]): string | null {
  const graded = rows.filter((r) => r.status === "Submitted" || r.status === "Late");
  return graded[graded.length - 1]?.id ?? null;
}

/**
 * Table rows for components/analytics/FullLengthResultsTable. Section
 * links (`sectionHref(childId, submissionId)`) are only given for a
 * finished section the viewer may see.
 */
export function fullLengthTableRows(
  attempts: FlResultAttempt[],
  opts: {
    children: FullLengthChildren;
    scope: FlSectionScope;
    classOf: Map<string, string>;
    retakePending: Set<string>;
    sectionHref: (childId: string, submissionId: string) => string;
  },
): FullLengthResultRow[] {
  return attempts.map((a) => {
    // A single-subject teacher: the hidden section never reaches the client.
    const s = scopedFlScore(a.score, opts.scope);
    const badge = flBadge(s);
    const [rwM1, rwM2] = flModuleCells(s.rw);
    const [mathM1, mathM2] = flModuleCells(s.math);
    const link = (childId: string | null, rows: FlResultRow[], visible: boolean) => {
      const id = visible && childId ? sectionDetailRowId(rows) : null;
      return id && childId ? opts.sectionHref(childId, id) : null;
    };
    return {
      key: a.key,
      studentId: a.studentId,
      studentName: a.studentName,
      email: a.email,
      classGroup: opts.classOf.get(a.studentId) ?? null,
      attemptNumber: a.attemptNumber,
      status: badge.status,
      statusLabel: badge.label ?? (s.status === "In progress" && s.current ? `In progress · ${s.current}` : undefined),
      totalScore: s.score,
      total: s.total,
      rw: s.rw.score,
      math: s.math.score,
      rwM1,
      rwM2,
      rwTrack: s.rwTrack || null,
      mathM1,
      mathM2,
      mathTrack: s.mathTrack || null,
      rwHref: link(opts.children.rw, a.rw, opts.scope.rw),
      mathHref: link(opts.children.math, a.math, opts.scope.math),
      timeSpentSeconds: a.timeSeconds,
      submittedAt: a.submittedAt,
      retakePending: opts.retakePending.has(a.studentId),
    };
  });
}

/** Latest attempt per student (highest attempt number). */
export function latestPerStudent(attempts: FlResultAttempt[]): FlResultAttempt[] {
  const best = new Map<string, FlResultAttempt>();
  for (const a of attempts) {
    const cur = best.get(a.studentId);
    if (!cur || a.attemptNumber > cur.attemptNumber) best.set(a.studentId, a);
  }
  return attempts.filter((a) => best.get(a.studentId) === a);
}
