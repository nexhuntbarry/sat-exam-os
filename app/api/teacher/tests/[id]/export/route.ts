import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import { getTeacherTestAccess, getTestSections } from "@/lib/teacher-access";
import { attemptScore } from "@/lib/score-display";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { studentClassNames } from "@/lib/result-printout";
import { fullLengthLinks, type FullLengthChildren } from "@/lib/full-length";
import { flCsvHeader, flCsvOrder, flCsvQuestionColumns, flCsvRow, flSectionScope } from "@/lib/full-length-score";
import { STUDENT_VISIBLE_QUESTION_STATUS } from "@/lib/student-exam";
import { loadFullLengthResults } from "@/lib/full-length-results";

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

  // Full-length SAT parent: its own columns (plan Phase 3).
  const flKids = (await fullLengthLinks(db)).childrenOf.get(testId);
  if (flKids) return fullLengthCsv(db, user, testId, flKids, access.mode === "class" ? access.studentAllowlist : null);

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
      users!inner(display_name, email, student_profiles(grade))
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
      student_profiles?: { grade?: string } | { grade?: string }[] | null;
    };
  };
  const subs = (submissions ?? []) as unknown as RawSub[];
  // Class = class_group_members (same as the class page); a teacher sees
  // only their own classes' names.
  const classOf = await studentClassNames(db, user, Array.from(new Set(subs.map((s) => s.student_id))));

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
    const { data: answerRecords, error: arError } = await fetchAllRows<{
      submission_id: string;
      question_id: string;
      student_answer: string | null;
    }>((from, to) =>
      db
        .from("answer_records")
        .select("submission_id, question_id, student_answer")
        .in("submission_id", subIds)
        .order("id")
        .range(from, to),
    );
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

  // Same score rules as the screens (lib/score-display): SAT section score
  // only once every module is in, per-module "correct / total", % correct
  // as a plain number. No per-module SAT. Counts are written "22 / 27" so
  // Excel/Sheets don't turn them into dates.
  const twoModules = Boolean(test.is_adaptive || test.module_2_id);
  const section = (await getTestSections(db, [testId])).get(testId) ?? null;
  const lines: string[] = [
    csvRow([
      "Student", "Email", "Grade", "Class", "Attempt", "Status", "SAT Score",
      ...(twoModules ? ["M1 Correct", "M2 Correct"] : ["Correct"]),
      "% Correct", "Time Spent", "Submitted At", ...qHeaders,
    ]),
  ];

  for (const rows of attempts.values()) {
    const sorted = [...rows].sort((a, b) => {
      const r = (t: string | null) => (t === "module_1" ? 0 : 1);
      return r(a.adaptive_track) - r(b.adaptive_track);
    });
    const head = sorted[0];
    const spRaw = head.users.student_profiles ?? null;
    const sp = (Array.isArray(spRaw) ? spRaw[0] : spRaw) as { grade?: string } | null;

    const time = sorted.reduce((n, r) => n + (r.time_spent_seconds ?? 0), 0);
    const { status, score, modules } = attemptScore(sorted, section);
    const moduleCells = (twoModules ? [1, 2] : [1]).map((n) => {
      const m = modules[n - 1];
      return m && m.graded ? `${m.correct ?? 0} / ${m.total ?? 0}` : "";
    });
    const submittedAt = sorted
      .map((r) => r.submitted_at)
      .filter((d): d is string => !!d)
      .sort()
      .pop();

    lines.push(csvRow([
      head.users.display_name ?? "",
      head.users.email ?? "",
      sp?.grade ?? "",
      classOf.get(head.student_id) ?? "",
      head.attempt_number ?? 1,
      status,
      score?.sat ?? "",
      ...moduleCells,
      score?.pct ?? "",
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

type Db = ReturnType<typeof getServiceClient>;

/**
 * Full-length SAT CSV: one row per attempt with the total, both sections,
 * each module's correct count and Module 2 track, extended time, then one
 * column per question like the section export (RW M1 Q1 … Math M2 Hard
 * Q22). A teacher scoped to one subject gets the total plus their own
 * section's columns only.
 */
async function fullLengthCsv(
  db: Db,
  user: { userId: string; role: string | null | undefined; isQa: boolean },
  testId: string,
  kids: FullLengthChildren,
  studentAllowlist: Set<string> | null,
): Promise<Response> {
  const childIds = [kids.rw, kids.math].filter((x): x is string => Boolean(x));
  const [{ data: test }, { data: childTests }, scope, attempts] = await Promise.all([
    db.from("tests").select("id, test_name").eq("id", testId).single(),
    db
      .from("tests")
      .select("id, is_adaptive, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id")
      .in("id", childIds),
    flSectionScope(db, user, kids),
    loadFullLengthResults(db, testId, kids, { studentAllowlist, isQa: user.isQa }),
  ]);
  if (!test) return NextResponse.json({ error: "Not found" }, { status: 404 });

  type Child = { id: string; is_adaptive: boolean | null; module_id: string | null; module_2_id: string | null; module_1_id: string | null; module_2_easy_id: string | null; module_2_hard_id: string | null };
  const children = (childTests ?? []) as Child[];
  // Module slots in test order, prefixed like the section export
  // ("RW M1", "RW M2 Easy", "RW M2 Hard", "Math M1", …).
  const moduleSlots = (child: Child | undefined, section: "rw" | "math", name: string) => {
    if (!child) return [];
    const slots = child.is_adaptive
      ? [
          { id: child.module_1_id, prefix: `${name} M1` },
          { id: child.module_2_easy_id, prefix: `${name} M2 Easy` },
          { id: child.module_2_hard_id, prefix: `${name} M2 Hard` },
        ]
      : [
          { id: child.module_id, prefix: `${name} M1` },
          { id: child.module_2_id, prefix: `${name} M2` },
        ];
    return slots.filter((m): m is { id: string; prefix: string } => Boolean(m.id)).map((m) => ({ ...m, section }));
  };
  const modules = [
    ...moduleSlots(children.find((c) => c.id === kids.rw), "rw", "RW"),
    ...moduleSlots(children.find((c) => c.id === kids.math), "math", "Math"),
  ];
  const moduleIds = modules.map((m) => m.id);

  // Answers of the attempts' rows.
  const rowIds = attempts.flatMap((a) => [...a.rw, ...a.math].map((r) => r.id));
  const answerMap = new Map<string, string>();
  const answeredIds = new Set<string>();
  if (rowIds.length > 0) {
    const { data: answerRecords, error } = await fetchAllRows<{ submission_id: string; question_id: string; student_answer: string | null }>(
      (from, to) =>
        db
          .from("answer_records")
          .select("submission_id, question_id, student_answer")
          .in("submission_id", rowIds)
          .order("id")
          .range(from, to),
    );
    if (error) {
      console.error("[teacher/tests/export answers]", error);
      return NextResponse.json({ error: "Failed to load answers" }, { status: 500 });
    }
    for (const ar of answerRecords ?? []) {
      answerMap.set(`${ar.submission_id}:${ar.question_id}`, ar.student_answer ?? "");
      answeredIds.add(ar.question_id);
    }
  }

  // Question columns: the student-visible (Approved) questions of each
  // module, plus any question these attempts were graded on (a question
  // demoted after the fact keeps its answers in the export).
  let questionRows: { id: string; module_id: string; original_question_number: number | null; parsing_status: string | null }[] = [];
  if (moduleIds.length > 0) {
    const { data: qs, error } = await db
      .from("questions")
      .select("id, module_id, original_question_number, parsing_status")
      .in("module_id", moduleIds);
    if (error) {
      console.error("[teacher/tests/export questions]", error);
      return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
    }
    questionRows = (qs ?? []) as typeof questionRows;
  }
  const questions = flCsvQuestionColumns(
    modules.map((m) => ({
      section: m.section,
      prefix: m.prefix,
      questions: questionRows
        .filter((q) => q.module_id === m.id && (q.parsing_status === STUDENT_VISIBLE_QUESTION_STATUS || answeredIds.has(q.id)))
        .map((q) => ({ id: q.id, n: q.original_question_number ?? 0 })),
    })),
  );

  const classOf = await studentClassNames(db, user, Array.from(new Set(attempts.map((a) => a.studentId))));
  const lines = [csvRow(flCsvHeader(scope, questions))];
  // Finished attempts oldest first, then unfinished ones.
  const ordered = flCsvOrder(
    attempts.map((a) => ({
      ...a,
      startedAt: [...a.rw, ...a.math].map((r) => r.started_at ?? "").filter(Boolean).sort()[0] ?? null,
    })),
  );
  for (const a of ordered) {
    lines.push(
      csvRow(
        flCsvRow(
          {
            studentName: a.studentName,
            email: a.email,
            grade: a.grade ?? "",
            className: classOf.get(a.studentId) ?? "",
            attemptNumber: a.attemptNumber,
            score: a.score,
            multiplier: a.multiplier,
            timeSeconds: a.timeSeconds,
            submittedAt: a.submittedAt,
            rowIds: [...a.rw, ...a.math].map((r) => r.id),
            answers: answerMap,
          },
          scope,
          questions,
        ),
      ),
    );
  }

  return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${(test.test_name as string).replace(/[^a-z0-9]/gi, "_")}-results.csv"`,
    },
  });
}
