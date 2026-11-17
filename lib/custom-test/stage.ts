// lib/custom-test/stage.ts
//
// Custom test modules ("stages", plan .omc/plans/custom-test.md). A Custom
// test picks bank questions from many uploaded modules into its own Module 1
// / Module 2 (easier, harder). Each of its modules is a placeholder `modules`
// row that owns no questions; the questions are referenced, never copied, so
// a key fix in the bank reaches the test (and its regrade) automatically.
//
// Where the per-module lists live: tests.question_ids, the column every
// exam path already reads. A Custom test's list is its stage modules in
// order, each stage module id followed by that module's questions:
//
//   [<M1 stage id>, q1, q2, …, <M2 easy stage id>, q9, …, <M2 hard stage id>, …]
//
// Stage module ids carry a reserved prefix (STAGE_ID_PREFIX), so they can be
// told apart from question ids without a database lookup, and every reader
// (scope, order, grading, the PDF page viewer) works from the test row it
// already loads. No new column is read on any exam path, so the code is
// safe before migration 0035 is applied (no Custom test can exist then).
// Ids are valid UUIDs: anything that passes question_ids to `.in("id", …)`
// or `includes(id)` (live-question guard, teacher QA, reports) keeps
// working; a stage id simply never matches a question.

/** Every stage module id starts with this (a valid UUID prefix). */
export const STAGE_ID_PREFIX = "c0570000-5ca6-4";

const HEX = "0123456789abcdef";
function hex(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => HEX[b & 15]).join("");
}

/** A new stage module id: c0570000-5ca6-4xxx-8xxx-xxxxxxxxxxxx. */
export function newStageModuleId(): string {
  return `${STAGE_ID_PREFIX}${hex(3)}-8${hex(3)}-${hex(12)}`;
}

export function isStageModuleId(id: unknown): id is string {
  return typeof id === "string" && id.toLowerCase().startsWith(STAGE_ID_PREFIX);
}

/**
 * The stage lists of a Custom test's question_ids (stage id → question ids,
 * in order), or null when the list isn't a Custom test's (it must start
 * with a stage id). Every other test is null, so its behaviour is unchanged.
 */
export function parseStages(questionIds: unknown): Map<string, string[]> | null {
  if (!Array.isArray(questionIds) || questionIds.length === 0 || !isStageModuleId(questionIds[0])) return null;
  const out = new Map<string, string[]>();
  let cur: string[] = [];
  for (const raw of questionIds) {
    if (typeof raw !== "string") continue;
    if (isStageModuleId(raw)) {
      cur = out.get(raw) ?? [];
      out.set(raw, cur);
    } else cur.push(raw);
  }
  return out;
}

/** question_ids for a Custom test from its stages (in order). */
export function buildQuestionIds(stages: { moduleId: string; questionIds: readonly string[] }[]): string[] {
  const out: string[] = [];
  for (const s of stages) {
    if (!isStageModuleId(s.moduleId)) throw new Error(`not a stage module id: ${s.moduleId}`);
    out.push(s.moduleId, ...s.questionIds);
  }
  return out;
}

/** Every question id of a Custom test, stage order (markers dropped). */
export function stagedQuestionIds(questionIds: unknown): string[] | null {
  const stages = parseStages(questionIds);
  return stages ? [...stages.values()].flat() : null;
}

/**
 * The question ids of these served modules when any of them is a stage of
 * this test, else null (not a Custom test, or modules that aren't its
 * stages: the caller keeps its usual rules).
 */
export function stageQuestionIdsFor(questionIds: unknown, moduleIds: readonly string[]): string[] | null {
  const stages = parseStages(questionIds);
  if (!stages || !moduleIds.some((m) => stages.has(m))) return null;
  return moduleIds.flatMap((m) => stages.get(m) ?? []);
}

/** question id → its stage module id. */
export function stageOfQuestion(questionIds: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const [stage, ids] of parseStages(questionIds) ?? []) for (const id of ids) out.set(id, stage);
  return out;
}

/** Is any of these module ids a stage module (a Custom test's)? */
export function servesStageModules(ids: readonly (string | null | undefined)[]): boolean {
  return ids.some((id) => isStageModuleId(id));
}

// Stage ids sort together (uuid order is byte order = hex order), so a
// module list can leave them out in SQL with one range filter.
const STAGE_ID_MIN = `${STAGE_ID_PREFIX}000-0000-000000000000`;
const STAGE_ID_MAX = `${STAGE_ID_PREFIX}fff-ffff-ffffffffffff`;

interface OrLike {
  or(filters: string): OrLike;
}

/**
 * Leave a Custom test's stage modules out of a `modules` list (admin module
 * list, the module pickers, counts): they own no questions and no PDF.
 */
export function hideStageModules<Q>(query: Q, column = "id"): Q {
  return (query as unknown as OrLike).or(`${column}.lt.${STAGE_ID_MIN},${column}.gt.${STAGE_ID_MAX}`) as unknown as Q;
}
