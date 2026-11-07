import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import { getTeacherTestAccess } from "@/lib/teacher-access";
import { scopeToStudentQuestionSet } from "@/lib/student-exam";
import { parseActivity, summarizeActivity, type ActivitySummary } from "@/lib/question-activity";
import { fetchAllRows } from "@/lib/fetch-all-rows";

export interface StudentQuestionRow {
  name: string;
  answer: string | null;
  correct: boolean;
  /** Recorded on the take page; null for attempts from before it existed. */
  activity: ActivitySummary | null;
}

export interface AnalyticsQuestion {
  questionId: string;
  questionNumber: number;
  questionText: string;
  correctAnswer: string;
  domain: string | null;
  difficulty: string | null;
  /** Students who were served this question in a graded module. */
  taken: number;
  correct: number;
  /** Wrong answer or left blank. */
  missed: number;
  blank: number;
  avgTimeSeconds: number | null;
  /** Students with recorded activity on this question (newer attempts). */
  tracked: number;
  /** Of those, how many changed their answer at least once. */
  changed: number;
  classReview: boolean;
  students: StudentQuestionRow[];
}

export interface AnalyticsModule {
  /** "Module 1", "Module 2 · Easier"…; null for a single-module test. */
  label: string | null;
  questions: AnalyticsQuestion[];
}

