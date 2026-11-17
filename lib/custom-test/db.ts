// lib/custom-test/db.ts
//
// Database side of Custom tests (plan .omc/plans/custom-test.md, sections
// C, F, G): is migration 0035 in, create a test from validated rules and a
// validated selection, swap a Draft's questions, and the "family" (earlier
// versions) of a test. Kept free of next/server so unit tests can load it;
// the routes do auth, QA side and request validation.
//
// Shape:
//   R&W or Math   one section test (custom_rules) owning its stage modules:
//                 fixed = module_id (one module); adaptive = module_1_id +
//                 module_2_easy_id + module_2_hard_id.
//   R&W + Math    a full_length parent (custom_rules, break) with two
//                 fl_section children; each child owns its stage modules
//                 (fixed = module_id + module_2_id; adaptive as above).
// Every owner's question_ids = its stage lists (lib/custom-test/stage).

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildQuestionIds, isStageModuleId, newStageModuleId, parseStages } from "@/lib/custom-test/stage";
import { PART_LABEL, PART_SECTION, STAGE_LABEL, partStages, type CustomRules, type PartKey, type StageKey } from "@/lib/custom-test/rules";
import type { Selection, StagePick } from "@/lib/custom-test/select";

// ------------------------------------------------------------- schema

let readyCache: { ok: boolean; at: number } | null = null;

/**
 * Is migration 0035 applied (tests.custom_rules and modules.owner_test_id
 * exist)? Before it, every Custom test screen says "not enabled yet" and
 * nothing is written. A yes is remembered; a no is re-checked after 30 s.
 */
export async function customTestsReady(db: SupabaseClient): Promise<boolean> {
  if (readyCache && (readyCache.ok || Date.now() - readyCache.at < 30_000)) return readyCache.ok;
  const [t, m] = await Promise.all([
    db.from("tests").select("custom_rules").limit(1),
    db.from("modules").select("owner_test_id").limit(1),
  ]);
  const ok = !t.error && !m.error;
  if (!ok) console.warn("[custom-test] schema not ready:", t.error?.message ?? m.error?.message);
  readyCache = { ok, at: Date.now() };
  return ok;
}

export const NOT_ENABLED_MESSAGE =
  "Custom tests aren't enabled yet: the database update (migration 0035) hasn't been applied.";

// ------------------------------------------------------------- create

export interface CreateSettings {
  testName: string;
  createdBy: string;
  openDate?: string | null;
  dueDate?: string | null;
  showAnswersAfterSubmission?: boolean;
  showExplanationsAfterSubmission?: boolean;
  allowRetake?: boolean;
}

const STAGE_DIFFICULTY: Record<StageKey, string> = { m1: "Mixed", m2: "Mixed", m2_easy: "Easy", m2_hard: "Hard" };

/** The test columns that point at a part's stage modules. */
export function moduleColumns(adaptive: boolean, ids: Partial<Record<StageKey, string>>): Record<string, string | null> {
  return adaptive
    ? { module_id: null, module_2_id: null, module_1_id: ids.m1 ?? null, module_2_easy_id: ids.m2_easy ?? null, module_2_hard_id: ids.m2_hard ?? null }
    : { module_id: ids.m1 ?? null, module_2_id: ids.m2 ?? null, module_1_id: null, module_2_easy_id: null, module_2_hard_id: null };
}

/** Pure: the stage module rows of one part. */
export function stageModuleRows(
  testName: string,
  key: PartKey,
  stages: StagePick[],
  ownerTestId: string,
  createdBy: string,
  subject: CustomRules["subject"],
): { id: string; row: Record<string, unknown> }[] {
  return stages.map((s) => {
    const id = newStageModuleId();
    const label = stages.length === 1 ? "" : ` · ${STAGE_LABEL[s.key]}`;
    return {
      id,
      row: {
        id,
        module_name: `${testName.trim()}${subject === "both" ? ` · ${PART_LABEL[key]}` : ""}${label}`,
        section: PART_SECTION[key],
        module_number: s.key === "m1" ? 1 : 2,
        difficulty: STAGE_DIFFICULTY[s.key],
        source_name: "Custom test",
        pdf_url: "",
        total_questions: s.questionIds.length,
        parsing_status: "approved",
        uploaded_by: createdBy,
        owner_test_id: ownerTestId,
      },
    };
  });
}

