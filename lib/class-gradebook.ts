// lib/class-gradebook.ts
//
// Server reads behind the class gradebook ("Scores" on the admin and
// teacher class pages, and its printout). A fixed number of batched
// queries whatever the class size: members, the class's assignments,
// sections, every member's rows on those tests (paged), full-length
// attempt rows. Scoring is lib/class-gradebook-shape (pure).
//
// Full-length SATs: assignments name the parent only; the parent is one
// column and its rows are read from its two hidden children
// (expandWithChildren). A stray child id in an assignment is dropped.
// QA isolation follows the class page: only tests (and students) on the
// viewer's side.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { expandWithChildren, fullLengthLinksOrNone } from "@/lib/full-length";
import { loadFlAttemptMeta, type FlSectionScope } from "@/lib/full-length-score";
import { getQaTestIds, getQaUserIds, onSide } from "@/lib/qa";
import { getTestSections, inSubjects } from "@/lib/teacher-access";
import { shapeGradebook, type GradebookSubRow } from "@/lib/class-gradebook-shape";
import type { Gradebook } from "@/lib/class-gradebook-view";

const SECTIONS = ["Math", "Reading & Writing"] as const;

/** Sections a viewer may see: null subjects = both. */
export function scopeOfSubjects(subjects: string[] | null): FlSectionScope {
  return subjects === null
    ? { rw: true, math: true }
    : { rw: subjects.includes("Reading & Writing"), math: subjects.includes("Math") };
}

/**
 * Who may see a class's gradebook, and which subjects: admins everything;
 * a teacher assigned to the class, limited to their link's subject (NULL =
 * both). null = no access (not a class teacher, or the other QA side is
 * checked by the caller).
 */
export async function gradebookSubjects(
  db: SupabaseClient,
  user: { userId: string; role: string | null | undefined },
  classGroupId: string,
): Promise<{ subjects: string[] | null } | null> {
  if (user.role === "admin") return { subjects: null };
  if (user.role !== "teacher") return null;
  const { data: link } = await db
    .from("class_group_teachers")
    .select("subject")
    .eq("class_group_id", classGroupId)
    .eq("teacher_id", user.userId)
    .maybeSingle();
  if (!link) return null;
  const subject = (link.subject as string | null) ?? null;
  if (subject === null) return { subjects: null };
  // An unknown subject fails closed: no tests, no sections.
  return { subjects: (SECTIONS as readonly string[]).includes(subject) ? [subject] : [] };
}

type MemberRow = {
  student_id: string;
  users: { id: string; email: string; display_name: string | null } | { id: string; email: string; display_name: string | null }[] | null;
};

type AssignmentRow = {
  test_id: string;
  tests:
    | { id: string; test_name: string | null; open_date: string | null; due_date: string | null; created_at: string | null; status?: string | null }
    | { id: string; test_name: string | null; open_date: string | null; due_date: string | null; created_at: string | null; status?: string | null }[]
    | null;
};

/**
 * The grid's frame: the class's current members and its assigned tests,
 * on the viewer's QA side and in their subjects (full-length parents,
 * never a child). Also what the live poll scopes to (lib/live-progress
 * loadClassLiveSnapshot), without reading any submissions.
 */
