// lib/live-progress.ts
//
// Server side of the live progress view (types + text rules in
// lib/live-progress-shared.ts). One loader for every watching page and its
// polling endpoint: the admin Submissions page, the teacher test page and
// (later) the class Scores grid. Callers do the permission checks and pass
// the student scope; this applies QA isolation to the students it returns.
// Reads only — nothing here writes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import {
  attemptGroupKey,
  FL_ALL_SECTIONS,
  flAttemptKey,
  loadFlAttemptMeta,
  scoreAttemptGroup,
  type FlSectionScope,
} from "@/lib/full-length-score";
import { breakEndsAtMs } from "@/lib/full-length-attempt";
import { getAssignedStudentIds, getTestSections } from "@/lib/teacher-access";
import { getQaClassGroupIds, onSide, scopeUsers } from "@/lib/qa";
import {
  isModule2Track,
  moduleRemainingSeconds,
  moduleStartedAtIso,
  scopeToStudentQuestionSet,
  type ModuleTiming,
  type QuestionSetScope,
} from "@/lib/student-exam";
import { tabSwitchTotal } from "@/lib/tab-switches";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import {
  answeredCount,
  emptyLiveSnapshot,
  questionNumberOf,
  summarizeCounts,
  type LiveProgress,
  type LiveSnapshot,
  type NotStartedStudent,
} from "@/lib/live-progress-shared";

/** Ids per `.in(...)` filter, so the request URL stays short. */
const ID_CHUNK = 150;
/** Not-started students stop being polled for this long after the due date. */
const STARTS_GRACE_MS = 24 * 3600_000;

export interface LiveScope {
  /** The test the page shows (a full-length parent or any other test). */
  testId: string;
  viewerIsQa: boolean;
  /** Only these students (admin class filter / class teacher roster); null = everyone. */
  studentIds?: Set<string> | null;
  /** Full-length: sections the viewer may see (a single-subject teacher). Default both. */
  flScope?: FlSectionScope;
}

type LightRow = {
  id: string;
  test_id: string;
  student_id: string;
  status: string;
  started_at: string | null;
  submitted_at: string | null;
  attempt_number: number | null;
  session_id: string | null;
  adaptive_track: string | null;
  score: number | null;
  correct_count: number | null;
  total_questions: number | null;
  percentage: number | string | null;
  tab_switches: unknown;
};

type OpenRow = {
  id: string;
  test_id: string;
  module_id: string | null;
  started_at: string;
  adaptive_track: string | null;
  answers: Record<string, unknown> | null;
  current_index: unknown;
  last_seen_at: string | null;
  last_active_at: string | null;
  module_2_started_at: string | null;
  time_multiplier: unknown;
  tests: ModuleTiming & QuestionSetScope;
};

/** Students of one class group (on the viewer's QA side), or null when the class is unknown / other side. */
export async function classGroupStudentIds(
  db: SupabaseClient,
  classGroupId: string,
  viewerIsQa: boolean,
): Promise<Set<string> | null> {
  if (!onSide(classGroupId, await getQaClassGroupIds(), viewerIsQa)) return null;
  const { data: cg } = await db.from("class_groups").select("id").eq("id", classGroupId).maybeSingle();
  if (!cg) return null;
  const { data: members } = await db.from("class_group_members").select("student_id").eq("class_group_id", classGroupId);
  return new Set((members ?? []).map((m) => m.student_id as string));
}

/**
 * Live snapshot of one test: every unfinished attempt (where the student
 * is, answered so far, time left, last contact, left-tab count), the
 * per-student summary counts and the assigned students who haven't started.
 */