/** Pure: the columns of the test that owns a part's modules. */
export function partTestColumns(rules: CustomRules, key: PartKey, stageIds: Partial<Record<StageKey, string>>, stages: StagePick[]) {
  const part = rules.parts[key]!;
  const two = stages.length > 1;
  return {
    is_adaptive: part.adaptive,
    adaptive_threshold: part.threshold,
    ...moduleColumns(part.adaptive, stageIds),
    question_ids: buildQuestionIds(stages.map((s) => ({ moduleId: stageIds[s.key]!, questionIds: s.questionIds }))),
    time_limit_minutes: part.minutes.m1,
    time_limit_minutes_module_2: two ? part.minutes.m2 ?? part.minutes.m1 : null,
    is_untimed: false,
    desmos_enabled: key === "math",
  };
}

async function insertStages(
  db: SupabaseClient,
  rules: CustomRules,
  key: PartKey,
  stages: StagePick[],
  owner: string,
  s: CreateSettings,
): Promise<Partial<Record<StageKey, string>>> {
  const rows = stageModuleRows(s.testName, key, stages, owner, s.createdBy, rules.subject);
  const { error } = await db.from("modules").insert(rows.map((r) => r.row));
  if (error) throw new Error(`stage modules: ${error.message}`);
  return Object.fromEntries(stages.map((st, i) => [st.key, rows[i].id]));
}

/**
 * Create a Custom test as a Draft with an empty assignment. Any failure
 * deletes the test row (children and stage modules cascade), so no half-
 * built test is left. Returns the assignable test's id.
 */
export async function createCustomTest(
  db: SupabaseClient,
  rules: CustomRules,
  selection: Selection,
  s: CreateSettings,
): Promise<{ id: string | null; error: string | null }> {
  const name = s.testName.trim();
  const shared = {
    open_date: s.openDate ?? null,
    due_date: s.dueDate ?? null,
    show_answers_after_submission: s.showAnswersAfterSubmission ?? false,
    show_explanations_after_submission: s.showExplanationsAfterSubmission ?? true,
    allow_retake: s.allowRetake ?? false,
    status: "Draft",
    created_by: s.createdBy,
  };
  let rootId: string | null = null;
  const undo = async (why: unknown) => {
    console.error("[custom-test/create]", why);
    if (rootId) {
      const { error } = await db.from("tests").delete().eq("id", rootId);
      if (error) console.error("[custom-test/create] rollback failed", rootId, error.message);
    }
    return { id: null, error: "Failed to create the Custom test" };
  };
  try {
    if (rules.subject !== "both") {
      const key = rules.subject;
      const { data: t, error } = await db
        .from("tests")
        .insert({ test_name: name, test_kind: "section", custom_rules: rules, is_untimed: false, ...shared })
        .select("id")
        .single();
      if (error || !t) return undo(error);
      rootId = (t as { id: string }).id;
      const stages = selection.parts[key]!;
      const ids = await insertStages(db, rules, key, stages, rootId, s);
      const { error: upErr } = await db.from("tests").update(partTestColumns(rules, key, ids, stages)).eq("id", rootId);
      if (upErr) return undo(upErr);
    } else {
      const brk = rules.break && rules.break.minutes > 0 ? rules.break : null;
      const { data: p, error } = await db
        .from("tests")
        .insert({
          test_name: name,
          test_kind: "full_length",
          custom_rules: rules,
          is_adaptive: false,
          break_minutes: brk?.minutes ?? 0,
          allow_section_pause: brk?.allowPause ?? false,
          is_untimed: false,
          question_ids: null,
          ...shared,
        })
        .select("id")
        .single();
      if (error || !p) return undo(error);
      rootId = (p as { id: string }).id;
      for (const [order, key] of [[1, "rw"], [2, "math"]] as const) {
        const { data: c, error: cErr } = await db
          .from("tests")
          .insert({
            test_name: `${name} — ${PART_LABEL[key]}`,
            test_kind: "fl_section",
            parent_test_id: rootId,
            section_order: order,
            is_untimed: false,
            ...shared,
          })
          .select("id")
          .single();
        if (cErr || !c) return undo(cErr);
        const childId = (c as { id: string }).id;
        const stages = selection.parts[key]!;
        const ids = await insertStages(db, rules, key, stages, childId, s);
        const { error: upErr } = await db.from("tests").update(partTestColumns(rules, key, ids, stages)).eq("id", childId);
        if (upErr) return undo(upErr);
      }
    }
    const { error: asgErr } = await db.from("test_assignments").insert({
      test_id: rootId,
      teacher_ids: [],
      student_ids: [],
      class_group_ids: [],
      created_by: s.createdBy,
    });
    // Same as other tests: the test exists; the assignment can be fixed later.
    if (asgErr) console.error("[custom-test/create] assignment", asgErr.message);
    return { id: rootId, error: null };
  } catch (e) {
    return undo(e);
  }
}

