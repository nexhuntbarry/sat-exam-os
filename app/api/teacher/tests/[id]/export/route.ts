import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import { getTeacherTestAccess } from "@/lib/teacher-access";
import { scaleSectionScore } from "@/lib/scoring";

// GET /api/teacher/tests/[id]/export
// CSV of student results, one row per attempt (module rows of a
// two-module attempt are combined).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId } = await params;
  const db = getServiceClient();

  // Class teachers can export their class's results. Direct-assigned
  // teachers get the full test export.
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch test name + questions
  const { data: test } = await db
    .from("tests")
    .select(
      "id, test_name, module_id, module_2_id, question_ids, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id",
    )
    .eq("id", testId)
    .single();

  if (!test) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Module → column prefix. Two-module tests get M1-/M2- headers so the
  // same question number in each module stays distinguishable.
  const modulePrefix = new Map<string, string>();
  if (test.is_adaptive) {
    if (test.module_1_id) modulePrefix.set(test.module_1_id, "M1");
    if (test.module_2_easy_id) modulePrefix.set(test.module_2_easy_id, "M2 Easy");
    if (test.module_2_hard_id) modulePrefix.set(test.module_2_hard_id, "M2 Hard");
  } else if (test.module_2_id) {
    if (test.module_id) modulePrefix.set(test.module_id, "M1");
    modulePrefix.set(test.module_2_id, "M2");
  }
  const moduleOrder = Array.from(modulePrefix.keys());

  let questionQuery = db
    .from("questions")
    .select("id, original_question_number, module_id")
    .order("original_question_number", { ascending: true });

  const qIds = test.question_ids as string[] | null;
  if (!test.is_adaptive && qIds && qIds.length > 0) {
    questionQuery = questionQuery.in("id", qIds);
  } else if (test.is_adaptive) {
    const adaptiveModuleIds = [
      test.module_1_id,
      test.module_2_easy_id,
      test.module_2_hard_id,
    ].filter((x): x is string => Boolean(x));
    if (adaptiveModuleIds.length > 0) {
      questionQuery = questionQuery.in("module_id", adaptiveModuleIds);
    }
  } else if (test.module_2_id) {
    questionQuery = questionQuery.in(
      "module_id",
      [test.module_id, test.module_2_id].filter((x): x is string => Boolean(x)),
    );
  } else if (test.module_id) {
    questionQuery = questionQuery.eq("module_id", test.module_id);
  }

  const { data: questions, error: questionError } = await questionQuery;
  if (questionError) {
    console.error("[teacher/tests/export questions]", questionError);
    return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
  }
  const rank = (moduleId: string | null) => {
    const i = moduleId ? moduleOrder.indexOf(moduleId) : -1;
    return i === -1 ? moduleOrder.length : i;
  };
  const questionList = [...(questions ?? [])].sort(
    (a, b) =>
      rank(a.module_id) - rank(b.module_id) ||
      (a.original_question_number ?? 0) - (b.original_question_number ?? 0),
  );

  // Fetch submissions. Class teachers see only their class roster.
  let submissionsQuery = db
    .from("submissions")
    .select(`
      id, student_id, status, correct_count, total_questions, percentage,
      scaled_score, submitted_at, time_spent_seconds, attempt_number,
      session_id, adaptive_track,
      users!inner(display_name, email, student_profiles(grade, class_group))
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: true });
  if (access.mode === "class" && access.studentAllowlist) {
    submissionsQuery = submissionsQuery.in(
      "student_id",
      Array.from(access.studentAllowlist),
    );
  }
  submissionsQuery = scopeIds(submissionsQuery, "student_id", await getQaUserIds(), user.isQa);
  const { data: submissions, error: subError } = await submissionsQuery;
  if (subError) {
    console.error("[teacher/tests/export submissions]", subError);
    return NextResponse.json({ error: "Failed to load submissions" }, { status: 500 });
  }

  type RawSub = {
    id: string;
    student_id: string;
    status: string;
    correct_count: number | null;
    total_questions: number | null;
    percentage: number | string | null;
    scaled_score: number | null;
    submitted_at: string | null;
    time_spent_seconds: number | null;
    attempt_number: number | null;
    session_id: string | null;
    adaptive_track: string | null;
    users: {
      display_name: string;
      email: string;
      student_profiles?: { grade?: string; class_group?: string } | { grade?: string; class_group?: string }[] | null;
    };
  };
  const subs = (submissions ?? []) as unknown as RawSub[];

  // One row per attempt: two-module attempts share a session_id (same
  // grouping as the results page).
  const attempts = new Map<string, RawSub[]>();
  for (const s of subs) {
    const key = s.session_id ?? `solo:${s.id}`;
    attempts.set(key, [...(attempts.get(key) ?? []), s]);
  }

  const answerMap: Record<string, string> = {}; // `${submissionId}:${questionId}` → answer
  const subIds = subs.map((s) => s.id);
  if (subIds.length > 0) {
    const { data: answerRecords, error: arError } = await db
      .from("answer_records")
      .select("submission_id, question_id, student_answer")
      .in("submission_id", subIds);
    if (arError) {
      console.error("[teacher/tests/export answers]", arError);
      return NextResponse.json({ error: "Failed to load answers" }, { status: 500 });
    }
    for (const ar of answerRecords ?? []) {
      answerMap[`${ar.submission_id}:${ar.question_id}`] = ar.student_answer ?? "";
    }
  }

  // Unique question headers ("M1-Q1", "M2-Q1"; plain "Q1" for one module).
  const seen = new Map<string, number>();
  const qHeaders = questionList.map((q) => {
    const prefix = q.module_id ? modulePrefix.get(q.module_id) : undefined;
    const base = `${prefix ? `${prefix}-` : ""}Q${q.original_question_number}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });

  const lines: string[] = [
    csvRow([
      "Student", "Email", "Grade", "Class", "Attempt", "Status", "Correct", "Total",
      "Percentage", "Est. Scaled Score", "Time Spent", "Submitted At", ...qHeaders,
    ]),
  ];

  for (const rows of attempts.values()) {
    const sorted = [...rows].sort((a, b) => {
      const r = (t: string | null) => (t === "module_1" ? 0 : 1);
      return r(a.adaptive_track) - r(b.adaptive_track);
    });
    const head = sorted[0];
    const spRaw = head.users.student_profiles ?? null;
    const sp = (Array.isArray(spRaw) ? spRaw[0] : spRaw) as { grade?: string; class_group?: string } | null;

    const correct = sorted.reduce((n, r) => n + (r.correct_count ?? 0), 0);
    const total = sorted.reduce((n, r) => n + (r.total_questions ?? 0), 0);
    const time = sorted.reduce((n, r) => n + (r.time_spent_seconds ?? 0), 0);
    const pct = sorted.length > 1
      ? total > 0 ? (correct / total) * 100 : null
      : head.percentage != null ? Number(head.percentage) : null;
    const scaled = sorted.length === 1 && head.scaled_score != null
      ? head.scaled_score
      : pct != null ? scaleSectionScore(pct) : null;
    const statuses = sorted.map((r) => r.status);
    const status = statuses.includes("In Progress")
      ? "In Progress"
      : statuses.includes("Late")
      ? "Late"
      : statuses[statuses.length - 1] ?? "";
    const submittedAt = sorted
      .map((r) => r.submitted_at)
      .filter((d): d is string => !!d)
      .sort()
      .pop();

    lines.push(csvRow([
      head.users.display_name ?? "",
      head.users.email ?? "",
      sp?.grade ?? "",
      sp?.class_group ?? "",
      head.attempt_number ?? 1,
      status,
      correct,
      total,
      pct != null ? `${pct.toFixed(1)}%` : "",
      scaled ?? "",
      sorted.some((r) => r.time_spent_seconds != null) ? `${Math.floor(time / 60)}m ${time % 60}s` : "",
      submittedAt ? new Date(submittedAt).toISOString() : "",
      ...questionList.map((q) => {
        for (const r of sorted) {
          const v = answerMap[`${r.id}:${q.id}`];
          if (v !== undefined) return v;
        }
        return "";
      }),
    ]));
  }

  // BOM so Excel opens UTF-8 (Chinese names) correctly.
  return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${test.test_name.replace(/[^a-z0-9]/gi, "_")}-results.csv"`,
    },
  });
}

// Quote every cell, and neutralise spreadsheet formula injection: a value
// starting with = + - @ (or tab / CR) is prefixed with ' so Excel/Sheets
// treat it as text. Plain numbers / fractions (e.g. a "-3/4" grid-in
// answer) are left alone.
function csvCell(value: string | number): string {
  let v = String(value);
  if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?(\/\d+)?$/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

function csvRow(cells: (string | number)[]): string {
  return cells.map(csvCell).join(",");
}
