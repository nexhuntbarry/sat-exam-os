import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { SPR_TYPE, sprInputMaxChars } from "@/lib/answer-key";
import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { resolveParentTestId } from "@/lib/full-length";
import {
  deviceInfoFromHeaders,
  moduleRemainingSeconds,
  moduleTimeLimitMinutes,
  moduleTimeLimitSeconds,
  scopeToStudentQuestionSet,
  stampModule2Start,
} from "@/lib/student-exam";
import { studentTestAccess } from "@/lib/module2-access";
import { studentReportsEnabledFor } from "@/lib/student-reports";
import {
  advanceFlAttempt,
  childModule1Id,
  flModuleMetadata,
  formatDuration,
  latestFlAttempt,
  loadFlContext,
  type FlChildTest,
  type FlRow,
} from "@/lib/full-length-attempt";
import TestTakingClient from "../take/TestTakingClient";
import Module2Intro from "../take/Module2Intro";
import ClearTakeErrorReloads from "../take/ClearTakeErrorReloads";
import BreakScreen from "./BreakScreen";

// Full-length SAT runner: R&W Module 1 → R&W Module 2 → break → Math
// Module 1 → Math Module 2 → done (plan: .omc/plans/full-length-sat.md,
// Phase 2). Every load re-derives where the attempt is from its rows
// (lib/full-length-attempt flState) and repairs what a crash can leave
// (missing R&W Module 1, a Module 2 whose handoff failed), so reloading or
// coming back at any point lands in the same place. Each module is the
// ordinary take client on the section's hidden child test; after a submit
// it comes back here. The Module 2 clock starts on "Start Module 2"
// (?start=1), Math's when the break screen starts it.

export const dynamic = "force-dynamic";

const SECTION_LABEL = { rw: "Reading and Writing", math: "Math" } as const;

async function formulaSheetFor(child: FlChildTest, isMath: boolean): Promise<string | null> {
  if (!isMath) return null;
  if (child.formula_sheet_url) return child.formula_sheet_url;
  const { data: setting } = await getServiceClient()
    .from("app_settings")
    .select("value")
    .eq("key", "math_formula_sheet")
    .maybeSingle();
  return (setting?.value as { url?: string } | null)?.url ?? null;
}

async function moduleQuestions(child: FlChildTest, moduleId: string) {
  // Approved only (scopeToStudentQuestionSet) — the same set submit grades.
  const { data } = await scopeToStudentQuestionSet(
    getServiceClient()
      .from("questions")
      .select("id, module_id, original_question_number, question_text, choices, question_type, has_image, has_table, source_pdf_url, page_number, section, image_urls, correct_answer"),
    child,
    moduleId,
  ).order("original_question_number", { ascending: true });
  // The key never reaches the browser, only the fill-in box length.
  return (data ?? []).map(({ correct_answer, ...q }) => ({
    ...q,
    spr_max_chars: q.question_type === SPR_TYPE ? sprInputMaxChars(correct_answer as string | null) : null,
  }));
}

async function questionCount(child: FlChildTest, moduleId: string | null): Promise<number> {
  if (!moduleId) return 0;
  const { count } = await scopeToStudentQuestionSet(
    getServiceClient().from("questions").select("id", { count: "exact", head: true }),
    child,
    moduleId,
  );
  return count ?? 0;
}

function Closed({ testId, title, message }: { testId: string; title: string; message: string }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-cream p-4">
      <div role="alert" className="w-full max-w-md rounded-2xl border border-divider bg-surface p-6 sm:p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-charcoal">{title}</h1>
        <p className="mt-3 text-charcoal">{message}</p>
        <p className="mt-2 text-sm text-soft-mute">Your answers so far are saved. Contact your teacher if you need to finish it.</p>
        <a href={`/student/tests/${testId}`} className="mt-6 inline-block text-sm text-soft-mute underline hover:text-charcoal">
          Back to the test page
        </a>
      </div>
    </div>
  );
}

