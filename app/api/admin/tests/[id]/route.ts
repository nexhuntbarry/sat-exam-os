import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide, getQaClassGroupIds, onSide } from "@/lib/qa";
import {
  FL_SECTIONS,
  breakMinutesError,
  childTestName,
  fullLengthPublishModules,
  kindChangeError,
  loadChildTests,
  type FlSectionKey,
} from "@/lib/full-length-admin";
import {
  TEST_STATUSES,
  dateOrderError,
  moduleApprovalError,
  moduleSetError,
  parseTimestamp,
  roleError,
  testNameError,
  thresholdError,
  timeLimitError,
} from "../../_shared";
import { testHasSubmissions } from "@/lib/test-readiness";

// GET /api/admin/tests/[id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;
  const db = getServiceClient();

  const { data: test, error } = await db
    .from("tests")
    .select(`
      id, test_name, module_id, time_limit_minutes, open_date, due_date,
      show_answers_after_submission, allow_retake, status, question_ids,
      created_by, created_at, updated_at,
      is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, adaptive_threshold,
      desmos_enabled, formula_sheet_url,
      modules!module_id(module_name, section, module_number, source_name)
    `)
    .eq("id", id)
    .single();

  if (error || !test) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids, student_ids, class_group_ids")
    .eq("test_id", id)
    .single();

  const { data: submissions } = await db
    .from("submissions")
    .select("id, student_id, status, score, correct_count, total_questions, percentage, started_at, submitted_at, time_spent_seconds, attempt_number")
    .eq("test_id", id)
    .order("submitted_at", { ascending: false });

  return NextResponse.json({
    data: {
      ...test,
      assignment: assignment ?? { teacher_ids: [], student_ids: [], class_group_ids: [] },
      submissions: submissions ?? [],
    },
  });
}

/** Atomically adds/removes ids from a jsonb string-array column via compare-and-swap.
 * Retries up to 5 times on CAS conflict (concurrent writer changed the value).
 * Returns {message, status} on failure, null on success. */
async function casArrayOp(
  db: ReturnType<typeof getServiceClient>,
  testId: string,
  jsonField: "class_group_ids" | "student_ids",
  toAdd: string[],
  toRemove: Set<string>,
): Promise<{ message: string; status: number } | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await db
      .from("test_assignments")
      .select(jsonField)
      .eq("test_id", testId)
      .maybeSingle();
    if (readErr) return { message: "Could not read test assignment", status: 500 };
    if (!row) return { message: "Test assignment not found", status: 404 };
    const rowRecord = row as Record<string, unknown>;
    const old: string[] = Array.isArray(rowRecord[jsonField]) ? (rowRecord[jsonField] as string[]) : [];
    const next = [...new Set([...old.filter((v) => !toRemove.has(v)), ...toAdd])];
    if (JSON.stringify(old) === JSON.stringify(next)) return null; // no-op
    // CAS: only commit if no concurrent writer changed the field between read and write.
    const { data: updated, error: updErr } = await db
      .from("test_assignments")
      .update({ [jsonField]: next })
      .eq("test_id", testId)
      .filter(jsonField, "eq", JSON.stringify(old))
      .select("test_id");
    // A real write error is not a conflict — report it instead of retrying.
    if (updErr) return { message: `Assignment update failed: ${updErr.message}`, status: 500 };
    if ((updated ?? []).length > 0) return null; // committed
    if (attempt < 4) await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
  }
  return { message: "Concurrent update conflict — please retry", status: 409 };
}

