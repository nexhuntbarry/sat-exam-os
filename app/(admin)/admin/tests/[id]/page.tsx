import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import TestDetailActions from "./TestDetailActions";
import EditTestButton from "./EditTestButton";
import AddStudentsButton from "./AddStudentsButton";
import ReviewModeToggle from "@/components/tests/ReviewModeToggle";
import { formatDate, formatDateTime } from "@/lib/datetime";

async function getTest(id: string) {
  const db = getServiceClient();

  const { data: test, error } = await db
    .from("tests")
    .select(`
      id, test_name, module_id, module_2_id, time_limit_minutes, time_limit_minutes_module_2,
      open_date, due_date,
      show_answers_after_submission, allow_retake, status, created_at, updated_at,
      is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, adaptive_threshold,
      desmos_enabled, formula_sheet_url, review_unlocked,
      modules!module_id(module_name, section, module_number, source_name)
    `)
    .eq("id", id)
    .single();

  if (error || !test) return null;

  // module_2_id (non-adaptive two-module path) lives in a separate
  // column with no foreign-key embed alias here, so pull its metadata
  // in a follow-up query. Adaptive tests don't use this column.
  let module2Meta:
    | { module_name: string; section: string; module_number: number | null }
    | null = null;
  if (test.module_2_id) {
    const { data: m2 } = await db
      .from("modules")
      .select("module_name, section, module_number")
      .eq("id", test.module_2_id)
      .maybeSingle();
    module2Meta = (m2 as { module_name: string; section: string; module_number: number | null } | null) ?? null;
  }

  const [{ data: assignment }, { data: submissions }] = await Promise.all([
    db.from("test_assignments").select("teacher_ids, student_ids, class_group_ids").eq("test_id", id).single(),
    db.from("submissions").select("id, status, score, percentage, student_id, submitted_at").eq("test_id", id),
  ]);

  // Get teacher names
  const teacherIds: string[] = assignment?.teacher_ids ?? [];
  const studentIds: string[] = assignment?.student_ids ?? [];
  const classGroupIds: string[] = assignment?.class_group_ids ?? [];

  const [{ data: teachers }, { data: classGroups }] = await Promise.all([
    teacherIds.length > 0
      ? db.from("users").select("id, display_name, email").in("id", teacherIds)
      : Promise.resolve({ data: [] }),
    classGroupIds.length > 0
      ? db.from("class_groups").select("id, name").in("id", classGroupIds)
      : Promise.resolve({ data: [] }),
  ]);

  const submittedSubs = (submissions ?? []).filter((s) => s.status === "Submitted" || s.status === "Late");
  const avgScore = submittedSubs.length > 0
    ? submittedSubs.reduce((sum, s) => sum + (Number(s.percentage) || 0), 0) / submittedSubs.length
    : null;

  return {
    ...test,
    module2Meta,
    assignment: {
      teacherIds,
      studentIds,
      classGroupIds,
      teachers: teachers ?? [],
      classGroups: classGroups ?? [],
    },
    stats: {
      total: (submissions ?? []).length,
      submitted: submittedSubs.length,
      avgScore,
    },
  };
}

const statusStyles: Record<string, string> = {
  Draft: "bg-light-bg text-mid-gray",
  Published: "bg-warm-amber/15 text-warm-amber",
  Closed: "bg-status-error/15 text-status-error",
};