export default async function FullLengthSatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ start?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const { id } = await params;
  const { start } = await searchParams;
  const db = getServiceClient();
  const landing = `/student/tests/${id}`;

  const parentId = await resolveParentTestId(db, id);
  if (parentId !== id) redirect(`/student/tests/${parentId}`);
  const ctx = await loadFlContext(db, id);
  if (!ctx) redirect(landing);
  // Same rules as every other way in: QA side, Published (or Closed with
  // this attempt still running), assigned or mid-attempt.
  const access = await studentTestAccess(db, user, ctx.parent);
  if (access.error) redirect(landing);
  const attempt = await latestFlAttempt(db, id, user.userId);
  if (!attempt) redirect(landing);

  const device = deviceInfoFromHeaders(await headers());
  const { state: st, blocked } = await advanceFlAttempt(db, ctx, attempt, { device });
  const testName = ctx.parent.test_name;

  if (st.state === "done") redirect(landing);
  if (st.state === "closed") {
    return (
      <Closed
        testId={id}
        title="This attempt is closed"
        message={
          attempt.closed_reason === "math_not_started"
            ? "Math wasn't started before the deadline. Your Reading and Writing section is kept."
            : attempt.closed_reason === "abandoned"
            ? "This attempt can't be continued after the due date."
            : "This attempt can no longer be continued."
        }
      />
    );
  }
  if (blocked) {
    return (
      <Closed
        testId={id}
        title="This attempt is closed"
        message="Module 1 was submitted, but Module 2 can't be started after the due date."
      />
    );
  }

  if (st.state === "break") {
    if (st.mathStartBlock) {
      return (
        <Closed
          testId={id}
          title="This attempt is closed"
          message="Math can no longer be started — the due date has passed. Your Reading and Writing section is kept."
        />
      );
    }
    const mathMeta = flModuleMetadata(attempt);
    const mathSeconds = moduleTimeLimitSeconds(ctx.math, "module_1", mathMeta);
    return (
      <>
        <ClearTakeErrorReloads testId={id} />
        <BreakScreen
          testId={id}
          testName={testName}
          breakEndsAtMs={st.breakEndsAtMs!}
          serverNowMs={Date.now()}
          allowPause={Boolean(attempt.allow_section_pause)}
          mathTimeLabel={mathSeconds != null ? formatDuration(mathSeconds) : null}
          mathQuestionCount={await questionCount(ctx.math, childModule1Id(ctx.math))}
        />
      </>
    );
  }

  // A module: *_m1, *_m2_intro, *_m2. A *_handoff / rw_missing that
  // recovery couldn't move on (or a module still being graded) gets a panel
  // with a way to try again — never a redirect loop with the landing page.
  const section = st.section;
  let row: FlRow | null = st.row;
  if (!section || !row || !["rw_m1", "rw_m2", "rw_m2_intro", "math_m1", "math_m2", "math_m2_intro"].includes(st.state)) {
    return (
      <Closed
        testId={id}
        title="We couldn't open your next module"
        message="Your answers are saved. Reload this page in a minute to try again."
      />
    );
  }
  const child = section === "rw" ? ctx.rw : ctx.math;
  const isMath = section === "math";
  const moduleId = row.module_id ?? childModule1Id(child);
  if (!moduleId) redirect(landing);
  const satUrl = `/student/tests/${id}/sat`;

  if (st.state === "rw_m2_intro" || st.state === "math_m2_intro") {
    if (start !== "1") {
      const limitSeconds = moduleTimeLimitSeconds(child, row.adaptive_track, row.metadata);
      return (
        <>
          <ClearTakeErrorReloads testId={id} />
          <Module2Intro
            testId={child.id}
            testName={testName}
            questionCount={await questionCount(child, moduleId)}
            timeLimitMinutes={null}
            timeLimitSeconds={limitSeconds}
            startHref={`${satUrl}?start=1`}
            heading={`${SECTION_LABEL[section]} · Module 1 submitted`}
          />
        </>
      );
    }
    // "Start Module 2": its clock starts now (guarded write, no client time).
    // The device Module 2 was actually started on, like the take page.
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    row = {
      ...row,
      metadata: await stampModule2Start(db, row.id, meta.device || !device ? meta : { ...meta, device }),
    };
  }

  const [questions, formulaSheetUrl, reportsEnabled] = await Promise.all([
    moduleQuestions(child, moduleId),
    formulaSheetFor(child, isMath),
    // Never throws (off on any error), so it can't keep the test from loading.
    studentReportsEnabledFor(db, user),
  ]);

  const limitMinutes = moduleTimeLimitMinutes(child, row.adaptive_track, row.metadata);
  // Server clock with the extended time (metadata.time_multiplier).
  const timeRemainingSeconds =
    moduleRemainingSeconds(row, child) ?? moduleTimeLimitSeconds(child, row.adaptive_track, row.metadata) ?? 0;
  const moduleLabel = row.adaptive_track === "module_1" ? "Module 1" : "Module 2";

  return (
    <>
      <ClearTakeErrorReloads testId={id} />
      <TestTakingClient
        key={row.id}
        testId={child.id}
        submissionId={row.id}
        attemptStartedAt={row.started_at}
        initialAnswers={((await answersOf(row.id)) ?? {}) as Record<string, string>}
        initialMetadata={(row.metadata ?? {}) as Record<string, unknown>}
        test={{
          id: child.id,
          name: testName,
          timeLimitMinutes: limitMinutes ?? 0,
          isUntimed: limitMinutes == null,
          dueDate: ctx.parent.due_date,
          moduleLabel,
          desmosEnabled: isMath && Boolean(child.desmos_enabled),
          formulaSheetUrl,
          annotationsEnabled: !isMath,
        }}
        questions={questions}
        timeRemainingSeconds={timeRemainingSeconds}
        reportsEnabled={reportsEnabled}
        continueUrl={satUrl}
        doneUrl={satUrl}
        sectionLabel={SECTION_LABEL[section]}
      />
    </>
  );
}

async function answersOf(submissionId: string): Promise<Record<string, string> | null> {
  const { data } = await getServiceClient()
    .from("submissions")
    .select("answers")
    .eq("id", submissionId)
    .abortSignal(new AbortController().signal)
    .maybeSingle();
  return (data?.answers as Record<string, string> | null) ?? null;
}