// ------------------------------------------------------------- load

export interface CustomTestRow {
  id: string;
  test_name: string;
  status: string;
  test_kind: string | null;
  custom_rules: CustomRules | null;
}

export interface OwnerRow {
  id: string;
  section_order: number | null;
  is_adaptive: boolean | null;
  module_id: string | null;
  module_2_id: string | null;
  module_1_id: string | null;
  module_2_easy_id: string | null;
  module_2_hard_id: string | null;
  question_ids: string[] | null;
}

const OWNER_COLUMNS = "id, section_order, is_adaptive, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, question_ids";

/** The selection stored on a Custom test's owner rows (stage order per part). */
export function selectionFromOwners(rules: CustomRules, owners: Record<PartKey, OwnerRow | undefined>): Selection {
  const parts: Selection["parts"] = {};
  for (const key of rules.order.filter((k) => rules.parts[k])) {
    const o = owners[key];
    if (!o) continue;
    const stages = parseStages(o.question_ids) ?? new Map<string, string[]>();
    const slot: Record<StageKey, string | null> = {
      m1: (o.is_adaptive ? o.module_1_id : o.module_id) ?? null,
      m2: o.module_2_id,
      m2_easy: o.module_2_easy_id,
      m2_hard: o.module_2_hard_id,
    };
    parts[key] = partStages(rules.subject, rules.parts[key]!).map((s) => ({
      key: s.key,
      questionIds: stages.get(slot[s.key] ?? "") ?? [],
    }));
  }
  return { parts, shortfalls: rules.shortfalls ?? [] };
}

/**
 * A Custom test with its owner rows (itself, or its two sections), or null
 * when `id` isn't a Custom test. Throws on a lookup error.
 */
export async function loadCustomTest(
  db: SupabaseClient,
  id: string,
): Promise<{ test: CustomTestRow; owners: Record<PartKey, OwnerRow | undefined> } | null> {
  const { data: t, error } = await db.from("tests").select("id, test_name, status, test_kind, custom_rules").eq("id", id).maybeSingle();
  if (error) throw new Error(`custom test lookup: ${error.message}`);
  const test = t as CustomTestRow | null;
  if (!test?.custom_rules) return null;
  const rules = test.custom_rules;
  if (rules.subject === "both") {
    const { data: kids, error: kErr } = await db.from("tests").select(OWNER_COLUMNS).eq("parent_test_id", id);
    if (kErr) throw new Error(`custom test sections lookup: ${kErr.message}`);
    const rows = (kids ?? []) as unknown as OwnerRow[];
    return { test, owners: { rw: rows.find((r) => r.section_order === 1), math: rows.find((r) => r.section_order === 2) } };
  }
  const { data: own, error: oErr } = await db.from("tests").select(OWNER_COLUMNS).eq("id", id).maybeSingle();
  if (oErr) throw new Error(`custom test lookup: ${oErr.message}`);
  const owners = { rw: undefined, math: undefined } as Record<PartKey, OwnerRow | undefined>;
  owners[rules.subject] = (own as unknown as OwnerRow | null) ?? undefined;
  return { test, owners };
}

/** Has anyone started this Custom test (a submission on an owner, or a full-length attempt)? */
export async function customTestStarted(db: SupabaseClient, testId: string, ownerIds: string[]): Promise<boolean> {
  const [subs, attempts] = await Promise.all([
    db.from("submissions").select("id").in("test_id", ownerIds.length ? ownerIds : [testId]).limit(1),
    db.from("full_length_attempts").select("id").eq("test_id", testId).limit(1),
  ]);
  if (subs.error || attempts.error) throw new Error("Could not check for submissions");
  return (subs.data ?? []).length > 0 || (attempts.data ?? []).length > 0;
}

/**
 * Replace a Draft Custom test's questions (same rules shape: the same
 * modules, new lists). Refused once anyone started it. Module sizes are
 * written to the stage modules' total_questions.
 */