export default async function TestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const { id } = await params;
  const test = await getTest(id);
  if (!test) notFound();

  // Eligible modules for the Edit modal — same predicate as the
  // create page: approved or with ≥5 approved questions. Keep this in
  // sync with /admin/tests/new logic.
  const db = getServiceClient();
  const { data: modulesRaw } = await db
    .from("modules")
    .select(
      "id, module_name, section, module_number, parsing_status, total_questions, questions:questions!module_id(parsing_status)",
    )
    .order("module_name");
  type ModRow = {
    id: string;
    module_name: string;
    section: string;
    module_number: number | null;
    parsing_status: string;
    total_questions: number | null;
    questions: { parsing_status: string }[] | null;
  };
  // Whatever modules this test already uses must remain in the dropdown
  // even if they no longer pass the eligibility filter (e.g. an admin
  // un-approved a Module that's still wired to a published test). Skip
  // and the select falls back to "— None —" and looks broken.
  const currentModuleIds = new Set(
    [
      test.module_id,
      test.module_2_id,
      test.module_1_id,
      test.module_2_easy_id,
      test.module_2_hard_id,
    ].filter((x): x is string => Boolean(x)),
  );
  const eligibleModules = ((modulesRaw ?? []) as ModRow[])
    .filter((m) => {
      if (currentModuleIds.has(m.id)) return true;
      if (m.parsing_status === "approved") return true;
      const approvedCount = (m.questions ?? []).filter(
        (q) => q.parsing_status === "Approved",
      ).length;
      return approvedCount >= 5;
    })
    .map((m) => ({
      id: m.id,
      module_name: m.module_name,
      section: m.section,
      module_number: m.module_number,
      total_questions: m.total_questions,
    }));

  // Adaptive tests have no single tests.module_id, so the join may
  // return null. The summary line below switches to a multi-module
  // label in that case.
  const mod = test.modules as unknown as
    | { module_name: string; section: string; module_number: number | null; source_name: string | null }
    | null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/admin/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-charcoal">{test.test_name}</h1>
            <span className={clsx("px-2.5 py-1 rounded-full text-xs font-semibold", statusStyles[test.status] ?? "bg-light-bg text-mid-gray")}>
              {test.status}
            </span>
            {test.is_adaptive && (
              <span className="px-2 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-warm-coral/15 text-warm-coral">
                Adaptive
              </span>
            )}
          </div>
          <p className="text-soft-mute text-sm">
            {mod ? (
              <>
                {mod.module_name} · {mod.section}
                {mod.module_number ? ` M${mod.module_number}` : ""}
                {mod.source_name ? ` · ${mod.source_name}` : ""}
                {test.module2Meta && (
                  <>
                    {" "}
                    <span className="text-charcoal/40">+</span>{" "}
                    {test.module2Meta.module_name} · {test.module2Meta.section}
                    {test.module2Meta.module_number ? ` M${test.module2Meta.module_number}` : ""}
                  </>
                )}
              </>
            ) : (
              <span className="italic">Adaptive · Module 1 + Module 2 (easy/hard)</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <Link
            href={`/admin/tests/${test.id}/manage-submissions`}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-light-bg hover:bg-divider text-charcoal font-semibold text-sm transition-colors"
            title="Reset / force-submit / delete student submissions"
          >
            Manage submissions
          </Link>
          <AddStudentsButton testId={test.id} alreadyAssigned={test.assignment.studentIds} />
          <EditTestButton
            test={{
              id: test.id,
              test_name: test.test_name,
              is_adaptive: Boolean(test.is_adaptive),
              module_id: test.module_id,
              module_2_id: test.module_2_id,
              module_1_id: test.module_1_id,
              module_2_easy_id: test.module_2_easy_id,
              module_2_hard_id: test.module_2_hard_id,
              adaptive_threshold: test.adaptive_threshold,
              time_limit_minutes: test.time_limit_minutes,
              time_limit_minutes_module_2: test.time_limit_minutes_module_2,
              open_date: test.open_date,
              due_date: test.due_date,
              show_answers_after_submission: Boolean(test.show_answers_after_submission),
              allow_retake: Boolean(test.allow_retake),
              desmos_enabled: Boolean(test.desmos_enabled),
            }}
            modules={eligibleModules}
          />
          <TestDetailActions testId={test.id} testName={test.test_name} status={test.status} />
        </div>
      </div>

      <ReviewModeToggle
        testId={test.id}
        initialUnlocked={Boolean(test.review_unlocked)}
      />

      {/* Config summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Time Limit",
            value: (() => {
              // Two-module test (non-adaptive with module_2_id, or any
              // adaptive test) → show both modules' limits as "M1 + M2".
              // Module 2 falls back to Module 1's limit when the admin
              // didn't set a separate one. Single-module → just "X min".
              const m1 = test.time_limit_minutes;
              const m2 = test.time_limit_minutes_module_2 ?? m1;
              const isTwoModule = test.is_adaptive || Boolean(test.module_2_id);
              if (!m1) return "—";
              if (isTwoModule) return `${m1} + ${m2} min`;
              return `${m1} min`;
            })(),
          },
          { label: "Open Date", value: test.open_date ? formatDateTime(test.open_date) : "—" },
          { label: "Due Date", value: test.due_date ? formatDateTime(test.due_date) : "—" },
          { label: "Allow Retake", value: test.allow_retake ? "Yes" : "No" },
          { label: "Show Answers", value: test.show_answers_after_submission ? "Yes" : "No" },
          { label: "Teachers", value: String(test.assignment.teacherIds.length) },
          { label: "Students", value: String(test.assignment.studentIds.length) },
          { label: "Class Groups", value: String(test.assignment.classGroupIds.length) },
        ].map(({ label, value }) => (
          <div key={label} className="bg-surface border border-divider rounded-xl p-4">
            <div className="text-soft-mute text-xs mb-1">{label}</div>
            <div className="text-charcoal font-semibold text-sm">{value}</div>
          </div>
        ))}
      </div>

      {/* Submission stats */}
      <div className="bg-surface border border-divider rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-charcoal font-semibold">Submissions</h2>
          <Link href={`/admin/tests/${test.id}/submissions`} className="text-warm-coral text-sm hover:underline">
            View all submissions →
          </Link>
        </div>
        <div className="flex gap-6">
          <div>
            <div className="text-2xl font-bold text-charcoal">{test.stats.submitted}</div>
            <div className="text-soft-mute text-xs">Submitted</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-charcoal">{test.stats.total}</div>
            <div className="text-soft-mute text-xs">Total</div>
          </div>
          {test.stats.avgScore !== null && (
            <div>
              <div className="text-2xl font-bold text-warm-amber">{test.stats.avgScore.toFixed(1)}%</div>
              <div className="text-soft-mute text-xs">Avg Score</div>
            </div>
          )}
        </div>
      </div>

      {/* Assignment details */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4 space-y-2">
          <h3 className="text-soft-mute text-xs font-medium uppercase tracking-wider">Teachers</h3>
          {test.assignment.teachers.length === 0 ? (
            <p className="text-soft-mute text-sm">None assigned</p>
          ) : test.assignment.teachers.map((t: { id: string; display_name: string; email: string }) => (
            <div key={t.id} className="text-charcoal text-sm">{t.display_name}</div>
          ))}
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 space-y-2">
          <h3 className="text-soft-mute text-xs font-medium uppercase tracking-wider">Class Groups</h3>
          {test.assignment.classGroups.length === 0 ? (
            <p className="text-soft-mute text-sm">None assigned</p>
          ) : test.assignment.classGroups.map((cg: { id: string; name: string }) => (
            <div key={cg.id} className="text-charcoal text-sm">{cg.name}</div>
          ))}
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 space-y-2">
          <h3 className="text-soft-mute text-xs font-medium uppercase tracking-wider">Individual Students</h3>
          <p className="text-soft-mute text-sm">{test.assignment.studentIds.length} student(s)</p>
        </div>
      </div>
    </div>
  );
}
