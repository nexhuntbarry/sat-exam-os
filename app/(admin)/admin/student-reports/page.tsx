import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import {
  STUDENT_REPORT_TYPE,
  describeStudentReports,
  getStudentReportsSetting,
  type StudentReportRow,
} from "@/lib/student-reports";
import StudentReportsClient, { ReportingToggle } from "./StudentReportsClient";

const FILTERS = ["new", "forwarded", "dismissed", "all"] as const;
type Filter = (typeof FILTERS)[number];

export default async function StudentReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const auth = await requireRole("admin");
  if (auth instanceof Response) redirect("/sign-in");
  const sp = await searchParams;
  const filter: Filter = (FILTERS as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as Filter)
    : "new";

  const db = getServiceClient();
  // Same QA scoping as bug reports: QA admins see only QA students' reports.
  let q = scopeIds(
    db.from("notifications").select("id, user_id, created_at, payload").eq("type", STUDENT_REPORT_TYPE),
    "user_id",
    await getQaUserIds(),
    auth.isQa,
  )
    .order("created_at", { ascending: false })
    .limit(200);
  if (filter !== "all") q = q.eq("payload->>status", filter);
  const [{ data, error }, enabled] = await Promise.all([q, getStudentReportsSetting(db)]);
  const reports = await describeStudentReports(db, (data ?? []) as StudentReportRow[]);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Student Reports</h1>
        <p className="text-sm text-mid-gray mt-1">
          Problems students flagged on a question while taking a test or reviewing results. Nothing is
          fixed automatically: check each one, then forward it to the dev team (it goes to your{" "}
          <Link href="/admin/support" className="text-warm-coral-text hover:underline">
            Report a Problem
          </Link>{" "}
          page) or dismiss it.
        </p>
      </div>

      <ReportingToggle initialEnabled={enabled} canChange={!auth.isQa} />

      <div className="flex gap-2">
        {FILTERS.map((s) => (
          <Link
            key={s}
            href={`/admin/student-reports?status=${s}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === s ? "bg-charcoal text-white" : "bg-surface text-charcoal hover:bg-light-bg"
            }`}
          >
            {s[0].toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </div>

      {error ? (
        <p className="text-sm text-status-error">Couldn&apos;t load reports: {error.message}</p>
      ) : (
        <StudentReportsClient reports={reports} />
      )}
    </div>
  );
}
