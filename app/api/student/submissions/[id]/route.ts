import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import {
  applyQuestionMeta,
  mergeAnswers,
  moduleDeadlineMs,
  moduleRemainingSeconds,
  moduleStartedAtIso,
  moduleTimeLimitMinutes,
  isModule2Track,
  sanitizeClientMetadata,
  scopeToStudentQuestionSet,
  stampModule2Start,
} from "@/lib/student-exam";

// Autosave retries its optimistic write up to 3 times; give a slow
// database moment room instead of the default limit.
export const maxDuration = 60;

function pickQuestionMeta(meta: Record<string, unknown>) {
  return { flagged: meta.flagged ?? [], crossed_out: meta.crossed_out ?? {}, annotations: meta.annotations ?? {} };
}

// GET /api/student/submissions/[id] — get submission state for resume
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  const db = getServiceClient();

  // ?status=1 — cheap "did my submit land?" probe the take page polls
  // while a submit is in flight, so a lost submit response can't strand
  // the student on "Submitting…".
  if (new URL(req.url).searchParams.get("status") === "1") {
    const { data: row } = await db
      .from("submissions")
      .select(
        "status, submitted_at, adaptive_track, session_id, started_at, metadata, tests!inner(time_limit_minutes, time_limit_minutes_module_2, is_untimed)",
      )
      .eq("id", id)
      .eq("student_id", user.userId)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: "Submission not found" }, { status: 404 });
    // "ready" = safe to leave the page. Module 1 is claimed (status flips)
    // before grading and the Module 2 insert, so also wait for the Module 2
    // row — leaving earlier would land on the test page instead of Module 2.
    // No Module 2 after 15 s means this test has none (or the handoff
    // failed and the test page takes over).
    let ready = row.status !== "In Progress";
    if (ready && row.adaptive_track === "module_1" && row.session_id) {
      const { count } = await db
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("session_id", row.session_id)
        .eq("student_id", user.userId)
        .neq("adaptive_track", "module_1");
      const ageMs = row.submitted_at ? Date.now() - new Date(row.submitted_at).getTime() : Infinity;
      ready = (count ?? 0) > 0 || ageMs > 15_000;
    }
    // The take page asks this before auto-submitting at 0:00, so time an
    // admin added mid-exam is honoured (D-20261104-3).
    const remainingSeconds =
      row.status === "In Progress"
        ? moduleRemainingSeconds(row, row.tests as unknown as Parameters<typeof moduleRemainingSeconds>[1])
        : null;
    return NextResponse.json({ data: { status: row.status, ready, remainingSeconds } });
  }

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
  // Extended time (metadata.time_multiplier) included; none on section tests.
  const limitMinutes = moduleTimeLimitMinutes(test, submission.adaptive_track, submission.metadata) ?? 35;
  const startIso = moduleStartedAtIso(submission);
  const elapsedSeconds = startIso
    ? Math.floor((Date.now() - new Date(startIso).getTime()) / 1000)
    : 0;
  const timeRemainingSeconds = Math.max(0, Math.round(limitMinutes * 60) - elapsedSeconds);

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
    questionMeta?: Record<string, unknown>;
    clientId?: unknown;
    clientSeq?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.answers !== undefined && (body.answers === null || typeof body.answers !== "object")) {
    return NextResponse.json({ error: "answers must be an object" }, { status: 400 });
  }
  // No real answer is anywhere near this long (MC letters, ≤ 7-char grid-ins);
  // refuse crafted payloads before they reach grading.
  if (
    body.answers &&
    Object.values(body.answers).some((v) => typeof v === "string" && v.length > 200)
  ) {
    return NextResponse.json({ error: "answer too long" }, { status: 400 });
  }
  const mergeMode = body.answersMode === "merge";
  const clientMetadata =
    body.metadata && typeof body.metadata === "object"
      ? sanitizeClientMetadata(body.metadata)
      : undefined;
  // Write ordering per device: the take page can have a keepalive flush and
  // a regular save in flight at once, and the older one may arrive last.
  // metadata.client_save_seq maps clientId -> newest clientSeq applied; an
  // older-or-equal seq from the same client is acknowledged but not
  // written, so it can't revert a newer answer. Requests without them
  // (older clients) behave as before.
  const clientId =
    typeof body.clientId === "string" && body.clientId.length > 0 && body.clientId.length <= 64
      ? body.clientId
      : null;
  const clientSeq =
    typeof body.clientSeq === "number" && Number.isFinite(body.clientSeq) ? body.clientSeq : null;
  if (clientMetadata) delete clientMetadata.client_save_seq;

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
      .maybeSingle();

    // A read failure is transient (the client retries); a missing row means
    // the exam was deleted (e.g. by an admin) and no retry will bring it
    // back — the take page stops saving and tells the student.
    if (fetchError) {
      console.error("[student/submissions/patch] read", fetchError);
      return NextResponse.json({ error: "Failed to save" }, { status: 500 });
    }
    if (!submission) {
      return NextResponse.json({ error: "Submission not found", code: "submission_gone" }, { status: 404 });
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

    const seqByClient =
      savedMeta.client_save_seq && typeof savedMeta.client_save_seq === "object"
        ? (savedMeta.client_save_seq as Record<string, number>)
        : {};
    if (clientId && clientSeq != null) {
      const applied = seqByClient[clientId];
      if (typeof applied === "number" && clientSeq <= applied) {
        // The server already holds a newer save from this device.
        return NextResponse.json({ success: true, stale: true, remainingSeconds: moduleRemainingSeconds(submission, timing) });
      }
    }

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
      ...(body.questionMeta && typeof body.questionMeta === "object"
        ? applyQuestionMeta(savedMeta, body.questionMeta)
        : {}),
      answers_version: version + 1,
      ...(clientId && clientSeq != null
        ? { client_save_seq: { ...seqByClient, [clientId]: clientSeq } }
        : {}),
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
      // The merged answers, so a device that was offline can show answers
      // the student changed on another device since.
      return NextResponse.json({
        success: true,
        answers: updates.answers ?? submission.answers ?? {},
        remainingSeconds: moduleRemainingSeconds(submission, timing),
        // Same for flags / cross-outs / highlights.
        questionMeta: pickQuestionMeta(updates.metadata as Record<string, unknown>),
      });
    }
    // Lost the race (another save bumped the version, or the row was
    // finalized) — loop re-reads and re-applies on fresh state.
  }

  console.error("[student/submissions/patch] version conflict after retries", id);
  return NextResponse.json({ error: "save_conflict" }, { status: 409 });
}
