import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, MapPin, GraduationCap, Users } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, onSide } from "@/lib/qa";
import { getTeacherTestScope, getTestSections, inSubjects } from "@/lib/teacher-access";
import { getServiceClient } from "@/lib/supabase";
import { formatShortDateTime } from "@/lib/datetime";
import { averageSat } from "@/lib/score-display";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import { attemptGroupKey, flFinished, listedTestId, loadFlAttemptMeta, scoreAttemptGroup } from "@/lib/full-length-score";
import { loadClassGradebook } from "@/lib/class-gradebook";
import { gradebookLiveFrame } from "@/lib/class-gradebook-view";
import { loadClassLiveSnapshot } from "@/lib/live-progress";
import { emptyLiveSnapshot } from "@/lib/live-progress-shared";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import ClassGradebook from "@/components/analytics/ClassGradebook";
import AssignedTestsTable from "@/components/analytics/AssignedTestsTable";
import { assignedTestRows, classReviewHref, type TestMeta } from "@/lib/assigned-tests-view";
import type { Gradebook } from "@/lib/class-gradebook-view";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTranslations } from "next-intl/server";
import {
  DataRow,
  DataTable,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  HeadRow,
  Td,
  Th,
  TruncatedText,
  TwoLineCell,
} from "@/components/ui/data-table";

export const dynamic = "force-dynamic";

