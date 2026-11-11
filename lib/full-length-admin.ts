// lib/full-length-admin.ts
//
// Full-length SAT, Phase 1 (plan: .omc/plans/full-length-sat.md): admin
// create / re-sync / publish checks / accommodations. Kept free of
// next/server so the unit tests can load it; the routes do auth, QA-side
// and request validation, then call these helpers with the service client.
//
// Shape (migration 0031): the parent is a `tests` row of kind
// 'full_length' (no modules of its own; assignments, dates, answer
// settings, break and pause live here). Its two 'fl_section' children are
// snapshots of the chosen source section tests: module ids, adaptive
// threshold, time limits and math aids are copied, so later edits to the
// sources change nothing. The sync trigger keeps the children's status,
// dates and answer settings equal to the parent's.

import type { SupabaseClient } from "@supabase/supabase-js";

// ------------------------------------------------------------------ flag

/** app_settings key; value {enabled: boolean}. Missing row = off. */
export const FULL_LENGTH_SETTING_KEY = "full_length_enabled";

/** The global switch. Missing row or any read error = off. */
export async function getFullLengthSetting(db: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("app_settings")
      .select("value")
      .eq("key", FULL_LENGTH_SETTING_KEY)
      .maybeSingle();
    if (error) return false;
    return (data?.value as { enabled?: unknown } | null)?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * May this user create full-length tests, change their sources or set
 * accommodations? Hidden QA accounts always may (the nightly harness runs
 * on production before launch); everyone else only once the flag is on.
 */
export async function fullLengthEnabledFor(db: SupabaseClient, viewer: { isQa: boolean }): Promise<boolean> {
  if (viewer.isQa) return true;
  return getFullLengthSetting(db);
}

export const FULL_LENGTH_DISABLED_MESSAGE = "Full-length SAT tests are not available yet.";

// --------------------------------------------------------------- sections

export const FL_SECTIONS = [
  { key: "rw", order: 1, section: "Reading & Writing", label: "Reading and Writing" },
  { key: "math", order: 2, section: "Math", label: "Math" },
] as const;
export type FlSectionKey = (typeof FL_SECTIONS)[number]["key"];

/** SAT defaults per module, used when a source test has no time limit. */
export const FL_DEFAULT_MINUTES: Record<FlSectionKey, number> = { rw: 32, math: 35 };
export const FL_DEFAULT_BREAK_MINUTES = 10;
export const FL_BREAK_MAX_MINUTES = 60;

export function childTestName(parentName: string, key: FlSectionKey): string {
  return `${parentName.trim()} — ${FL_SECTIONS.find((s) => s.key === key)!.label}`;
}

export function breakMinutesError(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > FL_BREAK_MAX_MINUTES) {
    return `Break must be a whole number between 0 and ${FL_BREAK_MAX_MINUTES} minutes`;
  }
  return null;
}

// ---------------------------------------------------------------- sources

/** The columns a child copies from its source section test. */
export const SOURCE_COLUMNS =
  "id, test_name, is_adaptive, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, " +
  "adaptive_threshold, time_limit_minutes, time_limit_minutes_module_2, desmos_enabled, formula_sheet_url";

export interface SourceTest {
  id: string;
  test_name: string;
  is_adaptive: boolean | null;
  module_id: string | null;
  module_2_id: string | null;
  module_1_id: string | null;
  module_2_easy_id: string | null;
  module_2_hard_id: string | null;
  adaptive_threshold: number | null;
  time_limit_minutes: number | null;
  time_limit_minutes_module_2: number | null;
  desmos_enabled: boolean | null;
  formula_sheet_url: string | null;
}

type ModuleCols = Pick<
  SourceTest,
  "is_adaptive" | "module_id" | "module_2_id" | "module_1_id" | "module_2_easy_id" | "module_2_hard_id"
>;

/** Every module id a test serves (M1, M2 / M2 easy + hard). */
export function testModuleIds(t: ModuleCols): string[] {
  return (t.is_adaptive
    ? [t.module_1_id, t.module_2_easy_id, t.module_2_hard_id]
    : [t.module_id, t.module_2_id]
  ).filter((x): x is string => Boolean(x));
}

