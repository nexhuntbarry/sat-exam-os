import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { getQaTestIds, onSide } from "@/lib/qa";
import { formatDateTime, formatShortDateTime } from "@/lib/datetime";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import SubmissionRowActions from "./SubmissionRowActions";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  EmptyRow,
} from "@/components/ui/data-table";

export const dynamic = "force-dynamic";

interface SubRow {
  id: string;
  test_id: string;
  student_id: string;
  status: string;
  score: number | null;
  percentage: number | string | null;
  started_at: string;
  submitted_at: string | null;
  attempt_number: number;
  adaptive_track: string | null;
  module_id: string | null;
  session_id: string | null;
  users:
    | { display_name: string | null; email: string }
    | { display_name: string | null; email: string }[]
    | null;
}

export default async function ManageSubmissionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");
  const { id: testId } = await params;
  if (!onSide(testId, await getQaTestIds(), user.isQa)) notFound();

  const db = getServiceClient();
  const { data: test } = await db
    .from("tests")
    .select("id, test_name, status")
    .eq("id", testId)
    .maybeSingle();
  if (!test) notFound();

  // A full-length SAT's rows are on its two section children; one
  // full-length attempt (R&W + Math, up to 4 rows) is grouped as one.
  const flKids = (await fullLengthLinksOrNone(db)).childrenOf.get(testId) ?? null;
  const flChildIds = flKids ? [flKids.rw, flKids.math].filter((x): x is string => Boolean(x)) : [];
  const subQuery = db
    .from("submissions")
    .select(
      `id, test_id, student_id, status, score, percentage, started_at, submitted_at,
       attempt_number, adaptive_track, module_id, session_id,
       users!inner(display_name, email)`,
    );
  const { data, error } = await (flKids ? subQuery.in("test_id", flChildIds) : subQuery.eq("test_id", testId))
    .order("started_at", { ascending: false });
  if (error) {
    console.error("[admin/tests/manage-submissions]", error);
  }
  const rows = (data ?? []) as unknown as SubRow[];

  // Group by attempt: session_id when present, else submission.id itself.
  // Same session = both Module 1 + Module 2 of a single attempt.
  const groups = new Map<
    string,
    { studentName: string; email: string; submissions: SubRow[] }
  >();
  for (const r of rows) {
    const key = flKids ? `fl:${r.student_id}:${r.attempt_number}` : r.session_id ?? r.id;
    const u = (Array.isArray(r.users) ? r.users[0] : r.users) as
      | { display_name: string | null; email: string }
      | null;
    if (!groups.has(key)) {
      groups.set(key, {
        studentName: u?.display_name ?? u?.email ?? "—",
        email: u?.email ?? "",
        submissions: [],
      });
    }
    groups.get(key)!.submissions.push(r);
  }

  // R&W rows before Math rows inside a full-length attempt (0 for section tests).
  const sectionRank = (tid: string) => (flKids && tid === flKids.math ? 1 : 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-soft-mute text-sm">
        <Link href={`/admin/tests/${testId}`} className="hover:text-charcoal inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Back to test
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Manage submissions</h1>
        <p className="text-soft-mute text-sm mt-1">
          {test.test_name} · {rows.length} submission{rows.length === 1 ? "" : "s"} across {groups.size} attempt
          {groups.size === 1 ? "" : "s"}
        </p>
      </div>

      <div className="bg-warm-amber/10 border border-warm-amber/30 rounded-xl px-4 py-3 text-sm text-charcoal">
        <p className="font-semibold">Admin tools</p>
        <ul className="text-mid-gray text-xs mt-1 space-y-0.5 list-disc list-inside">
          <li><strong>Reset</strong>: wipes this submission&apos;s answers + resets timer to now. Student can keep trying.</li>
          <li><strong>Force submit</strong>: grades whatever answers are saved and closes the submission (for stuck students).</li>
          <li><strong>Delete attempt</strong>: removes the entire attempt (both Module 1 + Module 2 if applicable). Student starts fresh on next open.</li>
          {flKids && (
            <li>
              <strong>Full-length SAT</strong>: resetting a Reading and Writing module also deletes the Math section;
              deleting any module deletes the whole attempt (both sections).
            </li>
          )}
        </ul>
      </div>

      {groups.size === 0 ? (
        <div className="py-12 text-center text-soft-mute text-sm border-y border-divider">
          No submissions yet.
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(groups.entries()).map(([key, group]) => (
            <div
              key={key}
              className="bg-surface border border-divider rounded-2xl overflow-hidden"
            >
              <div className="px-5 py-3 border-b border-divider flex items-center justify-between">
                <div>
                  <p className="text-charcoal font-semibold">{group.studentName}</p>
                  <p className="text-soft-mute text-xs">
                    {group.email}
                    {flKids ? ` · Full-length attempt ${group.submissions[0]?.attempt_number ?? 1}` : ""}
                  </p>
                </div>
                <SubmissionRowActions
                  attemptKey={key}
                  // Full-length: one delete removes the whole attempt server-side.
                  submissionIds={flKids ? group.submissions.slice(0, 1).map((s) => s.id) : group.submissions.map((s) => s.id)}
                  mode="attempt"
                  studentName={group.studentName}
                  fullLength={Boolean(flKids)}
                />
              </div>
              <DataTable className="border-t-0">
                <thead>
                  <HeadRow>
                    <Th kind="main">Module</Th>
                    <Th>Status</Th>
                    <Th>Score</Th>
                    <Th priority="md">Started</Th>
                    <Th priority="md">Submitted</Th>
                    <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
                  </HeadRow>
                </thead>
                <tbody>
                  {group.submissions
                    .slice()
                    .sort((a, b) =>
                      sectionRank(a.test_id) - sectionRank(b.test_id) ||
                      (a.adaptive_track ?? "").localeCompare(b.adaptive_track ?? ""),
                    )
                    .map((s) => {
                      const trackLabel =
                        s.adaptive_track === "module_1"
                          ? "Module 1"
                          : s.adaptive_track === "module_2"
                            ? "Module 2"
                            : s.adaptive_track === "module_2_easy"
                              ? "Module 2 · Easy"
                              : s.adaptive_track === "module_2_hard"
                                ? "Module 2 · Hard"
                                : "Single";
                      const moduleLabel = flKids
                        ? `${s.test_id === flKids.rw ? "R&W" : "Math"} · ${trackLabel}`
                        : trackLabel;
                      return (
                        <DataRow key={s.id} colSpan={6}>
                          <Td kind="main" className="font-medium text-charcoal">
                            {moduleLabel}
                          </Td>
                          <Td className="text-mid-gray">{s.status}</Td>
                          <Td className="text-mid-gray">
                            {s.percentage != null
                              ? `${Number(s.percentage).toFixed(0)}%`
                              : "—"}
                          </Td>
                          <Td priority="md" className="text-soft-mute" title={formatDateTime(s.started_at)}>
                            {formatShortDateTime(s.started_at)}
                          </Td>
                          <Td priority="md" className="text-soft-mute" title={s.submitted_at ? formatDateTime(s.submitted_at) : undefined}>
                            {s.submitted_at ? formatShortDateTime(s.submitted_at) : "—"}
                          </Td>
                          <Td kind="actions" sticky="right">
                            <SubmissionRowActions
                              attemptKey={s.id}
                              submissionIds={[s.id]}
                              mode="single"
                              isInProgress={s.status === "In Progress"}
                              studentName={group.studentName}
                              fullLength={Boolean(flKids)}
                              fullLengthSection={flKids ? (s.test_id === flKids.rw ? "rw" : "math") : undefined}
                            />
                          </Td>
                        </DataRow>
                      );
                    })}
                </tbody>
              </DataTable>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