async function loadClass(id: string, teacherId: string, isAdmin: boolean, isQa: boolean) {
  const db = getServiceClient();

  // Teacher must be assigned to this group; admin sees everything. The
  // link's subject (NULL = both) scopes which tests count below.
  let subjects: string[] | null = null;
  if (!isAdmin) {
    const { data: link } = await db
      .from("class_group_teachers")
      .select("id, subject")
      .eq("class_group_id", id)
      .eq("teacher_id", teacherId)
      .maybeSingle();
    if (!link) return null;
    subjects = link.subject ? [link.subject as string] : null;
  }

  const { data: group } = await db
    .from("class_groups")
    .select("id, name, campus, grade")
    .eq("id", id)
    .maybeSingle();
  if (!group) return null;

  const { data: memberRows } = await db
    .from("class_group_members")
    .select(
      `student_id,
       users!student_id(id, email, display_name)`,
    )
    .eq("class_group_id", id);

  type MemberRow = {
    student_id: string;
    users:
      | { id: string; email: string; display_name: string | null }
      | { id: string; email: string; display_name: string | null }[]
      | null;
  };
  const students = ((memberRows ?? []) as unknown as MemberRow[])
    .map((m) => (Array.isArray(m.users) ? m.users[0] : m.users))
    .filter((u): u is NonNullable<typeof u> => Boolean(u));

  const studentIds = students.map((s) => s.id);

  // Pull every submission for these students so we can compute averages
  // and last-active per student. Paged: PostgREST caps a response at 1000 rows.
  const [{ data: subs }, { data: assignments }] = await Promise.all([
    studentIds.length
      ? fetchAllRows((from, to) =>
          db
            .from("submissions")
            .select(
              "id, student_id, status, correct_count, total_questions, submitted_at, session_id, adaptive_track, attempt_number, started_at, test_id, tests!inner(test_name)",
            )
            .in("student_id", studentIds)
            .order("id")
            .range(from, to),
        )
      : Promise.resolve({ data: [] }),
    fetchAllRows((from, to) =>
      db.from("test_assignments").select("test_id, student_ids, class_group_ids").order("test_id").range(from, to),
    ),
  ]);

  type Sub = {
    id: string;
    student_id: string;
    status: string;
    correct_count: number | null;
    total_questions: number | null;
    submitted_at: string | null;
    session_id: string | null;
    adaptive_track: string | null;
    attempt_number: number | null;
    started_at: string | null;
    test_id: string;
    tests:
      | { test_name: string }
      | { test_name: string }[]
      | null;
  };
  const subRows = (subs ?? []) as unknown as Sub[];
  // Full-length SAT section rows are one attempt under the parent (counted
  // as completed; its total is kept out of the per-section SAT columns).
  const flLinks = await fullLengthLinksOrNone(db);
  const flParentIds = Array.from(new Set(subRows.map((s) => flLinks.parentOf.get(s.test_id)).filter((x): x is string => Boolean(x))));
  const flMeta = await loadFlAttemptMeta(db, flParentIds);

  // Only tests on the viewer's QA side and in the subject this teacher
  // teaches the class.
  const qaTests = await getQaTestIds();
  const candidateTests = new Set<string>(subRows.map((s) => listedTestId(s.test_id, flLinks)));
  for (const a of assignments ?? []) candidateTests.add(a.test_id as string);
  const sectionOf = await getTestSections(db, Array.from(candidateTests), { strict: true });
  // A full-length parent has both subjects: any of the class's teachers sees it.
  const visible = (testId: string) =>
    onSide(testId, qaTests, isQa) &&
    (flLinks.childrenOf.has(testId) || inSubjects(sectionOf.get(testId) ?? null, subjects));

  // Assigned per student = tests assigned to this class ∪ assigned to the
  // student individually ∪ tests they took.
  const classTests = new Set<string>();
  const assignedTo: Record<string, Set<string>> = {};
  for (const a of assignments ?? []) {
    const testId = a.test_id as string;
    if (!visible(testId)) continue;
    if (((a.class_group_ids as string[] | null) ?? []).includes(id)) classTests.add(testId);
    for (const sid of (a.student_ids as string[] | null) ?? []) {
      (assignedTo[sid] ??= new Set()).add(testId);
    }
  }

  // Group module rows into attempts (two-module attempts share a session_id).
  const attempts = new Map<string, Sub[]>();
  for (const s of subRows) {
    if (!visible(listedTestId(s.test_id, flLinks))) continue;
    const key = flLinks.parentOf.has(s.test_id) ? attemptGroupKey(s, flLinks) : s.session_id ?? s.id;
    attempts.set(key, [...(attempts.get(key) ?? []), s]);
  }

  // Averages / latest use finished attempts only, scored with the shared
  // score display (a graded Module 1 alone is not finished). Each test
  // counts once per student, with their latest FINISHED attempt (the
  // gradebook's rule: a retake in progress keeps the earlier score).
  type Latest = { test_name: string; submitted_at: string | null; sat: number | null };
  type Slot = { total: number; completed: number; sats: number[]; pcts: number[]; latest: Latest | null };
  const emptySlot = (): Slot => ({ total: 0, completed: 0, sats: [], pcts: [], latest: null });
  const perStudent: Record<string, Slot> = {};
  const tested: Record<string, Set<string>> = {};
  const completedTests: Record<string, Set<string>> = {};
  // student:test → its latest finished section attempt. "Latest" = most
  // recently started session (studentTestProgress's order).
  const finished = new Map<string, { sid: string; rank: string; rows: Sub[]; sat: number | null; pct: number | null }>();
  for (const rows of attempts.values()) {
    const head = rows[0];
    const sid = head.student_id;
    perStudent[sid] ??= emptySlot();
    const testId = listedTestId(head.test_id, flLinks);
    (tested[sid] ??= new Set()).add(testId);
    const { status, score, fullLength } = scoreAttemptGroup(rows, flLinks, sectionOf.get(head.test_id), flMeta);
    if (fullLength ? !flFinished(fullLength) : status !== "Submitted" && status !== "Late") continue;
    (completedTests[sid] ??= new Set()).add(testId);
    // The averages and the "latest" SAT column are per section: a
    // full-length attempt (total 400–1600) counts as completed only.
    if (fullLength) continue;
    const rank = rows.map((r) => r.started_at ?? "").sort().pop() ?? "";
    const k = `${sid}:${testId}`;
    const cur = finished.get(k);
    if (!cur || rank > cur.rank) finished.set(k, { sid, rank, rows, sat: score?.sat ?? null, pct: score?.pct ?? null });
  }
  for (const f of finished.values()) {
    const slot = perStudent[f.sid];
    if (f.sat != null) slot.sats.push(f.sat);
    if (f.pct != null) slot.pcts.push(f.pct);
    const head = f.rows[0];
    const submittedAt = f.rows.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null;
    if (!slot.latest || (submittedAt ?? "") > (slot.latest.submitted_at ?? "")) {
      const t = (Array.isArray(head.tests) ? head.tests[0] : head.tests) as
        | { test_name: string }
        | null;
      slot.latest = {
        test_name: t?.test_name ?? "—",
        submitted_at: submittedAt,
        sat: f.sat,
      };
    }
  }
  for (const sid of studentIds) {
    const all = new Set([...classTests, ...(assignedTo[sid] ?? []), ...(tested[sid] ?? [])]);
    if (all.size === 0 && !perStudent[sid]) continue;
    const slot = (perStudent[sid] ??= emptySlot());
    slot.total = all.size;
    slot.completed = completedTests[sid]?.size ?? 0;
  }

  return { group, students, perStudent, subjects };
}

// Status and open date of the gradebook's columns (parents only: the
// gradebook never lists a full-length section child).
async function loadTestMeta(db: SupabaseClient, gradebook: Gradebook): Promise<Map<string, TestMeta>> {
  const ids = gradebook.columns.map((c) => c.id);
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from("tests").select("id, status, open_date, due_date").in("id", ids);
  if (error) throw new Error(`tests lookup failed: ${error.message}`);
  return new Map(
    (data ?? []).map((t) => [
      t.id as string,
      { status: (t.status as string | null) ?? null, openDate: (t.open_date as string | null) ?? null, dueDate: (t.due_date as string | null) ?? null },
    ]),
  );
}