/** A section of a full-length test needs a Module 1 and a Module 2. */
export function twoModuleError(t: ModuleCols, label: string): string | null {
  const ok = t.is_adaptive
    ? Boolean(t.module_1_id && (t.module_2_easy_id || t.module_2_hard_id))
    : Boolean(t.module_id && t.module_2_id);
  return ok ? null : `${label} must be a two-module test (Module 1 and Module 2)`;
}

/** Are all of these modules in `section` (and do they all exist)? */
export async function moduleSectionError(
  db: SupabaseClient,
  ids: string[],
  section: string,
  label: string,
): Promise<string | null> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return `${label} has no modules`;
  const { data, error } = await db.from("modules").select("id, section").in("id", unique);
  if (error) return "Could not verify modules";
  const rows = (data ?? []) as { id: string; section: string | null }[];
  if (rows.length !== unique.length) return `${label}: one or more modules no longer exist`;
  if (rows.some((m) => m.section !== section)) return `${label} must only contain ${section} modules`;
  return null;
}

/**
 * Load and validate the two source tests: each an ordinary section test
 * (not a full-length test or one of its sections) with two modules, all
 * of the right section. `fullLengthIds` = every full-length parent and
 * section id (none of them may be a source).
 */
export async function loadFullLengthSources(
  db: SupabaseClient,
  ids: Record<FlSectionKey, string>,
  fullLengthIds: Set<string>,
): Promise<{ sources: Record<FlSectionKey, SourceTest> | null; error: string | null }> {
  const fail = (error: string) => ({ sources: null, error });
  if (!ids.rw || !ids.math) return fail("Choose a Reading and Writing test and a Math test");
  if (ids.rw === ids.math) return fail("Choose two different tests");
  if (fullLengthIds.has(ids.rw) || fullLengthIds.has(ids.math)) {
    return fail("A full-length test can't be used as a source — choose section tests");
  }
  const { data, error } = await db.from("tests").select(SOURCE_COLUMNS).in("id", [ids.rw, ids.math]);
  if (error) return fail("Could not load the source tests");
  const rows = (data ?? []) as unknown as SourceTest[];
  const out = {} as Record<FlSectionKey, SourceTest>;
  for (const s of FL_SECTIONS) {
    const label = `The ${s.label} test`;
    const t = rows.find((r) => r.id === ids[s.key]);
    if (!t) return fail(`${label} was not found`);
    const err =
      twoModuleError(t, label) ?? (await moduleSectionError(db, testModuleIds(t), s.section, label));
    if (err) return fail(err);
    out[s.key] = t;
  }
  return { sources: out, error: null };
}

/** The module-config columns a child copies from its source (snapshot). */
export function sourceSnapshot(src: SourceTest): Record<string, unknown> {
  return {
    is_adaptive: Boolean(src.is_adaptive),
    module_id: src.is_adaptive ? null : src.module_id,
    module_2_id: src.is_adaptive ? null : src.module_2_id,
    module_1_id: src.is_adaptive ? src.module_1_id : null,
    module_2_easy_id: src.is_adaptive ? src.module_2_easy_id : null,
    module_2_hard_id: src.is_adaptive ? src.module_2_hard_id : null,
    adaptive_threshold: src.adaptive_threshold ?? 60,
    desmos_enabled: Boolean(src.desmos_enabled),
    formula_sheet_url: src.formula_sheet_url ?? null,
    source_test_id: src.id,
  };
}

/** Module time limits a new full-length test starts with: the source's, else SAT standard. */
export function defaultSectionLimits(src: Pick<SourceTest, "time_limit_minutes" | "time_limit_minutes_module_2">, key: FlSectionKey) {
  const m1 = src.time_limit_minutes ?? FL_DEFAULT_MINUTES[key];
  return { m1, m2: src.time_limit_minutes_module_2 ?? m1 };
}

// ----------------------------------------------------------------- create

export interface SectionLimits {
  m1: number;
  m2: number;
}