export async function loadLiveSnapshot(db: SupabaseClient, scope: LiveScope): Promise<LiveSnapshot> {
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();
  const allow = scope.studentIds ?? null;
  if (allow && allow.size === 0) return emptyLiveSnapshot(generatedAt);

  const links = await fullLengthLinksOrNone(db);
  const kids = links.childrenOf.get(scope.testId) ?? null;
  const testIds = kids ? [kids.rw, kids.math].filter((x): x is string => Boolean(x)) : [scope.testId];
  const flScope = scope.flScope ?? FL_ALL_SECTIONS;

  // Paged (PostgREST caps a response at 1000 rows) and, with a student
  // scope, chunked so the id list can't overflow the request URL.
  const lightRows = async (studentIds: string[] | null): Promise<LightRow[]> => {
    const { data, error } = await fetchAllRows<LightRow>((from, to) => {
      let q = scopeUsers(
        db
          .from("submissions")
          .select(
            "id, test_id, student_id, status, started_at, submitted_at, attempt_number, session_id, adaptive_track, " +
              "score, correct_count, total_questions, percentage, tab_switches:metadata->tab_switches, users!inner(email)",
          )
          .in("test_id", testIds),
        scope.viewerIsQa,
        "users.email",
      );
      if (studentIds) q = q.in("student_id", studentIds);
      return q.order("id").range(from, to) as unknown as PromiseLike<{ data: LightRow[] | null; error: unknown }>;
    });
    if (error) throw new Error(`live progress: submissions lookup failed: ${(error as { message?: string }).message ?? error}`);
    return data;
  };
  const rows: LightRow[] = [];
  if (allow) {
    const ids = Array.from(allow);
    for (let i = 0; i < ids.length; i += ID_CHUNK) rows.push(...(await lightRows(ids.slice(i, i + ID_CHUNK))));
  } else {
    rows.push(...(await lightRows(null)));
  }

  // Whether students may still start (drives the slow not-started poll).
  const { data: testRow } = await db.from("tests").select("status, due_date").eq("id", scope.testId).maybeSingle();
  const dueMs = testRow?.due_date ? Date.parse(testRow.due_date as string) : NaN;
  const acceptingStarts =
    !!testRow && testRow.status !== "Closed" && !(Number.isFinite(dueMs) && now - dueMs > STARTS_GRACE_MS);

  // Heavy columns only for the modules being taken right now.
  const openIds = rows.filter((r) => r.status === "In Progress").map((r) => r.id);
  const openById = new Map<string, OpenRow>();
  for (let i = 0; i < openIds.length; i += ID_CHUNK) {
    const { data: open, error: openError } = await db
      .from("submissions")
      .select(
        "id, test_id, module_id, started_at, adaptive_track, answers, current_index:metadata->current_index, " +
          "last_seen_at:metadata->>last_seen_at, last_active_at:metadata->>last_active_at, " +
          "module_2_started_at:metadata->>module_2_started_at, time_multiplier:metadata->time_multiplier, " +
          "tests!inner(time_limit_minutes, time_limit_minutes_module_2, is_untimed, is_adaptive, question_ids, module_id, module_2_id)",
      )
      .in("id", openIds.slice(i, i + ID_CHUNK));
    if (openError) throw new Error(`live progress: open modules lookup failed: ${openError.message}`);
    for (const r of (open ?? []) as unknown as OpenRow[]) openById.set(r.id, r);
  }

  // Questions per module, as the student sees them.
  const totals = new Map<string, number | null>();
  await Promise.all(
    [...openById.values()].map(async (r) => {
      const moduleId = r.module_id ?? r.tests.module_id ?? null;
      const k = `${r.test_id}:${moduleId}`;
      if (!moduleId || totals.has(k)) return;
      totals.set(k, null);
      const { count } = await scopeToStudentQuestionSet(
        db.from("questions").select("id", { count: "exact", head: true }),
        r.tests,
        moduleId,
      );
      totals.set(k, count ?? null);
    }),
  );

  const section = kids ? null : (await getTestSections(db, [scope.testId])).get(scope.testId) ?? null;
  const flMeta = kids ? await loadFlAttemptMeta(db, [scope.testId]) : undefined;

  const groups = new Map<string, LightRow[]>();
  for (const r of rows) {
    const key = attemptGroupKey(r, links);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const live: Record<string, LiveProgress> = {};
  const attempts: { studentId: string; attemptNumber: number; status: string }[] = [];
  const onBreak: { key: string; studentId: string; attemptNumber: number; rwM2: LightRow | undefined }[] = [];
  for (const [key, list] of groups) {
    const head = list[0];
    const { status, fullLength } = scoreAttemptGroup(list, links, section, flMeta);
    const flStatus = fullLength?.status ?? status;
    attempts.push({ studentId: head.student_id, attemptNumber: head.attempt_number ?? 1, status: flStatus });
    if (flStatus !== "In progress" && flStatus !== "On break") continue;

    const base: LiveProgress = {
      key,
      studentId: head.student_id,
      phase: "between",
      moduleLabel: null,
      questionNumber: null,
      answered: null,
      total: null,
      remainingSeconds: null,
      notOpened: false,
      breakRemainingSeconds: null,
      lastSeenAt: null,
      lastActiveAt: null,
      tabSwitches: tabSwitchTotal(list),
    };
    if (flStatus === "On break") {
      live[key] = { ...base, phase: "break" };
      onBreak.push({
        key,
        studentId: head.student_id,
        attemptNumber: head.attempt_number ?? 1,
        rwM2: list.find((r) => r.test_id === kids?.rw && isModule2Track(r.adaptive_track)),
      });
      continue;
    }

    // The module open right now (Module 2 over Module 1 if both somehow are).
    const openRow = list
      .filter((r) => r.status === "In Progress")
      .sort((a, b) => Number(isModule2Track(b.adaptive_track)) - Number(isModule2Track(a.adaptive_track)))[0];
    const open = openRow ? openById.get(openRow.id) : undefined;
    if (!openRow || !open) {
      // Module 1 graded, Module 2 not created yet (the handoff).
      live[key] = { ...base, lastSeenAt: lastSubmit(list) };
      continue;
    }

    const n = isModule2Track(open.adaptive_track) ? 2 : 1;
    const flSection = kids ? (open.test_id === kids.math ? "math" : "rw") : null;
    const moduleLabel = flSection
      ? `${flSection === "math" ? "Math" : "R&W"} · Module ${n}`
      : list.some((r) => r.adaptive_track)
      ? `Module ${n}`
      : null;
    const hidden = flSection != null && !flScope[flSection];
    const moduleId = open.module_id ?? open.tests.module_id ?? null;
    const total = totals.get(`${open.test_id}:${moduleId}`) ?? null;
    const answered = answeredCount(open.answers);
    const clock = {
      started_at: open.started_at,
      adaptive_track: open.adaptive_track,
      metadata: { module_2_started_at: open.module_2_started_at, time_multiplier: open.time_multiplier },
    };
    const startedIso = moduleStartedAtIso(clock);
    live[key] = {
      ...base,
      phase: "module",
      moduleLabel,
      questionNumber: hidden ? null : questionNumberOf(open.current_index, total),
      answered: hidden ? null : total != null ? Math.min(answered, total) : answered,
      total: hidden ? null : total,
      remainingSeconds: moduleRemainingSeconds(clock, open.tests, now),
      notOpened: !startedIso,
      // Rows saved before the stamp existed: the module's start is the last we know of.
      lastSeenAt: open.last_seen_at ?? open.last_active_at ?? startedIso ?? open.started_at,
      lastActiveAt: open.last_active_at ?? null,
    };
  }

  // Full-length break: time left from the attempt's break length.
  if (kids && onBreak.length > 0) {
    const { data: fl } = await db
      .from("full_length_attempts")
      .select("student_id, attempt_number, break_minutes, started_at")
      .eq("test_id", scope.testId)
      .in("student_id", [...new Set(onBreak.map((b) => b.studentId))]);
    const byKey = new Map(
      ((fl ?? []) as { student_id: string; attempt_number: number; break_minutes: number | null; started_at: string }[]).map(
        (a) => [flAttemptKey(scope.testId, a.student_id, a.attempt_number), a] as const,
      ),
    );
    for (const b of onBreak) {
      const a = byKey.get(flAttemptKey(scope.testId, b.studentId, b.attemptNumber));
      if (!a || !b.rwM2) continue;
      const ends = breakEndsAtMs(a, { submitted_at: b.rwM2.submitted_at, started_at: b.rwM2.started_at ?? a.started_at });
      live[b.key].breakRemainingSeconds = Number.isFinite(ends) ? Math.max(0, Math.ceil((ends - now) / 1000)) : null;
    }
  }

  // Roster: test_assignments student_ids ∪ class members, on the viewer's side.
  const { data: assignments, error: assignError } = await db
    .from("test_assignments")
    .select("student_ids, class_group_ids")
    .eq("test_id", scope.testId);
  if (assignError) throw new Error(`live progress: assignments lookup failed: ${assignError.message}`);
  const merged = {
    student_ids: (assignments ?? []).flatMap((a) => (a.student_ids as string[] | null) ?? []),
    class_group_ids: (assignments ?? []).flatMap((a) => (a.class_group_ids as string[] | null) ?? []),
  };
  const assigned = await getAssignedStudentIds(db, merged, scope.viewerIsQa, allow);
  const started = new Set(rows.map((r) => r.student_id));
  const missing = [...assigned].filter((id) => !started.has(id));
  let notStarted: NotStartedStudent[] = [];
  if (missing.length > 0) {
    // Chunked: a big roster's id list would overflow the request URL.
    const users: { id: string; display_name: string | null; email: string }[] = [];
    for (let i = 0; i < missing.length; i += ID_CHUNK) {
      // Only active accounts: pending / suspended students can't start anyway.
      const { data, error: usersError } = await scopeUsers(
        db
          .from("users")
          .select("id, display_name, email")
          .eq("account_status", "approved")
          .in("id", missing.slice(i, i + ID_CHUNK)),
        scope.viewerIsQa,
      );
      if (usersError) throw new Error(`live progress: users lookup failed: ${usersError.message}`);
      users.push(...((data ?? []) as typeof users));
    }
    notStarted = users
      .map((u) => ({ studentId: u.id, name: u.display_name || u.email, email: u.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    generatedAt,
    live,
    // Not started = assigned, on the viewer's side, active account.
    counts: summarizeCounts(attempts, notStarted.map((s) => s.studentId)),
    notStarted,
    acceptingStarts,
  };
}

function lastSubmit(rows: { submitted_at: string | null }[]): string | null {
  return rows.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null;
}
