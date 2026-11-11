// lib/module-page-access.ts
//
// Who may fetch a page of a module's source PDF
// (GET /api/modules/[id]/page/[n]):
//   - question reviewers (admins, review-flag teachers): any page;
//   - approved teachers: a page showing questions of a test they can open
//     (getTeacherTestAccess on the tests showing it, picked from ?test= or
//     getTeacherTestScope);
//   - approved students: a page showing questions of a module they were
//     served — while that attempt is in progress, or afterwards when the
//     answer-visibility rule lets them see the test's answers;
//   - nobody else.
// "Showing" means the page holds a question of that module (page_number,
// NULL read as page 1 like the callers do) that the test includes —
// Approved only, the set students are shown.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CurrentUser } from "@/lib/auth";
import { childrenOf, expandFullLength } from "@/lib/full-length";
import { getTeacherTestAccess, getTeacherTestScope } from "@/lib/teacher-access";
import { decideAnswerVisibility, loadAnswerVisibilityInputs, visibilityKey } from "@/lib/answer-visibility";
import { STUDENT_VISIBLE_QUESTION_STATUS } from "@/lib/student-exam";
import {
  PAGE_SCOPE_TEST_COLUMNS,
  studentPageGrant,
  testShowsModulePage,
  type PageScopeSubmission,
  type PageScopeTest,
} from "@/lib/module-page-scope";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadTests(db: SupabaseClient, ids: string[]): Promise<Map<string, PageScopeTest>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from("tests").select(PAGE_SCOPE_TEST_COLUMNS).in("id", ids);
  if (error) throw new Error(`module page: tests lookup failed: ${error.message}`);
  return new Map(((data ?? []) as unknown as PageScopeTest[]).map((t) => [t.id, t]));
}

/**
 * True when `user` may see page `page` of module `moduleId`. `testHint`
 * (?test= from the caller) only picks which test to check; it is verified
 * like any other. Throws on a lookup error (the route fails closed).
 */
export async function canViewModulePage(
  db: SupabaseClient,
  user: CurrentUser,
  moduleId: string,
  page: number,
  testHint: string | null,
): Promise<boolean> {
  if (user.canReviewQuestions) return true;
  if (user.accountStatus !== "approved") return false;
  if (user.role !== "teacher" && user.role !== "student") return false;

  // Questions of this module on this page.
  let q = db.from("questions").select("id, parsing_status").eq("module_id", moduleId);
  q = page === 1 ? q.or("page_number.eq.1,page_number.is.null") : q.eq("page_number", page);
  const { data: pageRows, error: qError } = await q;
  if (qError) throw new Error(`module page: questions lookup failed: ${qError.message}`);
  const rows = (pageRows ?? []) as { id: string; parsing_status: string }[];
  // Only the Approved set students are shown (and teachers review) counts.
  const pageIds = rows.filter((r) => r.parsing_status === STUDENT_VISIBLE_QUESTION_STATUS).map((r) => r.id);
  if (pageIds.length === 0) return false;

  if (user.role === "teacher") {
    // Candidate tests: ?test= (a full-length parent → its section children)
    // or the teacher's whole scope. Access is then checked on the tests that
    // actually show the page — a section child carries its own subject, so a
    // single-subject teacher never gets the other section's pages.
    let candidateIds: string[];
    if (testHint) {
      if (!UUID_RE.test(testHint)) return false;
      const kids = (await childrenOf(db, [testHint])).get(testHint);
      candidateIds = [testHint, kids?.rw, kids?.math].filter((x): x is string => Boolean(x));
    } else {
      candidateIds = await expandFullLength(db, (await getTeacherTestScope(db, user)).testIds);
    }
    const showing = [...(await loadTests(db, candidateIds)).values()].filter((t) =>
      testShowsModulePage(t, moduleId, pageIds),
    );
    for (const t of showing) {
      if ((await getTeacherTestAccess(db, user, t.id)).mode !== null) return true;
    }
    return false;
  }

  // Student: their own submissions decide.
  const { data: subRows, error: subError } = await db
    .from("submissions")
    .select("test_id, module_id, status, attempt_number")
    .eq("student_id", user.userId);
  if (subError) throw new Error(`module page: submissions lookup failed: ${subError.message}`);
  const subs = (subRows ?? []) as PageScopeSubmission[];
  if (subs.length === 0) return false;
  const tests = await loadTests(db, Array.from(new Set(subs.map((s) => s.test_id))));
  const grant = studentPageGrant(subs, tests, moduleId, pageIds);
  if (grant.live) return true;
  if (grant.reviewTestIds.length === 0) return false;

  // Finished: same rule as the result page and the class review walkthrough.
  const inputs = await loadAnswerVisibilityInputs(db, grant.reviewTestIds, [user.userId]);
  return grant.reviewTestIds.some((testId) => {
    const input = inputs.get(visibilityKey(testId, user.userId));
    return (
      !!input &&
      (decideAnswerVisibility(input, "results").answers ||
        decideAnswerVisibility(input, "class_review").answers)
    );
  });
}
