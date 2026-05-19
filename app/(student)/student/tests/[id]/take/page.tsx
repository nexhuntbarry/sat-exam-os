import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import TestTakingClient from "./TestTakingClient";

async function getActiveSubmission(testId: string, studentId: string) {
  const db = getServiceClient();

  const { data: submission } = await db
    .from("submissions")
    .select(
      "id, test_id, answers, status, started_at, metadata, module_id, adaptive_track, session_id",
    )
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .eq("status", "In Progress")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!submission) return null;

  const { data: test } = await db
    .from("tests")
    .select(
      "id, test_name, time_limit_minutes, time_limit_minutes_module_2, due_date, question_ids, module_id, is_adaptive, desmos_enabled, formula_sheet_url",
    )
    .eq("id", testId)
    .single();

  if (!test) return null;

  // Use the submission's own module so adaptive Module 2 picks up the
  // chosen easy/hard slot rather than falling back to tests.module_id
  // (which is unset on adaptive tests).
  const activeModuleId = submission.module_id ?? test.module_id;
  if (!activeModuleId) return null;

  const { data: activeModule } = await db
    .from("modules")
    .select("section")
    .eq("id", activeModuleId)
    .maybeSingle();
  const isMath = activeModule?.section === "Math";

  // Resolve the formula sheet to show. Per-test overrides (legacy
  // tests.formula_sheet_url) win when present; otherwise we fall back
  // to the global default admin uploaded at /admin/settings. Either
  // way a Reading & Writing test gets nothing.
  let formulaSheetUrl: string | null = null;
  if (isMath) {
    if (test.formula_sheet_url) {
      formulaSheetUrl = test.formula_sheet_url;
    } else {
      const { data: setting } = await db
        .from("app_settings")
        .select("value")
        .eq("key", "math_formula_sheet")
        .maybeSingle();
      formulaSheetUrl = (setting?.value as { url?: string } | null)?.url ?? null;
    }
  }

  let questionQuery = db
    .from("questions")
    .select("id, module_id, original_question_number, question_text, choices, question_type, has_image, has_table, source_pdf_url, page_number, section, image_urls, image_alts")
    .eq("module_id", activeModuleId)
    .neq("parsing_status", "Rejected")
    .order("original_question_number", { ascending: true });

  // tests.question_ids only filters the legacy single-module path.
  if (
    !test.is_adaptive &&
    test.question_ids &&
    Array.isArray(test.question_ids) &&
    test.question_ids.length > 0
  ) {
    questionQuery = questionQuery.in("id", test.question_ids);
  }

  const { data: questions } = await questionQuery;

  // Module 2 lazy-start: the handoff inserts the Module 2 submission
  // the moment Module 1 is submitted, but the student may not actually
  // open the take page right away (closed tab, came back later, etc.).
  // Counting down from the handoff timestamp would surface "0 minutes
  // left" before the student starts. We solve this by stamping a
  // separate `module2_started_at` into `submission.metadata` on the
  // FIRST take-page render. Subsequent renders reuse it, so a refresh
  // doesn't reset the timer — the cheating window is closed.
  const isModule2 =
    submission.adaptive_track === "module_2" ||
    submission.adaptive_track === "module_2_easy" ||
    submission.adaptive_track === "module_2_hard";
  const submissionMetadata = (submission.metadata ?? {}) as Record<string, unknown>;
  let effectiveStartedAtIso = submission.started_at as string;
  if (isModule2) {
    const existing = submissionMetadata.module_2_started_at as string | undefined;
    if (existing) {
      effectiveStartedAtIso = existing;
    } else {
      const stamp = new Date().toISOString();
      effectiveStartedAtIso = stamp;
      await db
        .from("submissions")
        .update({
          metadata: { ...submissionMetadata, module_2_started_at: stamp },
        })
        .eq("id", submission.id)
        .eq("status", "In Progress");
    }
  }

  const startedAt = new Date(effectiveStartedAtIso).getTime();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - startedAt) / 1000);
  // Module 2 submissions get their own timer if the admin set
  // time_limit_minutes_module_2; otherwise fall back to module 1's.
  const activeTimeLimit = isModule2
    ? test.time_limit_minutes_module_2 ?? test.time_limit_minutes
    : test.time_limit_minutes;
  const timeLimitSeconds = (activeTimeLimit ?? 35) * 60;
  const timeRemainingSeconds = Math.max(0, timeLimitSeconds - elapsedSeconds);

  // Label the active module for the take UI so the student knows
  // they're on Module 2 (and which track) when the page reloads after
  // the route picker hands off.
  const moduleLabel = submission.adaptive_track === "module_1"
    ? "Module 1"
    : submission.adaptive_track === "module_2"
    ? "Module 2"
    : submission.adaptive_track === "module_2_easy"
    ? "Module 2 · Easy"
    : submission.adaptive_track === "module_2_hard"
    ? "Module 2 · Hard"
    : null;

  return {
    submission: {
      id: submission.id,
      answers: (submission.answers ?? {}) as Record<string, string>,
      metadata: (submission.metadata ?? {}) as Record<string, unknown>,
    },
    test: {
      id: test.id,
      name: test.test_name,
      timeLimitMinutes: activeTimeLimit ?? 35,
      dueDate: test.due_date,
      moduleLabel,
      // Math aids only render on Math tests; Desmos is per-test, the
      // formula sheet falls back to the global admin setting.
      desmosEnabled: isMath && Boolean(test.desmos_enabled),
      formulaSheetUrl,
      // R&W tests get inline highlight UX; Math doesn't.
      annotationsEnabled: !isMath,
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
    // key forces remount when submission id changes (Module 1 → Module 2
    // handoff uses router.push to same URL; without the key, React keeps
    // the same instance and Module 1's answers state pollutes Module 2,
    // causing the submit modal to show 0/N and the DB to store M1+M2 keys.
    <TestTakingClient
      key={data.submission.id}
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