export interface CreateFullLengthInput {
  testName: string;
  sources: Record<FlSectionKey, SourceTest>;
  limits: Record<FlSectionKey, SectionLimits>;
  breakMinutes: number;
  allowSectionPause: boolean;
  openDate: string | null;
  dueDate: string | null;
  showAnswersAfterSubmission: boolean;
  showExplanationsAfterSubmission: boolean;
  allowRetake: boolean;
  teacherIds: string[];
  studentIds: string[];
  classGroupIds: string[];
  createdBy: string;
}

/** Settings children share with the parent (the sync trigger keeps them equal). */
function sharedSettings(input: CreateFullLengthInput) {
  return {
    open_date: input.openDate,
    due_date: input.dueDate,
    show_answers_after_submission: input.showAnswersAfterSubmission,
    show_explanations_after_submission: input.showExplanationsAfterSubmission,
    allow_retake: input.allowRetake,
    status: "Draft",
    created_by: input.createdBy,
    is_untimed: false,
    question_ids: null,
  };
}

/** Pure: the parent and child rows for a new full-length test. */
export function fullLengthRows(input: CreateFullLengthInput) {
  const name = input.testName.trim();
  const parent = {
    test_name: name,
    test_kind: "full_length",
    is_adaptive: false,
    module_id: null,
    module_2_id: null,
    module_1_id: null,
    module_2_easy_id: null,
    module_2_hard_id: null,
    time_limit_minutes: null,
    time_limit_minutes_module_2: null,
    break_minutes: input.breakMinutes,
    allow_section_pause: input.allowSectionPause,
    ...sharedSettings(input),
  };
  const children = (parentId: string) =>
    FL_SECTIONS.map((s) => ({
      test_name: childTestName(name, s.key),
      test_kind: "fl_section",
      parent_test_id: parentId,
      section_order: s.order,
      ...sourceSnapshot(input.sources[s.key]),
      time_limit_minutes: input.limits[s.key].m1,
      time_limit_minutes_module_2: input.limits[s.key].m2,
      ...sharedSettings(input),
    }));
  return { parent, children };
}

/**
 * Insert the parent (Draft), then both children in one statement, then
 * the parent's assignment. A failed child insert deletes the parent (the
 * children cascade), so no half-built test is left behind.
 */
export async function createFullLengthTest(
  db: SupabaseClient,
  input: CreateFullLengthInput,
): Promise<{ id: string | null; error: string | null }> {
  const rows = fullLengthRows(input);
  const { data: parent, error: parentErr } = await db.from("tests").insert(rows.parent).select("id").single();
  if (parentErr || !parent) {
    console.error("[full-length/create] parent", parentErr);
    return { id: null, error: "Failed to create test" };
  }
  const parentId = (parent as { id: string }).id;
  const { error: childErr } = await db.from("tests").insert(rows.children(parentId)).select("id");
  if (childErr) {
    console.error("[full-length/create] children", childErr);
    const { error: undoErr } = await db.from("tests").delete().eq("id", parentId);
    if (undoErr) console.error("[full-length/create] rollback failed", parentId, undoErr);
    return { id: null, error: "Failed to create the test sections" };
  }
  const { error: assignErr } = await db.from("test_assignments").insert({
    test_id: parentId,
    teacher_ids: input.teacherIds,
    student_ids: input.studentIds,
    class_group_ids: input.classGroupIds,
    created_by: input.createdBy,
  });
  // Same as section tests: the test exists; the assignment can be fixed later.
  if (assignErr) console.error("[full-length/create] assignment", assignErr);
  return { id: parentId, error: null };
}

// --------------------------------------------------------- children / edit

export const CHILD_COLUMNS =
  "id, test_name, section_order, source_test_id, is_adaptive, module_id, module_2_id, module_1_id, " +
  "module_2_easy_id, module_2_hard_id, adaptive_threshold, time_limit_minutes, time_limit_minutes_module_2";

export interface ChildTest extends ModuleCols {
  id: string;
  test_name: string;
  section_order: number;
  source_test_id: string | null;
  adaptive_threshold: number | null;
  time_limit_minutes: number | null;
  time_limit_minutes_module_2: number | null;
}

