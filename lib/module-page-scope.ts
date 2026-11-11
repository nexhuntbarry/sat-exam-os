// lib/module-page-scope.ts
//
// Pure rules behind GET /api/modules/[id]/page/[n] (a single page of a
// module's source PDF). Which tests show a given PDF page, and whether a
// student's submissions entitle them to it. DB access lives in
// lib/module-page-access.ts.

import { questionIdsSpanModules } from "@/lib/student-exam";

export interface PageScopeTest {
  id: string;
  is_adaptive?: boolean | null;
  module_id?: string | null;
  module_2_id?: string | null;
  module_1_id?: string | null;
  module_2_easy_id?: string | null;
  module_2_hard_id?: string | null;
  question_ids?: string[] | null;
}

export const PAGE_SCOPE_TEST_COLUMNS =
  "id, is_adaptive, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, question_ids";

/** Every module a test serves (adaptive: Module 1 + both Module 2 tracks). */
export function testModuleIds(t: PageScopeTest): string[] {
  const ids = t.is_adaptive
    ? [t.module_1_id, t.module_2_easy_id, t.module_2_hard_id]
    : [t.module_id, t.module_2_id];
  return ids.filter((x): x is string => Boolean(x));
}

/**
 * Does the test show any of `pageQuestionIds` (questions of `moduleId` on
 * the requested page)? `served` narrows the test's modules to the ones a
 * student actually got (their submission's module). A non-adaptive test's
 * question_ids list restricts the set; when it is the whole set
 * (questionIdsSpanModules, a quiz picked from several source tests) the
 * questions may come from any module.
 */
export function testShowsModulePage(
  t: PageScopeTest,
  moduleId: string,
  pageQuestionIds: readonly string[],
  served: readonly string[] = testModuleIds(t),
): boolean {
  if (pageQuestionIds.length === 0) return false;
  const list =
    !t.is_adaptive && Array.isArray(t.question_ids) && t.question_ids.length > 0
      ? t.question_ids
      : null;
  if (list && !pageQuestionIds.some((id) => list.includes(id))) return false;
  if (served.includes(moduleId)) return true;
  return list !== null && questionIdsSpanModules(t, served);
}

export interface PageScopeSubmission {
  test_id: string;
  module_id: string | null;
  status: string;
  attempt_number: number | null;
}

export interface StudentPageGrant {
  /** Taking it now: the page is on the module in progress, or an earlier module of the same attempt. */
  live: boolean;
  /** Finished tests showing the page: allowed only if answer visibility lets the student see them. */
  reviewTestIds: string[];
}

/**
 * Which of the student's own submissions cover the page. Only the module
 * each submission served counts (an adaptive student gets the Module 2
 * track they were routed to, never the other one); a full-length section
 * is its child test's submission.
 */
export function studentPageGrant(
  subs: readonly PageScopeSubmission[],
  tests: ReadonlyMap<string, PageScopeTest>,
  moduleId: string,
  pageQuestionIds: readonly string[],
): StudentPageGrant {
  const openAttempts = new Set(
    subs.filter((s) => s.status === "In Progress").map((s) => `${s.test_id}:${s.attempt_number ?? 1}`),
  );
  const review = new Set<string>();
  let live = false;
  for (const s of subs) {
    const t = tests.get(s.test_id);
    if (!t || !s.module_id) continue;
    if (!testShowsModulePage(t, moduleId, pageQuestionIds, [s.module_id])) continue;
    if (openAttempts.has(`${s.test_id}:${s.attempt_number ?? 1}`)) live = true;
    else review.add(s.test_id);
  }
  return { live, reviewTestIds: live ? [] : Array.from(review) };
}