export default async function TeacherClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/sign-in");
  if (me.role !== "teacher" && me.role !== "admin") redirect("/dashboard");

  const { id } = await params;
  if (!onSide(id, await getQaClassGroupIds(), me.isQa)) notFound();
  const data = await loadClass(id, me.userId, me.role === "admin", me.isQa);
  if (!data) notFound();
  const { group, students, perStudent, subjects } = data;
  // Same grid as the admin class page, limited to this teacher's subject.
  // A failed read shows a notice in Scores; the roster still renders.
  const gradebook = await loadClassGradebook(getServiceClient(), {
    classGroupId: id,
    isQa: me.isQa,
    subjects,
    testHref: (testId) => `/teacher/tests/${testId}/results`,
    reviewHref: classReviewHref,
  }).catch((e) => {
    console.error("[teacher/classes/gradebook] load failed:", e);
    return null;
  });
  // Live lines for unfinished cells; a failure only leaves them out (the grid polls again).
  const liveInitial = gradebook
    ? await loadClassLiveSnapshot(getServiceClient(), me, gradebookLiveFrame(gradebook)).catch((e) => {
        console.error("[teacher/classes/live-progress] load failed:", e);
        return emptyLiveSnapshot();
      })
    : emptyLiveSnapshot();
  // Assigned Tests: the gradebook's columns (this class's assignments in the
  // teacher's subject), kept only when getTeacherTestScope reaches them too.
  // Any failed read shows "couldn't load" (never an unscoped list).
  const assigned = gradebook
    ? await Promise.all([getTeacherTestScope(getServiceClient(), me), loadTestMeta(getServiceClient(), gradebook)])
        .then(([scope, meta]) => assignedTestRows(gradebook, meta, scope.testIds, new Date()))
        .catch((e) => {
          console.error("[teacher/classes/assigned-tests] load failed:", e);
          return null;
        })
    : null;
  const tReview = await getTranslations("teacher.classReview");
  const reviewLabel = { short: tReview("short"), full: tReview("button") };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/teacher/classes" className="text-soft-mute hover:text-charcoal">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-charcoal">{group.name}</h1>
          <div className="mt-1 flex flex-wrap gap-3 text-soft-mute text-xs">
            {group.campus && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={11} />
                {group.campus}
              </span>
            )}
            {group.grade && (
              <span className="inline-flex items-center gap-1">
                <GraduationCap size={11} />
                {group.grade}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Users size={11} />
              {students.length} {students.length === 1 ? "student" : "students"}
            </span>
          </div>
        </div>
      </div>

      <ClassGradebook
        classId={group.id}
        className={group.name}
        gradebook={gradebook}
        live={{ endpoint: `/api/teacher/classes/${group.id}/live-progress`, initial: liveInitial }}
        reviewLabel={reviewLabel}
        above={<AssignedTestsTable tests={assigned ?? []} failed={!assigned} reviewLabel={reviewLabel.full} />}
      />

      <section>
        <h2 className="text-charcoal font-semibold mb-3">Roster</h2>
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Student</Th>
              <Th>Progress</Th>
              <Th kind="long" priority="lg" className="w-[28%]">Latest</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {students.length === 0 && (
              <EmptyRow colSpan={4}>No students in this class yet.</EmptyRow>
            )}
            {students.map((s) => {
              const stats = perStudent[s.id] ?? { total: 0, completed: 0, sats: [], pcts: [], latest: null };
              const avgSat = averageSat(stats.sats);
              const avgPct =
                stats.pcts.length > 0
                  ? stats.pcts.reduce((a, b) => a + b, 0) / stats.pcts.length
                  : null;
              const latestName = stats.latest?.test_name ?? null;
              const latestDetail = stats.latest
                ? [
                    stats.latest.sat != null ? `SAT ${stats.latest.sat}` : null,
                    stats.latest.submitted_at
                      ? formatShortDateTime(stats.latest.submitted_at)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : null;
              const name = s.display_name ?? s.email;

              return (
                <DataRow
                  key={s.id}
                  href={`/teacher/classes/${group.id}/students/${s.id}`}
                  expandBelow="lg"
                  colSpan={4}
                  details={
                    <DetailItem label="Latest" priority="lg">
                      {latestName
                        ? `${latestName}${latestDetail ? ` · ${latestDetail}` : ""}`
                        : "—"}
                    </DetailItem>
                  }
                >
                  <Td kind="main" sticky="left">
                    <Link
                      href={`/teacher/classes/${group.id}/students/${s.id}`}
                      className="block hover:text-warm-coral-text transition-colors"
                    >
                      <TwoLineCell
                        main={s.display_name ?? s.email}
                        detail={s.display_name ? s.email : undefined}
                        mainClassName="font-medium text-inherit"
                      />
                    </Link>
                  </Td>
                  <Td>
                    <TwoLineCell
                      main={`${stats.completed}/${stats.total} done`}
                      detail={
                        avgSat != null ? (
                          <>
                            Avg SAT {avgSat}
                            {avgPct != null && <span className="text-soft-mute"> · {avgPct.toFixed(1)}% correct</span>}
                          </>
                        ) : undefined
                      }
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                  <Td kind="long" priority="lg">
                    {latestName ? (
                      <TwoLineCell
                        main={<TruncatedText>{latestName}</TruncatedText>}
                        detail={latestDetail ?? undefined}
                        mainClassName="text-charcoal"
                      />
                    ) : (
                      <span className="text-soft-mute">—</span>
                    )}
                  </Td>
                  <Td kind="actions" sticky="right">
                    <ExpandToggle label={`More about ${name}`} />
                  </Td>
                </DataRow>
              );
            })}
          </tbody>
        </DataTable>
      </section>
    </div>
  );
}
