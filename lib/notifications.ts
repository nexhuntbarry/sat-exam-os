import { getServiceClient } from "@/lib/supabase";

type DbClient = ReturnType<typeof getServiceClient>;

export interface BugReportResolvedPayload {
  kind: "bug_report_resolved";
  bug_report_id: string;
  question_id: string;
  module_id: string | null;
  question_number: number | null;
  module_name: string | null;
  /** What the resolver did — shown to the reporter. */
  message: string;
  /** Whether an automated pass fixed it vs a human. */
  auto: boolean;
}

/**
 * Insert a notification for a user. Never throws — a failed notification must
 * not break the action that triggered it (resolving a bug report).
 */
export async function createNotification(
  db: DbClient,
  userId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await db.from("notifications").insert({ user_id: userId, type, payload });
    if (error) console.error("[notifications] insert failed:", error.message);
  } catch (e) {
    console.error("[notifications] insert threw:", e instanceof Error ? e.message : e);
  }
}

/**
 * Notify the reporter of a bug report that it has been resolved. Looks up the
 * question's number + module name so the message reads naturally. No-op when
 * the report has no reporter on file.
 */
export async function notifyBugReportResolved(
  db: DbClient,
  opts: {
    reporterUserId: string | null;
    bugReportId: string;
    questionId: string;
    message: string;
    auto: boolean;
  },
): Promise<void> {
  if (!opts.reporterUserId) return;
  const { data: q } = await db
    .from("questions")
    .select("original_question_number, module_id, modules(module_name)")
    .eq("id", opts.questionId)
    .maybeSingle();
  const mods = (q?.modules ?? null) as
    | { module_name?: string }
    | { module_name?: string }[]
    | null;
  const moduleName = Array.isArray(mods)
    ? (mods[0]?.module_name ?? null)
    : (mods?.module_name ?? null);

  const payload: BugReportResolvedPayload = {
    kind: "bug_report_resolved",
    bug_report_id: opts.bugReportId,
    question_id: opts.questionId,
    module_id: (q?.module_id as string) ?? null,
    question_number: (q?.original_question_number as number) ?? null,
    module_name: moduleName,
    message: opts.message,
    auto: opts.auto,
  };
  await createNotification(db, opts.reporterUserId, "bug_report_resolved", payload as unknown as Record<string, unknown>);
}