/** A full-length test's children keyed by section (null when missing). */
export async function loadChildTests(
  db: SupabaseClient,
  parentId: string,
): Promise<{ children: Record<FlSectionKey, ChildTest | null>; error: string | null }> {
  const { data, error } = await db.from("tests").select(CHILD_COLUMNS).eq("parent_test_id", parentId);
  if (error) return { children: { rw: null, math: null }, error: "Could not load the test sections" };
  const rows = (data ?? []) as unknown as ChildTest[];
  return {
    children: {
      rw: rows.find((r) => r.section_order === 1) ?? null,
      math: rows.find((r) => r.section_order === 2) ?? null,
    },
    error: null,
  };
}

/**
 * Publish / reopen check, part 1: both sections present, each with two
 * modules. Returns every module id of both children (R&W M1/M2 easy/hard,
 * Math M1/M2 easy/hard) for moduleApprovalError.
 */
export function fullLengthPublishModules(children: Record<FlSectionKey, ChildTest | null>): {
  moduleIds: string[];
  error: string | null;
} {
  const ids: string[] = [];
  for (const s of FL_SECTIONS) {
    const c = children[s.key];
    if (!c) return { moduleIds: [], error: `This full-length test is missing its ${s.label} section` };
    const err = twoModuleError(c, `The ${s.label} section`);
    if (err) return { moduleIds: [], error: err };
    ids.push(...testModuleIds(c));
  }
  return { moduleIds: ids, error: null };
}

/**
 * Code-level guard: a test's kind is fixed. In particular a full-length
 * parent can never become a section test while its sections exist (they
 * would be orphaned and the shape check would fail mid-way).
 */
export function kindChangeError(currentKind: string, nextKind: unknown, hasChildren: boolean): string | null {
  if (nextKind === undefined || nextKind === currentKind) return null;
  if (hasChildren) return "This full-length test has sections, so its test type can't be changed.";
  return "A test's type can't be changed after it is created. Create a new test instead.";
}

/** Has anyone started this full-length test (rows on a child, or an attempt)? */
export async function fullLengthStarted(
  db: SupabaseClient,
  parentId: string,
  childIds: string[],
): Promise<{ started: boolean; error: string | null }> {
  const [subs, attempts] = await Promise.all([
    childIds.length > 0
      ? db.from("submissions").select("id").in("test_id", childIds).limit(1)
      : Promise.resolve({ data: [], error: null }),
    db.from("full_length_attempts").select("id").eq("test_id", parentId).limit(1),
  ]);
  if (subs.error || attempts.error) return { started: true, error: "Could not check for submissions" };
  return { started: (subs.data ?? []).length > 0 || (attempts.data ?? []).length > 0, error: null };
}

// ---------------------------------------------------------- accommodations
// Extended time is set per (test, student) on a full-length parent or on an
// ordinary section test (single module, two-module, adaptive). Never on a
// full-length child section: its parent's row covers it.

export const TIME_MULTIPLIERS = [1.25, 1.5, 2] as const;

export type AccommodationKind = "full_length" | "section";

/** Which kind of test takes extended time; null = none (child section / unknown kind). */
export function accommodationKind(
  test: { test_kind?: string | null; parent_test_id?: string | null } | null,
): AccommodationKind | null {
  if (!test || test.parent_test_id) return null;
  if (test.test_kind === "full_length") return "full_length";
  if (test.test_kind == null || test.test_kind === "section") return "section";
  return null;
}

/** A stored accommodation as a multiplier to stamp: 1 unless ×1.25 / ×1.5 / ×2. */
export function accommodationMultiplier(row: { time_multiplier?: unknown } | null): number {
  const m = row?.time_multiplier != null ? Number(row.time_multiplier) : 1;
  return (TIME_MULTIPLIERS as readonly number[]).includes(m) ? m : 1;
}

/**
 * The student's extended time on a section test, for stamping onto a new
 * attempt (submissions.metadata.time_multiplier). Throws on a lookup error:
 * never start an attempt without the student's extended time because of a blip.
 */
