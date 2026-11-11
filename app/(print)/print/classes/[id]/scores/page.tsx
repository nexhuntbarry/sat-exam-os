import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getQaClassGroupIds, onSide } from "@/lib/qa";
import { formatDate } from "@/lib/datetime";
import { printPageCss } from "@/lib/print-page-css";
import { gradebookSubjects, loadClassGradebook } from "@/lib/class-gradebook";
import { KIND_LABEL, filterColumns, parseViewQuery, sortRows } from "@/lib/class-gradebook-view";
import GradebookTable, { GradebookLegend } from "@/components/analytics/GradebookTable";
import PrintPreview from "@/components/print/PrintPreview";

export const dynamic = "force-dynamic";

// GET /print/classes/<classId>/scores?subject=&from=&to=&sort=&dir=
// The class gradebook as a compact printout (same page frame as the result
// printout: Paged.js Letter pages, running header, page numbers),
// landscape when the grid is wide. Admins: any class on their QA side;
// teachers: their own classes, limited to their subject.
export default async function PrintClassScoresPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (user.role === "teacher" && user.accountStatus !== "approved") redirect("/teacher");
  if (!onSide(id, await getQaClassGroupIds(), user.isQa)) notFound();

  const db = getServiceClient();
  const access = await gradebookSubjects(db, user, id);
  if (!access) notFound();
  const { data: group } = await db.from("class_groups").select("id, name").eq("id", id).maybeSingle();
  if (!group) notFound();

  const gradebook = await loadClassGradebook(db, {
    classGroupId: id,
    isQa: user.isQa,
    subjects: access.subjects,
    testHref: (testId) => (user.role === "admin" ? `/admin/tests/${testId}/submissions?class=${id}` : `/teacher/tests/${testId}/results`),
  });
  const view = parseViewQuery({ subject: one(raw.subject), from: one(raw.from), to: one(raw.to), sort: one(raw.sort), dir: one(raw.dir) });
  const columns = filterColumns(gradebook.columns, view.filter);
  const rows = sortRows(gradebook.rows, view.sort, view.dir);
  const summaryCols = 1 + (gradebook.scope.math ? 1 : 0) + (gradebook.scope.rw ? 1 : 0) + (gradebook.scope.rw && gradebook.scope.math ? 1 : 0);
  const wide = columns.length + summaryCols > 7;
  const filters = [
    view.filter.subject !== "all" ? `${KIND_LABEL[view.filter.subject]} only` : null,
    view.filter.from || view.filter.to ? `${view.filter.from || "…"} to ${view.filter.to || "…"}` : null,
  ].filter(Boolean);
  const title = `${group.name as string} – Scores`;

  return (
    <PrintPreview title={title} pageCss={printPageCss({ header: { text: title }, landscape: wide })}>
      <div className="bg-white text-charcoal">
        <div className="border-b-2 border-charcoal pb-2 mb-3">
          <h1 className="text-xl font-bold">{group.name as string} · Scores</h1>
          <p className="text-sm text-mid-gray">
            {rows.length} {rows.length === 1 ? "student" : "students"} · {columns.length} {columns.length === 1 ? "test" : "tests"}
            {filters.length > 0 ? ` · ${filters.join(" · ")}` : ""} · Printed {formatDate(new Date())}
          </p>
          {!(gradebook.scope.rw && gradebook.scope.math) && (
            <p className="text-xs text-mid-gray">
              {gradebook.scope.math ? "Math" : "Reading and Writing"} tests, plus the total and that section of full-length SATs.
            </p>
          )}
        </div>
        {rows.length === 0 || columns.length === 0 ? (
          <p className="text-sm text-mid-gray">{rows.length === 0 ? "No students in this class yet." : "No tests to show."}</p>
        ) : (
          <>
            <GradebookTable gradebook={gradebook} columns={columns} rows={rows} compact />
            <div className="mt-2">
              <GradebookLegend compact />
            </div>
            <p className="mt-1 text-[7.5pt] text-mid-gray">
              Latest attempt per student, scored as on each test&rsquo;s Results page. Est. total = latest Math + latest R&amp;W. Change = most
              recent finished test vs the previous one of the same subject.
            </p>
          </>
        )}
      </div>
    </PrintPreview>
  );
}