// GET /api/teacher/tests/[id]/analytics
// Every question of the test, grouped by module in question order, with how
// many students missed it and what each student did on it.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId } = await params;
  const db = getServiceClient();

  // Two-track auth + class-scoped denominator for class teachers.
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: test } = await db
    .from("tests")
    .select("id, module_id, module_2_id, question_ids, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id")
    .eq("id", testId)
    .single();
  if (!test) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const slots: { moduleId: string | null; label: string | null }[] = test.is_adaptive
    ? [
        { moduleId: test.module_1_id, label: "Module 1" },
        { moduleId: test.module_2_easy_id, label: "Module 2 · Easier" },
        { moduleId: test.module_2_hard_id, label: "Module 2 · Harder" },
      ]
    : test.module_2_id
      ? [
          { moduleId: test.module_id, label: "Module 1" },
          { moduleId: test.module_2_id, label: "Module 2" },
        ]
      : [{ moduleId: test.module_id, label: null }];

  // The question set students were shown and graded on, per module.
  const moduleQuestions = await Promise.all(
    slots.map(async (slot) => {
      if (!slot.moduleId) return [];
      const { data } = await scopeToStudentQuestionSet(
        db
          .from("questions")
          .select("id, original_question_number, question_text, correct_answer, difficulty, domain")
          .eq("module_id", slot.moduleId),
        test,
      ).order("original_question_number", { ascending: true });
      return data ?? [];
    }),
  );
  const questionIds = moduleQuestions.flat().map((q) => q.id as string);

  // Graded module rows in scope (class teachers: their own students only).
  let submissionQuery = db
    .from("submissions")
    .select("id, student_id, status, session_id, adaptive_track, correct_count, total_questions, percentage, metadata, users!inner(display_name, email)")
    .eq("test_id", testId);
  if (access.mode === "class" && access.studentAllowlist) {
    submissionQuery = submissionQuery.in("student_id", Array.from(access.studentAllowlist));
  }
  submissionQuery = scopeIds(submissionQuery, "student_id", await getQaUserIds(), user.isQa);
  const { data: submissionRows } = await submissionQuery;
  // A Module 2 the cron closed without the student ever opening it holds
  // no real answers — counting it would make every question look missed.
  const graded = (submissionRows ?? []).filter(
    (s) =>
      (s.status === "Submitted" || s.status === "Late") &&
      !(s.metadata as Record<string, unknown> | null)?.auto_closed_unopened,
  );

  const subInfo = new Map(
    graded.map((s) => {
      const u = s.users as unknown as { display_name: string | null; email: string | null } | null;
      return [
        s.id as string,
        {
          name: u?.display_name ?? u?.email ?? "Student",
          activity: parseActivity((s.metadata as Record<string, unknown> | null)?.question_activity),
        },
      ];
    }),
  );

  type AnswerRow = { submission_id: string; question_id: string; student_answer: string | null; is_correct: boolean | null; time_spent_seconds: number | null };
  const answerRows: AnswerRow[] = [];
  const subIds = [...subInfo.keys()];
  // Chunked: .in() with hundreds of ids makes a long URL; paged past the
  // 1000-row cap (lib/fetch-all-rows).
  for (let i = 0; i < subIds.length && questionIds.length > 0; i += 100) {
    const { data } = await fetchAllRows<AnswerRow>((from, to) =>
      db
        .from("answer_records")
        .select("submission_id, question_id, student_answer, is_correct, time_spent_seconds")
        .in("submission_id", subIds.slice(i, i + 100))
        .in("question_id", questionIds)
        .order("id")
        .range(from, to),
    );
    answerRows.push(...data);
  }
  const byQuestion = new Map<string, AnswerRow[]>();
  for (const r of answerRows) byQuestion.set(r.question_id, [...(byQuestion.get(r.question_id) ?? []), r]);

  // This teacher's "teach in class" marks (Teaching Mode reads them).
  const { data: notes } = await db
    .from("test_teacher_notes")
    .select("question_id, note_body")
    .eq("test_id", testId)
    .eq("teacher_id", user.userId)
    .eq("note_type", "class_review")
    .is("student_id", null);
  const classReview = new Set((notes ?? []).filter((n) => n.note_body === "true").map((n) => n.question_id as string));

  const modules: AnalyticsModule[] = slots
    .map((slot, i) => ({
      label: slot.label,
      questions: moduleQuestions[i].map((q): AnalyticsQuestion => {
        const rows = byQuestion.get(q.id as string) ?? [];
        const students: StudentQuestionRow[] = rows
          .map((r) => {
            const info = subInfo.get(r.submission_id);
            return {
              name: info?.name ?? "Student",
              answer: r.student_answer,
              correct: Boolean(r.is_correct),
              activity: summarizeActivity(info?.activity[q.id as string]),
            };
          })
          .sort((a, b) => Number(a.correct) - Number(b.correct) || a.name.localeCompare(b.name));
        const correct = students.filter((s) => s.correct).length;
        // Only real recorded times: the old even split says nothing per question.
        const tracked = students.filter((s) => s.activity);
        const times = tracked.map((s) => s.activity!.seconds);
        return {
          questionId: q.id as string,
          questionNumber: q.original_question_number as number,
          questionText: q.question_text as string,
          correctAnswer: (q.correct_answer as string | null) ?? "",
          domain: q.domain as string | null,
          difficulty: q.difficulty as string | null,
          taken: students.length,
          correct,
          missed: students.length - correct,
          blank: students.filter((s) => !s.answer).length,
          avgTimeSeconds: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
          tracked: tracked.length,
          changed: tracked.filter((s) => s.activity!.changes > 0).length,
          classReview: classReview.has(q.id as string),
          students,
        };
      }),
    }))
    .filter((m) => m.questions.length > 0);

  // Attempts, exactly as the Results page builds them: group module rows by
  // session_id; an attempt with any In Progress module isn't submitted.
  const attempts = new Map<string, NonNullable<typeof submissionRows>>();
  for (const s of submissionRows ?? []) {
    const key = (s.session_id as string | null) ?? `solo:${s.id}`;
    attempts.set(key, [...(attempts.get(key) ?? []), s]);
  }
  let submittedAttempts = 0;
  for (const rows of attempts.values()) {
    const statuses = rows.map((r) => r.status as string);
    if (!statuses.includes("In Progress") && statuses.some((st) => st === "Submitted" || st === "Late")) {
      submittedAttempts++;
    }
  }

  return NextResponse.json({ modules, submittedAttempts });
}
