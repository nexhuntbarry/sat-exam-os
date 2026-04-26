import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Clock, BookOpen, Calendar } from "lucide-react";
import StartTestButton from "./StartTestButton";

async function getTestInfo(testId: string, studentId: string) {
  const db = getServiceClient();

  // Check student has access
  const { data: membership } = await db
    .from("class_group_members")
    .select("class_group_id")
    .eq("student_id", studentId);
  const classGroupIds = (membership ?? []).map((m) => m.class_group_id);

  const { data: assignment } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return null;
  const sIds: string[] = assignment.student_ids ?? [];
  const cgIds: string[] = assignment.class_group_ids ?? [];
  const hasAccess = sIds.includes(studentId) || classGroupIds.some((cg) => cgIds.includes(cg));
  if (!hasAccess) return null;

  const { data: test } = await db
    .from("tests")
    .select(`
      id, test_name, status, time_limit_minutes, due_date, open_date,
      allow_retake, show_answers_after_submission, module_id,
      modules!inner(module_name, section, module_number)
    `)
    .eq("id", testId)
    .single();

  if (!test || test.status === "Draft") return null;

  // Get approved question count
  const { count } = await db
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("module_id", test.module_id ?? "")
    .neq("parsing_status", "Rejected");

  // Get submission
  const { data: submission } = await db
    .from("submissions")
    .select("id, status, score, percentage, submitted_at")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { test, questionCount: count ?? 0, submission };
}

export default async function StudentTestLandingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const data = await getTestInfo(id, user.userId);
  if (!data) notFound();

  const { test, questionCount, submission } = data;
  const mod = test.modules as unknown as { module_name: string; section: string; module_number: number | null };

  const isPastDue = test.due_date && new Date(test.due_date) < new Date();
  const isInProgress = submission?.status === "In Progress";
  const isSubmitted = submission?.status === "Submitted" || submission?.status === "Late";
  const canRetake = test.allow_retake && isSubmitted;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/student/tests" className="hover:text-charcoal transition-colors">My Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
      </div>

      <div className="bg-surface border border-divider rounded-2xl p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-1">{test.test_name}</h1>
          <p className="text-soft-mute">{mod.module_name} · {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}</p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <Clock size={20} className="text-warm-coral mb-2" />
            <div className="text-charcoal font-semibold">{test.time_limit_minutes ?? "—"} min</div>
            <div className="text-soft-mute text-xs">Time Limit</div>
          </div>
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <BookOpen size={20} className="text-warm-coral mb-2" />
            <div className="text-charcoal font-semibold">{questionCount}</div>
            <div className="text-soft-mute text-xs">Questions</div>
          </div>
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <Calendar size={20} className="text-warm-coral mb-2" />
            <div className="text-charcoal font-semibold text-sm">
              {test.due_date ? new Date(test.due_date).toLocaleDateString() : "No deadline"}
            </div>
            <div className="text-soft-mute text-xs">Due Date</div>
          </div>
        </div>

        {/* State-based CTA */}
        {isSubmitted && !canRetake ? (
          <div className="space-y-3">
            <div className="p-4 bg-warm-amber/10 border border-warm-amber/20 rounded-xl text-center">
              <div className="text-warm-amber font-semibold mb-1">Test Submitted</div>
              <div className="text-charcoal text-2xl font-bold">
                {submission?.percentage != null ? `${Number(submission.percentage).toFixed(1)}%` : ""}
              </div>
            </div>
            <Link
              href={`/student/tests/${test.id}/result`}
              className="block w-full py-3 text-center rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold transition-colors"
            >
              View Result
            </Link>
          </div>
        ) : isPastDue && !isInProgress ? (
          <div className="p-4 bg-status-error/10 border border-status-error/20 rounded-xl text-center text-status-error">
            This test is no longer available — the due date has passed.
          </div>
        ) : (
          <div className="space-y-3">
            {isInProgress && (
              <p className="text-status-warning text-sm text-center">
                You have an in-progress submission. Resuming will continue from where you left off.
              </p>
            )}
            <StartTestButton
              testId={test.id}
              submissionId={isInProgress ? submission?.id : undefined}
              isResume={isInProgress}
            />
          </div>
        )}
      </div>
    </div>
  );
}