export async function loadTimeMultiplier(db: SupabaseClient, testId: string, studentId: string): Promise<number> {
  const { data, error } = await db
    .from("test_time_accommodations")
    .select("time_multiplier")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) throw new Error(`accommodation lookup: ${error.message}`);
  return accommodationMultiplier(data as { time_multiplier?: unknown } | null);
}

/** null clears the accommodation; otherwise one of ×1.25 / ×1.5 / ×2. */
export function multiplierError(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "number" || !(TIME_MULTIPLIERS as readonly number[]).includes(v)) {
    return "Extended time must be ×1.25, ×1.5 or ×2 (or none)";
  }
  return null;
}

export interface Accommodation {
  student_id: string;
  time_multiplier: number;
  updated_at: string | null;
}

export async function listAccommodations(
  db: SupabaseClient,
  testId: string,
): Promise<{ data: Accommodation[]; error: string | null }> {
  const { data, error } = await db
    .from("test_time_accommodations")
    .select("student_id, time_multiplier, updated_at")
    .eq("test_id", testId);
  if (error) return { data: [], error: "Could not load accommodations" };
  return {
    data: ((data ?? []) as { student_id: string; time_multiplier: number | string; updated_at: string | null }[]).map(
      (r) => ({ student_id: r.student_id, time_multiplier: Number(r.time_multiplier), updated_at: r.updated_at }),
    ),
    error: null,
  };
}

/**
 * Is the student on this full-length (or section) test: assigned
 * individually or through a class group, or has work on it (rows on a
 * section / on the section test itself, or an attempt)? Fails closed
 * (false) on a lookup error.
 */
export async function studentOnFullLengthTest(
  db: SupabaseClient,
  parentId: string,
  studentId: string,
): Promise<boolean> {
  const { data: assignment, error } = await db
    .from("test_assignments")
    .select("student_ids, class_group_ids")
    .eq("test_id", parentId)
    .maybeSingle();
  if (error) return false;
  const a = assignment as { student_ids: string[] | null; class_group_ids: string[] | null } | null;
  if ((a?.student_ids ?? []).includes(studentId)) return true;
  const groups = a?.class_group_ids ?? [];
  if (groups.length > 0) {
    const { data: member, error: memberErr } = await db
      .from("class_group_members")
      .select("student_id")
      .in("class_group_id", groups)
      .eq("student_id", studentId)
      .limit(1);
    if (memberErr) return false;
    if ((member ?? []).length > 0) return true;
  }
  const [{ data: kids, error: kidsErr }, { data: attempt, error: attemptErr }] = await Promise.all([
    db.from("tests").select("id").eq("parent_test_id", parentId),
    db.from("full_length_attempts").select("id").eq("test_id", parentId).eq("student_id", studentId).limit(1),
  ]);
  if (kidsErr || attemptErr) return false;
  if ((attempt ?? []).length > 0) return true;
  // A section test has no children: its own submissions are the work.
  const kidIds = ((kids ?? []) as { id: string }[]).map((k) => k.id);
  const { data: subs, error: subsErr } = await db
    .from("submissions")
    .select("id")
    .in("test_id", kidIds.length > 0 ? kidIds : [parentId])
    .eq("student_id", studentId)
    .limit(1);
  return !subsErr && (subs ?? []).length > 0;
}

/** Set (upsert) or clear one student's extended time on a test. */
export async function setAccommodation(
  db: SupabaseClient,
  testId: string,
  studentId: string,
  multiplier: number | null,
  updatedBy: string,
): Promise<string | null> {
  if (multiplier === null) {
    const { error } = await db
      .from("test_time_accommodations")
      .delete()
      .eq("test_id", testId)
      .eq("student_id", studentId);
    return error ? "Could not clear the accommodation" : null;
  }
  const { error } = await db.from("test_time_accommodations").upsert(
    {
      test_id: testId,
      student_id: studentId,
      time_multiplier: multiplier,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "test_id,student_id" },
  );
  return error ? "Could not save the accommodation" : null;
}
