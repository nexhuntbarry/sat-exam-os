import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import TestTakingClient from "./TestTakingClient";

async function getActiveSubmission(testId: string, studentId: string) {
  const db = getServiceClient();

  const { data: submission } = await db
    .from("submissions")
    .select("id, test_id, answers, status, started_at, metadata")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .eq("status", "In Progress")
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!submission) return null;

  const { data: test } = await db
    .from("tests")
    .select("id, test_name, time_limit_minutes, due_date, question_ids, module_id")
    .eq("id", testId)
    .single();

  if (!test) return null;

  let questionQuery = db
    .from("questions")
    .select("id, original_question_number, question_text, choices, question_type, has_image, has_table, source_pdf_url, section, image_urls, image_alts")
    .eq("module_id", test.module_id)
    .eq("parsing_status", "Approved")
    .order("original_question_number", { ascending: true });

  if (test.question_ids && Array.isArray(test.question_ids) && test.question_ids.length > 0) {
    questionQuery = questionQuery.in("id", test.question_ids);
  }

  const { data: questions } = await questionQuery;

  const startedAt = new Date(submission.started_at).getTime();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - startedAt) / 1000);
  const timeLimitSeconds = (test.time_limit_minutes ?? 64) * 60;
  const timeRemainingSeconds = Math.max(0, timeLimitSeconds - elapsedSeconds);

  return {
    submission: {
      id: submission.id,
      answers: (submission.answers ?? {}) as Record<string, string>,
      metadata: (submission.metadata ?? {}) as Record<string, unknown>,
    },
    test: {
      id: test.id,
      name: test.test_name,
      timeLimitMinutes: test.time_limit_minutes ?? 64,
      dueDate: test.due_date,
    },
    questions: questions ?? [],
    timeRemainingSeconds,
  };
}

export default async function TestTakingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const data = await getActiveSubmission(id, user.userId);

  if (!data) {
    redirect(`/student/tests/${id}`);
  }

  return (
    <TestTakingClient
      testId={id}
      submissionId={data.submission.id}
      initialAnswers={data.submission.answers}
      initialMetadata={data.submission.metadata}
      test={data.test}
      questions={data.questions}
      timeRemainingSeconds={data.timeRemainingSeconds}
    />
  );
}
