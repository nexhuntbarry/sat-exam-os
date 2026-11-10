import { getServiceClient } from "@/lib/supabase";
import { labelFullLengthChildren } from "@/lib/full-length";
import {
  STUDENT_REPORTS_SETTING_KEY,
  STUDENT_REPORT_CONTEXT_LABEL,
  STUDENT_REPORT_KIND_LABEL,
  type StudentReportRow,
} from "@/lib/student-reports-shared";

export * from "@/lib/student-reports-shared";

type DbClient = ReturnType<typeof getServiceClient>;

/** The admin toggle. Missing row or any read error = off (never break a page over it). */
export async function getStudentReportsSetting(db: DbClient): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("app_settings")
      .select("value")
      .eq("key", STUDENT_REPORTS_SETTING_KEY)
      .maybeSingle();
    if (error) return false;
    return (data?.value as { enabled?: unknown } | null)?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Whether this viewer gets the "Report a problem" button. Hidden QA
 * accounts always do, so the QA harness can exercise the feature on
 * production without switching it on for real students.
 */
export async function studentReportsEnabledFor(
  db: DbClient,
  viewer: { isQa: boolean },
): Promise<boolean> {
  if (viewer.isQa) return true;
  return getStudentReportsSetting(db);
}

export interface StudentReportView extends StudentReportRow {
  student_name: string;
  student_email: string;
  test_name: string;
  module_name: string;
}

/** Attach student / test / module names to report rows (one query per table). */
export async function describeStudentReports(
  db: DbClient,
  rows: StudentReportRow[],
): Promise<StudentReportView[]> {
  const uniq = (xs: (string | null | undefined)[]) =>
    Array.from(new Set(xs.filter((x): x is string => !!x)));
  const userIds = uniq(rows.map((r) => r.user_id));
  const testIds = uniq(rows.map((r) => r.payload?.test_id));
  const moduleIds = uniq(rows.map((r) => r.payload?.module_id));
  const [users, tests, modules] = await Promise.all([
    userIds.length
      ? db.from("users").select("id, display_name, email").in("id", userIds)
      : null,
    testIds.length ? db.from("tests").select("id, test_name").in("id", testIds) : null,
    moduleIds.length ? db.from("modules").select("id, module_name").in("id", moduleIds) : null,
  ]);
  const userMap = new Map(
    ((users?.data ?? []) as { id: string; display_name: string | null; email: string | null }[]).map(
      (u) => [u.id, u],
    ),
  );
  const testMap = new Map(
    ((tests?.data ?? []) as { id: string; test_name: string }[]).map((t) => [t.id, t.test_name]),
  );
  await labelFullLengthChildren(db, testMap);
  const moduleMap = new Map(
    ((modules?.data ?? []) as { id: string; module_name: string }[]).map((m) => [m.id, m.module_name]),
  );
  return rows.map((r) => {
    const u = userMap.get(r.user_id);
    return {
      ...r,
      student_name: u?.display_name ?? "Unknown student",
      student_email: u?.email ?? "",
      test_name: testMap.get(r.payload?.test_id) ?? "Unknown test",
      module_name: moduleMap.get(r.payload?.module_id) ?? "Unknown module",
    };
  });
}

/** The support_request text an admin sends to dev when forwarding a report. */
export function studentReportForwardBody(
  r: StudentReportView,
  opts: { origin: string; reportedAt: string; adminNote?: string },
): string {
  const p = r.payload;
  const q = p.question_number != null ? `Q${p.question_number}` : "Question";
  const shown =
    p.display_number != null && p.display_number !== p.question_number
      ? ` (shown to the student as #${p.display_number})`
      : "";
  const lines = [
    `[Student report] ${STUDENT_REPORT_KIND_LABEL[p.kind] ?? p.kind}`,
    `Test: ${r.test_name} (${p.test_id})`,
    `Module: ${r.module_name} (${p.module_id})`,
    `Question: ${q}${shown} — ${opts.origin}/admin/questions/${p.question_id}`,
    `Where: ${STUDENT_REPORT_CONTEXT_LABEL[p.context] ?? p.context}`,
    `Student: ${r.student_name}${r.student_email ? ` <${r.student_email}>` : ""}`,
    `Submission: ${p.submission_id ?? "none"}`,
    `Reported: ${opts.reportedAt} (New York time)`,
    `Student's note: ${p.note ? `"${p.note}"` : "(none)"}`,
  ];
  if (opts.adminNote) lines.push(`Admin note: ${opts.adminNote}`);
  return lines.join("\n");
}