// PATCH /api/admin/tests/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const linkCheck = await forbidCrossSide(authResult, {
    userIds: [
      ...(Array.isArray(body.teacherIds) ? (body.teacherIds as string[]) : []),
      ...(Array.isArray(body.studentIds) ? (body.studentIds as string[]) : []),
    ],
    classGroupIds: [
      ...(Array.isArray(body.classGroupIds) ? (body.classGroupIds as string[]) : []),
      ...(Array.isArray(body.addClassGroupIds) ? (body.addClassGroupIds as string[]) : []),
    ],
  });
  if (linkCheck) return linkCheck;

  const db = getServiceClient();
  const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

  const { data: current } = await db
    .from("tests")
    .select("is_adaptive, status, open_date, due_date, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, test_kind, parent_test_id")
    .eq("id", id)
    .maybeSingle();
  if (!current) return bad("Test not found", 404);

  // A full-length SAT section is edited through its parent test. Decided
  // from the row itself (migration 0031 columns).
  if (current.parent_test_id || current.test_kind === "fl_section") {
    return bad("This is a section of a full-length SAT — edit the full-length test instead.", 409);
  }
  const isFullLength = current.test_kind === "full_length";
  const kindErr = kindChangeError(isFullLength ? "full_length" : "section", body.testKind, isFullLength);
  if (kindErr) return bad(kindErr, 409);
  if (isFullLength) {
    // Modules come from the sections (change them with Re-sync), and time
    // limits are per section.
    const sectionOnly = [
      "moduleId", "module2Id", "module1Id", "module2EasyId", "module2HardId",
      "adaptiveThreshold", "questionIds", "desmosEnabled", "formulaSheetUrl",
      "timeLimitMinutes", "timeLimitMinutesModule2",
    ].filter((k) => body[k] !== undefined);
    if (sectionOnly.length > 0) {
      return bad(`Not editable on a full-length test: ${sectionOnly.join(", ")}. Use Re-sync to change the source tests.`);
    }
  }

  // classGroupIds (full replacement) is mutually exclusive with add/remove delta fields.
  if (
    body.classGroupIds !== undefined &&
    (body.addClassGroupIds !== undefined || body.removeClassGroupIds !== undefined)
  ) {
    return bad("classGroupIds and addClassGroupIds/removeClassGroupIds are mutually exclusive");
  }


  const updates: Record<string, unknown> = {};

  // Same field rules as POST /api/admin/tests.
  if (body.testName !== undefined) {
    const err = testNameError(body.testName);
    if (err) return bad(err);
    updates.test_name = String(body.testName).trim();
  }
  if (body.timeLimitMinutes !== undefined) {
    const err = timeLimitError(body.timeLimitMinutes, "Time limit");
    if (err) return bad(err);
    updates.time_limit_minutes = body.timeLimitMinutes;
  }
  if (body.timeLimitMinutesModule2 !== undefined) {
    const err = timeLimitError(body.timeLimitMinutesModule2, "Module 2 time limit");
    if (err) return bad(err);
    updates.time_limit_minutes_module_2 = body.timeLimitMinutesModule2;
  }
  if (body.openDate !== undefined) {
    const { value, error } = parseTimestamp(body.openDate, "Open date");
    if (error) return bad(error);
    updates.open_date = value;
  }
  if (body.dueDate !== undefined) {
    const { value, error } = parseTimestamp(body.dueDate, "Due date");
    if (error) return bad(error);
    updates.due_date = value;
  }
  if (body.openDate !== undefined || body.dueDate !== undefined) {
    const err = dateOrderError(
      (body.openDate !== undefined ? updates.open_date : current.open_date) as string | null,
      (body.dueDate !== undefined ? updates.due_date : current.due_date) as string | null,
    );
    if (err) return bad(err);
  }
  if (body.showAnswersAfterSubmission !== undefined) updates.show_answers_after_submission = body.showAnswersAfterSubmission;
  if (body.allowRetake !== undefined) updates.allow_retake = body.allowRetake;
  if (body.status !== undefined) {
    if (!TEST_STATUSES.includes(body.status as (typeof TEST_STATUSES)[number])) {
      return bad(`Status must be one of ${TEST_STATUSES.join(", ")}`);
    }
    updates.status = body.status;
    // Same rule as POST …/draft: back to Draft only while nobody started.
    if (body.status === "Draft" && current.status !== "Draft") {
      let started: boolean;
      try {
        let flChildIds: string[] | null = null;
        if (isFullLength) {
          const { children, error: loadErr } = await loadChildTests(db, id);
          if (loadErr) throw new Error(loadErr);
          flChildIds = Object.values(children).flatMap((c) => (c ? [c.id] : []));
        }
        started = await testHasSubmissions(db, id, flChildIds);
      } catch {
        return bad("Could not check for submissions", 500);
      }
      if (started) return bad("Students have already started this test, so it can't go back to Draft. Close it instead.", 409);
    }
  }
  // Full-length only: break and pause. Attempts already running keep the
  // values they started with (snapshotted on full_length_attempts).
  if (isFullLength && body.breakMinutes !== undefined) {
    const err = breakMinutesError(body.breakMinutes);
    if (err) return bad(err);
    if (body.breakMinutes === null) return bad("Break minutes are required");
    updates.break_minutes = body.breakMinutes;
  }
  if (isFullLength && body.allowSectionPause !== undefined) updates.allow_section_pause = body.allowSectionPause === true;
  // Full-length only: per-section module time limits, written to the sections.
  const childUpdates: Record<FlSectionKey, Record<string, unknown>> = { rw: {}, math: {} };
  if (isFullLength) {
    for (const s of FL_SECTIONS) {
      for (const [field, col, label] of [
        [`${s.key}TimeLimitMinutes`, "time_limit_minutes", "Module 1 time limit"],
        [`${s.key}TimeLimitMinutesModule2`, "time_limit_minutes_module_2", "Module 2 time limit"],
      ] as const) {
        if (body[field] === undefined) continue;
        const err = timeLimitError(body[field], `${s.label} ${label}`);
        if (err) return bad(err);
        if (body[field] === null) return bad(`${s.label} ${label} is required`);
        childUpdates[s.key][col] = body[field];
      }
      if (typeof updates.test_name === "string") {
        childUpdates[s.key].test_name = childTestName(updates.test_name, s.key);
      }
    }
  }
  if (body.questionIds !== undefined) updates.question_ids = body.questionIds;
  if (body.desmosEnabled !== undefined) updates.desmos_enabled = Boolean(body.desmosEnabled);
  if (body.formulaSheetUrl !== undefined) updates.formula_sheet_url = body.formulaSheetUrl;
  if (body.adaptiveThreshold !== undefined) {
    const err = thresholdError(body.adaptiveThreshold);
    if (err) return bad(err);
    updates.adaptive_threshold = body.adaptiveThreshold;
  }

  // Module swaps. is_adaptive is intentionally NOT mutable here — once
  // a test is created adaptive vs non-adaptive, switching mid-stream
  // would orphan existing submissions whose adaptive_track/session_id
  // were keyed on the original mode. Admins who need a different mode
  // create a new test.
  const moduleFields = {
    moduleId: "module_id",
    module2Id: "module_2_id",
    module1Id: "module_1_id",
    module2EasyId: "module_2_easy_id",
    module2HardId: "module_2_hard_id",
  } as const;
  const next: Record<string, string | null> = {
    module_id: current.module_id,
    module_2_id: current.module_2_id,
    module_1_id: current.module_1_id,
    module_2_easy_id: current.module_2_easy_id,
    module_2_hard_id: current.module_2_hard_id,
  };
  let modulesChanged = false;
  for (const [key, col] of Object.entries(moduleFields)) {
    const v = body[key];
    if (v === undefined) continue;
    const value = v ? String(v) : null;
    if (value === next[col]) continue;
    next[col] = value;
    updates[col] = value;
    modulesChanged = true;
  }

  if (modulesChanged) {
    // Existing submissions (and their grades) point at the old module's
    // questions; swapping would make review, scores and new attempts
    // disagree. Force a new test instead.
    const { count } = await db
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("test_id", id);
    if ((count ?? 0) > 0) {
      return bad(
        "This test already has submissions, so its modules can't be changed. Create a new test with the modules you want instead.",
        409,
      );
    }

    if (current.is_adaptive) {
      if (!next.module_1_id) return bad("Adaptive test requires Module 1");
      if (!next.module_2_easy_id && !next.module_2_hard_id) {
        return bad("Adaptive test requires at least one Module 2 track (easy or hard)");
      }
      if (next.module_1_id === next.module_2_easy_id || next.module_1_id === next.module_2_hard_id) {
        return bad("Module 2 tracks must differ from Module 1");
      }
    } else {
      if (!next.module_id) return bad("A module is required");
      if (next.module_2_id && next.module_2_id === next.module_id) {
        return bad("Module 1 and Module 2 must be different");
      }
      // Single-module tests are valid (migration 0025), but clearing an
      // existing Module 2 is almost always an accident that leaves the
      // exam showing one module. Only block that transition.
      if (current.module_2_id && !next.module_2_id) {
        return bad(
          "This test already has a Module 2. Pick a replacement instead of clearing it, or create a single-module test.",
        );
      }
    }

    const ids = (current.is_adaptive
      ? [next.module_1_id, next.module_2_easy_id, next.module_2_hard_id]
      : [next.module_id, next.module_2_id]
    ).filter((x): x is string => Boolean(x));
    const err = (await moduleSetError(db, ids)) ?? (await moduleApprovalError(db, ids));
    if (err) return bad(err);
  }

  if (updates.status === "Published" && current.status !== "Published" && isFullLength) {
    // Every module of both sections must be fully approved.
    const { children, error: loadErr } = await loadChildTests(db, id);
    if (loadErr) return bad(loadErr, 500);
    const { moduleIds, error: shapeErr } = fullLengthPublishModules(children);
    const err = shapeErr ?? (await moduleApprovalError(db, moduleIds));
    if (err) return bad(err, 409);
  } else if (updates.status === "Published" && current.status !== "Published") {
    const ids = [
      next.module_id, next.module_2_id, next.module_1_id, next.module_2_easy_id, next.module_2_hard_id,
    ].filter((x): x is string => Boolean(x));
    if (ids.length === 0) return bad("This test has no modules, so it can't be published.", 409);
    const err = await moduleApprovalError(db, ids);
    if (err) return bad(err, 409);
  }

  const roleErr =
    (await roleError(db, Array.isArray(body.teacherIds) ? (body.teacherIds as string[]) : undefined, "teacher")) ??
    (await roleError(db, Array.isArray(body.studentIds) ? (body.studentIds as string[]) : undefined, "student"));
  if (roleErr) return bad(roleErr);

  // Sections first (time limits, names); the parent update below then
  // syncs their status, dates and answer settings (trigger).
  if (isFullLength) {
    for (const s of FL_SECTIONS) {
      if (Object.keys(childUpdates[s.key]).length === 0) continue;
      const { error } = await db
        .from("tests")
        .update({ ...childUpdates[s.key], updated_at: new Date().toISOString() })
        .eq("parent_test_id", id)
        .eq("section_order", s.order);
      if (error) {
        console.error("[admin/tests/patch] full-length section", error);
        return NextResponse.json({ error: "Failed to update the test sections" }, { status: 500 });
      }
    }
  }

  const testFieldsChanged = Object.keys(updates).length > 0;
  if (testFieldsChanged) {
    updates.updated_at = new Date().toISOString();
    const { error } = await db.from("tests").update(updates).eq("id", id);
    if (error) {
      console.error("[admin/tests/patch]", error);
      return NextResponse.json({ error: "Failed to update test" }, { status: 500 });
    }
  }

  // Update assignment if provided.
  // Full-replacement fields (teacherIds, studentIds, classGroupIds) write the
  // exact set provided.  Atomic add/remove fields (addClassGroupIds, removeClassGroupIds)
  // use compare-and-swap so concurrent callers never silently drop each other's changes.
  if (
    body.teacherIds !== undefined ||
    body.studentIds !== undefined ||
    body.classGroupIds !== undefined
  ) {
    const assignUpdates: Record<string, unknown> = {};
    if (body.teacherIds !== undefined) assignUpdates.teacher_ids = body.teacherIds;
    if (body.studentIds !== undefined) assignUpdates.student_ids = body.studentIds;
    if (body.classGroupIds !== undefined) assignUpdates.class_group_ids = body.classGroupIds;

    const { error: assignErr } = await db.from("test_assignments").update(assignUpdates).eq("test_id", id);
    if (assignErr) {
      console.error("[admin/tests/patch] assignment update:", assignErr);
      return NextResponse.json({ error: "Failed to update assignment" }, { status: 500 });
    }
  }

  // Atomic class-group add/remove — CAS loop so concurrent assign/unassign
  // operations never silently overwrite each other.
  if (body.addClassGroupIds !== undefined || body.removeClassGroupIds !== undefined) {
    const toAdd = Array.isArray(body.addClassGroupIds)
      ? (body.addClassGroupIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const toRemove = new Set(
      Array.isArray(body.removeClassGroupIds)
        ? (body.removeClassGroupIds as unknown[]).filter((v): v is string => typeof v === "string")
        : [],
    );

    // Additional cross-side guard for the ids being added.
    if (toAdd.length > 0) {
      const qaIds = await getQaClassGroupIds();
      const badId = toAdd.find((cgId) => !onSide(cgId, qaIds, authResult.isQa));
      if (badId) return bad("Cross-side class group assignment not allowed");
    }

    const casErr = await casArrayOp(db, id, "class_group_ids", toAdd, toRemove);
    if (casErr) return bad(casErr.message, casErr.status);

    // Write updated_at now that the CAS succeeded (skipped above when no test
    // fields changed so we don't timestamp a no-op before CAS).
    if (!testFieldsChanged) {
      await db.from("tests").update({ updated_at: new Date().toISOString() }).eq("id", id);
    }
  }

  return NextResponse.json({ success: true });
}

// DELETE /api/admin/tests/[id]
//
// Permanently removes a test plus everything that hangs off it
// (assignments, submissions, answer_records, retake grants). All those
// child tables already declare ON DELETE CASCADE on their test_id FK, so
// the row delete is enough.
//
// We intentionally allow deletion of Published tests too — the admin UI
// double-confirms, and there are legitimate "I created this in error,
// scrap it" cases. If we wanted a softer guarantee later, swap to a
// soft-delete flag on tests.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;
  const db = getServiceClient();

  const { data: target } = await db
    .from("tests")
    .select("id, test_name, test_kind, parent_test_id")
    .eq("id", id)
    .maybeSingle();
  if (!target) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }
  // A full-length SAT section is deleted with its parent (cascade).
  if (target.parent_test_id || target.test_kind === "fl_section") {
    return NextResponse.json(
      { error: "This is a section of a full-length SAT — delete the full-length test instead." },
      { status: 409 },
    );
  }

  const { error } = await db.from("tests").delete().eq("id", id);
  if (error) {
    console.error("[admin/tests/DELETE]", error);
    return NextResponse.json({ error: "Failed to delete test" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deleted: { id, test_name: target.test_name },
  });
}