export async function replaceCustomQuestions(
  db: SupabaseClient,
  testId: string,
  rules: CustomRules,
  selection: Selection,
): Promise<{ error: string | null; status: number }> {
  const loaded = await loadCustomTest(db, testId);
  if (!loaded) return { error: "Not a Custom test", status: 404 };
  if (loaded.test.status !== "Draft") return { error: "Only a Draft Custom test's questions can be changed. Move it back to Draft first.", status: 409 };
  const ownerIds = Object.values(loaded.owners).flatMap((o) => (o ? [o.id] : []));
  if (await customTestStarted(db, testId, ownerIds)) {
    return { error: "Students have already started this test, so its questions are locked. Make another version instead.", status: 409 };
  }
  const saved = loaded.test.custom_rules!;
  for (const key of saved.order.filter((k) => saved.parts[k])) {
    const o = loaded.owners[key];
    const a = saved.parts[key]!;
    const b = rules.parts[key];
    if (!o || !b || a.adaptive !== b.adaptive || partStages(saved.subject, a).length !== partStages(rules.subject, b).length) {
      return { error: "The test's shape changed — make a new test instead.", status: 409 };
    }
  }
  if (rules.subject !== saved.subject) return { error: "The subject can't change — make a new test instead.", status: 409 };
  for (const key of rules.order.filter((k) => rules.parts[k])) {
    const o = loaded.owners[key]!;
    const stages = selection.parts[key]!;
    const old = selectionFromOwners(saved, loaded.owners).parts[key]!;
    const slot: Record<StageKey, string | null> = {
      m1: (o.is_adaptive ? o.module_1_id : o.module_id) ?? null,
      m2: o.module_2_id,
      m2_easy: o.module_2_easy_id,
      m2_hard: o.module_2_hard_id,
    };
    const ids: Partial<Record<StageKey, string>> = {};
    for (const s of old) {
      const id = slot[s.key];
      if (!id || !isStageModuleId(id)) return { error: "This test's modules are missing — make a new test instead.", status: 409 };
      ids[s.key] = id;
    }
    const part = rules.parts[key]!;
    const { error } = await db
      .from("tests")
      .update({
        question_ids: buildQuestionIds(stages.map((s) => ({ moduleId: ids[s.key]!, questionIds: s.questionIds }))),
        adaptive_threshold: part.threshold,
        time_limit_minutes: part.minutes.m1,
        time_limit_minutes_module_2: stages.length > 1 ? part.minutes.m2 ?? part.minutes.m1 : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", o.id)
      .eq("status", "Draft");
    if (error) return { error: "Failed to save the questions", status: 500 };
    for (const s of stages) {
      await db.from("modules").update({ total_questions: s.questionIds.length }).eq("id", ids[s.key]!);
    }
  }
  const { error } = await db
    .from("tests")
    .update({ custom_rules: rules, ...(rules.subject === "both" && rules.break !== undefined ? { break_minutes: rules.break && rules.break.minutes > 0 ? rules.break.minutes : 0, allow_section_pause: Boolean(rules.break && rules.break.minutes > 0 && rules.break.allowPause) } : {}), updated_at: new Date().toISOString() })
    .eq("id", testId);
  if (error) return { error: "Failed to save the rules", status: 500 };
  return { error: null, status: 200 };
}

/**
 * Every question id used by tests of this family (earlier versions), for
 * "Make another version". Throws on a lookup error.
 */
export async function familyQuestionIds(db: SupabaseClient, familyId: string): Promise<{ ids: Set<string>; versions: number }> {
  const { data, error } = await db.from("tests").select("id, test_kind, question_ids, custom_rules").eq("custom_rules->>family_id", familyId);
  if (error) throw new Error(`family lookup: ${error.message}`);
  const roots = (data ?? []) as { id: string; test_kind: string | null; question_ids: unknown; custom_rules: CustomRules | null }[];
  const ids = new Set<string>();
  let versions = 0;
  for (const r of roots) versions = Math.max(versions, r.custom_rules?.version ?? 1);
  for (const r of roots) for (const [, list] of parseStages(r.question_ids) ?? []) for (const q of list) ids.add(q);
  const parents = roots.filter((r) => r.test_kind === "full_length").map((r) => r.id);
  if (parents.length > 0) {
    const { data: kids, error: kErr } = await db.from("tests").select("question_ids").in("parent_test_id", parents);
    if (kErr) throw new Error(`family sections lookup: ${kErr.message}`);
    for (const k of kids ?? []) for (const [, list] of parseStages(k.question_ids) ?? []) for (const q of list) ids.add(q);
  }
  return { ids, versions };
}
