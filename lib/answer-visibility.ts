// Single source of truth for "may this student see correct answers /
// explanations for this test?". Every student-facing surface that returns
// answer keys or explanations (result page, result API, class-review page)
// must go through decideAnswerVisibility via loadAnswerVisibilityInputs —
// never read show_answers_after_submission / review_unlocked directly.
//
// Priority (highest first):
//   1. Retake pending or in progress → hidden. Restores automatically once
//      the retake is submitted (the stored override is left untouched).
//      Class review is also closed while any module is still being taken
//      (first attempt included): it shows every module's answer key.
//   2. Per-student override "hide" → hidden everywhere, class review too.
//   3. Per-student override "show" → visible once the student has
//      submitted; explanations per the override's own checkbox.
//   4. Follow: results page uses the test's show-answers/explanations
//      flags (submitted students only); class review uses review_unlocked.
import type { SupabaseClient } from "@supabase/supabase-js";
import { studentTestProgress } from "@/lib/test-progress";
import { fullLengthLinks, expandWithChildren, fullLengthVisibilityState } from "@/lib/full-length";

export type StudentAnswerMode = "follow" | "show" | "hide";
export const STUDENT_ANSWER_MODES: readonly StudentAnswerMode[] = ["follow", "show", "hide"];

/** results = the student's own result page / API; class_review = /review walkthrough. */
export type VisibilityContext = "results" | "class_review";

export type VisibilitySource =
  | "test"
  | "class_review"
  | "student"
  | "not_submitted"
  | "retake_pending"
  | "exam_in_progress";

export interface TestVisibilityFlags {
  show_answers_after_submission: boolean | null;
  show_explanations_after_submission: boolean | null;
  review_unlocked: boolean | null;
}

export interface StudentOverride {
  mode: StudentAnswerMode;
  show_explanations: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

export interface VisibilityInput {
  test: TestVisibilityFlags;
  override: StudentOverride | null;
  /** At least one Submitted/Late submission on this test. */
  hasSubmitted: boolean;
  /** Unconsumed retake grant, or a later attempt still in progress. */
  retakePending: boolean;
  /** Taking it right now: a module still open, or Module 1 in and Module 2 not started yet. */
  examInProgress?: boolean;
}

export interface VisibilityDecision {
  answers: boolean;
  explanations: boolean;
  source: VisibilitySource;
}

const HIDDEN = (source: VisibilitySource): VisibilityDecision => ({
  answers: false,
  explanations: false,
  source,
});

export function decideAnswerVisibility(
  input: VisibilityInput,
  context: VisibilityContext,
): VisibilityDecision {
  if (input.retakePending) return HIDDEN("retake_pending");
  if (context === "class_review" && input.examInProgress) return HIDDEN("exam_in_progress");

  const mode = input.override?.mode ?? "follow";
  if (mode === "hide") return HIDDEN("student");
  if (mode === "show") {
    if (!input.hasSubmitted) return HIDDEN("not_submitted");
    return {
      answers: true,
      explanations: input.override?.show_explanations !== false,
      source: "student",
    };
  }

  if (context === "class_review") {
    // Class walkthrough: open to every assigned student while unlocked,
    // taken or not (existing behaviour), explanations included.
    const open = input.test.review_unlocked === true;
    return { answers: open, explanations: open, source: "class_review" };
  }

  if (!input.hasSubmitted) return HIDDEN("not_submitted");
  const answers = input.test.show_answers_after_submission === true;
  return {
    answers,
    explanations: answers && input.test.show_explanations_after_submission !== false,
    source: "test",
  };
}

/**
 * Admin-facing one-line summary: is the student able to see answers
 * anywhere right now, and why. Results page wins over class review when
 * both are open.
 */
export function summarizeAnswerVisibility(input: VisibilityInput): VisibilityDecision {
  const results = decideAnswerVisibility(input, "results");
  const review = decideAnswerVisibility(input, "class_review");
  if (results.answers) {
    return { ...results, explanations: results.explanations || review.explanations };
  }
  if (review.answers) return review;
  return results;
}

const DONE = new Set(["Submitted", "Late"]);

export const visibilityKey = (testId: string, studentId: string) => `${testId}:${studentId}`;

// The override table ships in migration 0029. Until it is applied there
// can be no overrides, so "table missing" means follow; any other error
// is thrown so callers fail closed instead of guessing.
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "PGRST205") return true;
  const msg = err.message ?? "";
  return /student_answer_visibility/.test(msg) && /does not exist|schema cache/.test(msg);
}

