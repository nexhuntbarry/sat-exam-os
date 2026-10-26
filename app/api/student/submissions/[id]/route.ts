import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import {
  mergeAnswers,
  moduleDeadlineMs,
  moduleStartedAtIso,
  moduleTimeLimitMinutes,
  isModule2Track,
  sanitizeClientMetadata,
  scopeToStudentQuestionSet,
  stampModule2Start,
} from "@/lib/student-exam";

// GET /api/student/submissions/[id] — get submission state for resume
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data: submission, error } = await db
    .from("submissions")
    .select(`
      id, test_id, student_id, answers, status, started_at, submitted_at,
      time_spent_seconds, attempt_number, metadata, module_id, adaptive_track,
      tests!inner(
        id, test_name, module_id, time_limit_minutes, time_limit_minutes_module_2, is_untimed, due_date, show_answers_after_submission,
        is_adaptive, question_ids,
        modules!module_id(module_name, section)
      )
    `)
    .eq("id", id)
    .eq("student_id", user.userId)
    .single();

  if (error || !submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  // Fetch questions for this submission's module. For adaptive tests
  // submission.module_id is the chosen Module 1 / Module 2 slot; for
  // legacy tests it falls back to tests.module_id.
  const test = submission.tests as unknown as {
    module_id: string | null;
    time_limit_minutes: number | null;
    time_limit_minutes_module_2?: number | null;
    is_untimed?: boolean | null;
    question_ids?: string[] | null;
    is_adaptive?: boolean | null;
  };
  const gradingModuleId = submission.module_id ?? test.module_id;
  if (!gradingModuleId) {
    return NextResponse.json({ error: "Submission has no module" }, { status: 500 });
  }
  const { data: questions } = await scopeToStudentQuestionSet(
    db
      .from("questions")
      // SECURITY: correct_answer MUST NOT be returned during an active
      // exam. Students consume this endpoint to resume their test; any
      // field they fetch is visible in DevTools. The post-submit review
      // page reads correct_answer from submission_answers on its own
      // server-rendered path.
      .select("id, original_question_number, question_text, choices, question_type, has_image, has_table, source_pdf_url, section, domain, skill, difficulty")
      .eq("module_id", gradingModuleId),
    // Same Approved-only set the take page shows and submit grades.
    test,
  ).order("original_question_number", { ascending: true });

  // Handing out Module 2's questions opens it: start the clock now if it
  // never started, so this endpoint can't be used to read an unstamped
  // Module 2 with no time limit.
  if (
    submission.status === "In Progress" &&
    isModule2Track(submission.adaptive_track) &&
    !moduleStartedAtIso(submission)
  ) {
    submission.metadata = await stampModule2Start(db, submission.id, submission.metadata);
  }

  // Time remaining, measured from the module's real start (Module 2:
  // when it was first opened) — the same clock the take page, cron and
  // autosave deadline use.
  const limitMinutes = moduleTimeLimitMinutes(test, submission.adaptive_track) ?? 35;
  const startIso = moduleStartedAtIso(submission);
  const elapsedSeconds = startIso
    ? Math.floor((Date.now() - new Date(startIso).getTime()) / 1000)
    : 0;
  const timeRemainingSeconds = Math.max(0, limitMinutes * 60 - elapsedSeconds);

  return NextResponse.json({
    data: {
      ...submission,
      questions: questions ?? [],
      timeRemainingSeconds,
    },
  });
}

// PATCH /api/student/submissions/[id] — auto-save answers
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;

  let body: {
    answers?: Record<string, string | null>;
    answersMode?: string;
    metadata?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.answers !== undefined && (body.answers === null || typeof body.answers !== "object")) {
    return NextResponse.json({ error: "answers must be an object" }, { status: 400 });
  }
  const mergeMode = body.answersMode === "merge";
  const clientMetadata =
    body.metadata && typeof body.metadata === "object"
      ? sanitizeClientMetadata(body.metadata)
      : undefined;

  const db = getServiceClient();

  // Read-modify-write guarded by an optimistic version stored in
  // metadata.answers_version (no DDL available for a real column or an
  // RPC). The UPDATE only lands if the version is still the one we read,
  // so two tabs/devices saving at once can't silently drop each other's
  // answers (merge mode) or metadata; on a conflict we re-read and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: submission, error: fetchError } = await db
      .from("submissions")
      .select(
        "id, student_id, status, answers, metadata, started_at, adaptive_track, tests!inner(time_limit_minutes, time_limit_minutes_module_2, is_untimed)",
      )
      .eq("id", id)
      .eq("student_id", user.userId)
      .single();

    if (fetchError || !submission) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 });
    }

    if (submission.status !== "In Progress") {
      return NextResponse.json({ error: "Submission is not in progress" }, { status: 400 });
    }

    // Server-side time limit: past limit + grace nothing more is saved.
    const timing = submission.tests as unknown as {
      time_limit_minutes: number | null;
      time_limit_minutes_module_2: number | null;
      is_untimed: boolean | null;
    };
    const deadline = moduleDeadlineMs(submission, timing);
    if (deadline != null && Date.now() > deadline) {
      return NextResponse.json({ error: "time_up" }, { status: 409 });
    }

    const savedMeta = (submission.metadata ?? {}) as Record<string, unknown>;
    const version = typeof savedMeta.answers_version === "number" ? savedMeta.answers_version : 0;

    const updates: Record<string, unknown> = {};
    if (body.answers !== undefined) {
      const patch = body.answers as Record<string, string | null>;
      updates.answers = mergeMode
        ? mergeAnswers((submission.answers ?? {}) as Record<string, string>, patch)
        : mergeAnswers({}, patch);
    }
    // Merge rather than replace: the client only sends tab_switches +
    // annotations, and a blind overwrite wiped the server-stamped
    // module_2_started_at — so a refresh mid-Module 2 restarted its timer.
    updates.metadata = {
      ...savedMeta,
      ...(clientMetadata ?? {}),
      answers_version: version + 1,
    };
    // Saving answers on a Module 2 whose clock never started (client
    // skipped the intro / ?start=1, or a direct API call) starts it now,
    // in this same guarded write — an unstamped Module 2 must not mean
    // unlimited time.
    if (
      body.answers !== undefined &&
      isModule2Track(submission.adaptive_track) &&
      !moduleStartedAtIso(submission)
    ) {
      (updates.metadata as Record<string, unknown>).module_2_started_at = new Date().toISOString();
    }

    let q = db
      .from("submissions")
      .update(updates)
      .eq("id", id)
      .eq("status", "In Progress");
    q = version === 0
      ? q.is("metadata->answers_version", null)
      : q.eq("metadata->answers_version", version);
    const { data: written, error } = await q.select("id");
    if (error) {
      console.error("[student/submissions/patch]", error);
      return NextResponse.json({ error: "Failed to save" }, { status: 500 });
    }
    if (written && written.length > 0) {
      return NextResponse.json({ success: true });
    }
    // Lost the race (another save bumped the version, or the row was
    // finalized) — loop re-reads and re-applies on fresh state.
  }

  console.error("[student/submissions/patch] version conflict after retries", id);
  return NextResponse.json({ error: "save_conflict" }, { status: 409 });
}