export async function loadClassGradebookFrame(
  db: SupabaseClient,
  opts: {
    classGroupId: string;
    isQa: boolean;
    /** Teacher's subjects for this class (null = both / admin). */
    subjects: string[] | null;
  },
) {
  const [{ data: memberRows, error: memberErr }, { data: assignments, error: assignErr }, qaTests, qaUsers, links] =
    await Promise.all([
      fetchAllRows<MemberRow>((from, to) =>
        db
          .from("class_group_members")
          .select("student_id, users!student_id(id, email, display_name)")
          .eq("class_group_id", opts.classGroupId)
          .order("id")
          .range(from, to) as unknown as PromiseLike<{ data: MemberRow[] | null; error: unknown }>,
      ),
      db
        .from("test_assignments")
        .select("test_id, tests(id, test_name, open_date, due_date, created_at, status)")
        .contains("class_group_ids", JSON.stringify([opts.classGroupId])),
      getQaTestIds(),
      getQaUserIds(),
      fullLengthLinksOrNone(db),
    ]);
  if (memberErr) throw new Error(`gradebook members lookup failed: ${(memberErr as { message?: string }).message ?? String(memberErr)}`);
  if (assignErr) throw new Error(`gradebook assignments lookup failed: ${assignErr.message}`);

  const students = (memberRows ?? [])
    .map((m) => (Array.isArray(m.users) ? m.users[0] : m.users))
    .filter((u): u is NonNullable<typeof u> => Boolean(u) && onSide(u!.id, qaUsers, opts.isQa))
    .map((u) => ({ id: u.id, name: u.display_name || u.email, email: u.email }));

  const seen = new Set<string>();
  const candidates = ((assignments ?? []) as unknown as AssignmentRow[])
    .map((a) => ({ id: a.test_id, t: Array.isArray(a.tests) ? a.tests[0] : a.tests }))
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return a.t && onSide(a.id, qaTests, opts.isQa) && !links.parentOf.has(a.id);
    });
  const scope = scopeOfSubjects(opts.subjects);
  const sectionOf = await getTestSections(
    db,
    candidates.filter((a) => !links.childrenOf.has(a.id)).map((a) => a.id),
  );
  // A full-length parent has both subjects: every class teacher with a
  // known subject sees it (scoped to their section); a section test only
  // in the teacher's subject.
  const tests = candidates
    .filter((a) =>
      links.childrenOf.has(a.id) ? scope.rw || scope.math : inSubjects(sectionOf.get(a.id) ?? null, opts.subjects),
    )
    .map((a) => ({
      id: a.id,
      name: a.t!.test_name ?? "Untitled test",
      section: sectionOf.get(a.id) ?? null,
      dueDate: a.t!.due_date,
      openDate: a.t!.open_date,
      createdAt: a.t!.created_at,
      status: a.t!.status ?? null,
    }));
  return { students, tests, scope, links };
}

export async function loadClassGradebook(
  db: SupabaseClient,
  opts: {
    classGroupId: string;
    isQa: boolean;
    /** Teacher's subjects for this class (null = both / admin). */
    subjects: string[] | null;
    /** Column header link: the test's results page. */
    testHref: (testId: string) => string;
    /** Questions & answers (Class Review) link next to each test name. */
    reviewHref?: (testId: string) => string;
    now?: Date;
  },
): Promise<Gradebook> {
  const { students, tests, scope, links } = await loadClassGradebookFrame(db, opts);
  const testIds = tests.map((t) => t.id);
  const studentIds = students.map((s) => s.id);
  const flParents = testIds.filter((id) => links.childrenOf.has(id));
  const [{ data: rows, error: rowsErr }, flMeta] = await Promise.all([
    testIds.length && studentIds.length
      ? fetchAllRows<GradebookSubRow>((from, to) =>
          db
            .from("submissions")
            .select(
              "id, test_id, student_id, status, session_id, adaptive_track, started_at, submitted_at, correct_count, total_questions, attempt_number",
            )
            .in("test_id", expandWithChildren(testIds, links))
            .in("student_id", studentIds)
            .order("id")
            .range(from, to) as unknown as PromiseLike<{ data: GradebookSubRow[] | null; error: unknown }>,
        )
      : Promise.resolve({ data: [] as GradebookSubRow[], error: null }),
    loadFlAttemptMeta(db, flParents),
  ]);
  if (rowsErr) throw new Error(`gradebook submissions lookup failed: ${(rowsErr as { message?: string }).message ?? String(rowsErr)}`);

  return shapeGradebook({
    students,
    tests,
    rows: rows ?? [],
    links,
    flMeta,
    scope,
    now: opts.now ?? new Date(),
    testHref: opts.testHref,
    reviewHref: opts.reviewHref,
  });
}