/**
 * Load decision inputs for every (testId × studentId) pair. Pass the test
 * flags when the caller already has them to save a query. Throws on any
 * DB error (fail closed).
 *
 * Full-length SAT: a section child resolves to its parent first — flags,
 * retake grants and overrides are the parent's, submissions are read on
 * both children, and "submitted" means the whole attempt is done (Math
 * Module 2 graded), so R&W answers never show while Math is still to come.
 * Results are keyed by the id the caller passed.
 */
export async function loadAnswerVisibilityInputs(
  db: SupabaseClient,
  testIds: string[],
  studentIds: string[],
  knownTests?: Map<string, TestVisibilityFlags>,
): Promise<Map<string, VisibilityInput>> {
  const out = new Map<string, VisibilityInput>();
  const requestedIds = Array.from(new Set(testIds.filter(Boolean)));
  const sIds = Array.from(new Set(studentIds.filter(Boolean)));
  if (requestedIds.length === 0 || sIds.length === 0) return out;

  const links = await fullLengthLinks(db);
  const effectiveId = (id: string) => links.parentOf.get(id) ?? id;
  const tIds = Array.from(new Set(requestedIds.map(effectiveId)));
  const flParents = tIds.filter((id) => links.childrenOf.has(id));
  const submissionTestIds = expandWithChildren(tIds, links);

  const missingTests = tIds.filter((id) => !knownTests?.has(id));
  const [testsRes, subsRes, grantsRes, overridesRes, shapeRes, closedRes] = await Promise.all([
    missingTests.length > 0
      ? db
          .from("tests")
          .select("id, show_answers_after_submission, show_explanations_after_submission, review_unlocked")
          .in("id", missingTests)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("submissions")
      .select("test_id, student_id, status, attempt_number, session_id, adaptive_track, started_at")
      .in("test_id", submissionTestIds)
      .in("student_id", sIds),
    db
      .from("test_retake_grants")
      .select("test_id, student_id")
      .in("test_id", tIds)
      .in("student_id", sIds)
      .is("consumed_at", null),
    db
      .from("student_answer_visibility")
      .select("test_id, student_id, mode, show_explanations, updated_by, updated_at")
      .in("test_id", tIds)
      .in("student_id", sIds),
    // Module structure, to tell "Module 1 in, Module 2 not started" apart from finished.
    db.from("tests").select("id, module_2_id, is_adaptive").in("id", tIds),
    // Full-length attempts that can no longer continue count as finished.
    flParents.length > 0
      ? db
          .from("full_length_attempts")
          .select("test_id, student_id, attempt_number")
          .in("test_id", flParents)
          .in("student_id", sIds)
          .not("closed_at", "is", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (testsRes.error) throw new Error(`answer visibility: tests lookup failed: ${testsRes.error.message}`);
  if (subsRes.error) throw new Error(`answer visibility: submissions lookup failed: ${subsRes.error.message}`);
  if (grantsRes.error) throw new Error(`answer visibility: retake grants lookup failed: ${grantsRes.error.message}`);
  if (shapeRes.error) throw new Error(`answer visibility: test modules lookup failed: ${shapeRes.error.message}`);
  if (closedRes.error) throw new Error(`answer visibility: full-length attempts lookup failed: ${closedRes.error.message}`);
  const closedAttempts = new Map<string, Set<number>>();
  for (const a of (closedRes.data ?? []) as { test_id: string; student_id: string; attempt_number: number }[]) {
    const k = visibilityKey(a.test_id, a.student_id);
    closedAttempts.set(k, new Set([...(closedAttempts.get(k) ?? []), a.attempt_number]));
  }
  const twoModules = new Map(
    ((shapeRes.data ?? []) as { id: string; module_2_id: string | null; is_adaptive: boolean | null }[]).map((t) => [
      t.id,
      Boolean(t.module_2_id) || t.is_adaptive === true,
    ]),
  );
  if (overridesRes.error && !isMissingTable(overridesRes.error)) {
    throw new Error(`answer visibility: overrides lookup failed: ${overridesRes.error.message}`);
  }

  const tests = new Map<string, TestVisibilityFlags>(knownTests ?? []);
  for (const t of (testsRes.data ?? []) as (TestVisibilityFlags & { id: string })[]) {
    tests.set(t.id, t);
  }

  type Sub = {
    test_id: string;
    student_id: string;
    status: string;
    attempt_number: number | null;
    session_id: string | null;
    adaptive_track: string | null;
    started_at: string | null;
  };
  const subsByPair = new Map<string, Sub[]>();
  for (const s of (subsRes.data ?? []) as Sub[]) {
    const k = visibilityKey(effectiveId(s.test_id), s.student_id);
    const list = subsByPair.get(k) ?? [];
    list.push(s);
    subsByPair.set(k, list);
  }
  const grants = new Set(
    ((grantsRes.data ?? []) as { test_id: string; student_id: string }[]).map((g) =>
      visibilityKey(g.test_id, g.student_id),
    ),
  );
  const overrides = new Map<string, StudentOverride>();
  if (!overridesRes.error) {
    for (const o of (overridesRes.data ?? []) as (StudentOverride & { test_id: string; student_id: string })[]) {
      overrides.set(visibilityKey(o.test_id, o.student_id), {
        mode: STUDENT_ANSWER_MODES.includes(o.mode) ? o.mode : "hide",
        show_explanations: o.show_explanations,
        updated_by: o.updated_by,
        updated_at: o.updated_at,
      });
    }
  }

  const byEffective = new Map<string, VisibilityInput>();
  for (const testId of tIds) {
    const test = tests.get(testId);
    if (!test) continue; // unknown test → no entry → callers treat as hidden
    const flChildren = links.childrenOf.get(testId);
    for (const studentId of sIds) {
      const k = visibilityKey(testId, studentId);
      const subs = subsByPair.get(k) ?? [];
      if (flChildren) {
        const fl = fullLengthVisibilityState(subs, flChildren, closedAttempts.get(k));
        byEffective.set(k, {
          test,
          override: overrides.get(k) ?? null,
          hasSubmitted: fl.hasSubmitted,
          retakePending: grants.has(k) || fl.retakeInProgress,
          examInProgress: fl.examInProgress,
        });
        continue;
      }
      const submitted = subs.filter((s) => DONE.has(s.status));
      const minSubmittedAttempt = submitted.reduce(
        (m, s) => Math.min(m, s.attempt_number ?? 1),
        Number.POSITIVE_INFINITY,
      );
      // A newer attempt that isn't finished yet = retake in progress. The
      // first attempt's own unfinished Module 2 doesn't count (same
      // attempt_number as its submitted Module 1).
      const retakeInProgress = subs.some(
        (s) => !DONE.has(s.status) && (s.attempt_number ?? 1) > minSubmittedAttempt,
      );
      byEffective.set(k, {
        test,
        override: overrides.get(k) ?? null,
        hasSubmitted: submitted.length > 0,
        retakePending: grants.has(k) || retakeInProgress,
        examInProgress:
          subs.some((s) => !DONE.has(s.status)) ||
          (subs.length > 0 && studentTestProgress(subs, twoModules.get(testId) ?? false).status === "In progress"),
      });
    }
  }
  for (const testId of requestedIds) {
    for (const studentId of sIds) {
      const input = byEffective.get(visibilityKey(effectiveId(testId), studentId));
      if (input) out.set(visibilityKey(testId, studentId), input);
    }
  }
  return out;
}

/** Decision for one student on one test; hidden when the test doesn't exist. */
export async function getAnswerVisibility(
  db: SupabaseClient,
  testId: string,
  studentId: string,
  context: VisibilityContext,
): Promise<VisibilityDecision> {
  const inputs = await loadAnswerVisibilityInputs(db, [testId], [studentId]);
  const input = inputs.get(visibilityKey(testId, studentId));
  if (!input) return HIDDEN("test");
  return decideAnswerVisibility(input, context);
}
