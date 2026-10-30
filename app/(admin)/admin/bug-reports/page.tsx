import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import PageIntro from "@/components/shared/PageIntro";
import { friendlyParsingNote } from "@/lib/friendly-parsing-notes";
import { formatDateTime, formatShortDate, formatShortDateTime } from "@/lib/datetime";
import ResolveButton from "./ResolveButton";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  TwoLineCell,
  TruncatedText,
} from "@/components/ui/data-table";

interface Search {
  status?: "open" | "resolved" | "all";
}

export default async function BugReportsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const auth = await requireRole("admin");
  if (auth instanceof Response) redirect("/sign-in");
  const sp = await searchParams;
  const filter = sp.status ?? "open";

  const db = getServiceClient();
  let q = scopeIds(db
    .from("bug_reports")
    .select(
      "id, status, note, created_at, resolved_at, reporter_user_id, question_id, module_id, " +
        "questions(original_question_number, parsing_status, parsing_notes, modules(module_name))",
    ), "reporter_user_id", await getQaUserIds(), auth.isQa, true)
    .order("created_at", { ascending: false })
    .limit(200);
  if (filter !== "all") q = q.eq("status", filter);
  const { data: rows } = await q;

  type Row = {
    id: string;
    status: string;
    note: string | null;
    created_at: string;
    resolved_at: string | null;
    reporter_user_id: string | null;
    question_id: string;
    module_id: string;
    questions: {
      original_question_number: number | null;
      parsing_status: string;
      parsing_notes: string | null;
      modules: { module_name: string } | null;
    } | null;
  };
  const reports = (rows ?? []) as unknown as Row[];

  const pill = (status: string) =>
    status === "open"
      ? "bg-status-warning/15 text-status-warning"
      : "bg-warm-amber/15 text-warm-amber";

  return (
    <div className="space-y-4">
      <PageIntro tKey="admin.bugReports" />
      <h1 className="text-2xl font-bold text-charcoal">Bug Reports</h1>

      <div className="flex gap-2">
        {(["open", "resolved", "all"] as const).map((s) => (
          <Link
            key={s}
            href={`/admin/bug-reports?status=${s}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === s
                ? "bg-charcoal text-white"
                : "bg-surface text-charcoal hover:bg-light-bg"
            }`}
          >
            {s[0].toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </div>

      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">Question</Th>
            <Th kind="long">Audit flag</Th>
            <Th kind="long" priority="lg">Reviewer note</Th>
            <Th priority="md">Reported</Th>
            <Th>Status</Th>
            <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {reports.length === 0 && (
            <EmptyRow colSpan={6}>
              No bug reports {filter !== "all" ? `with status "${filter}"` : ""}.
            </EmptyRow>
          )}
          {reports.map((r) => {
            const note = friendlyParsingNote(r.questions?.parsing_notes ?? null);
            const qNum = r.questions?.original_question_number;
            const moduleName = r.questions?.modules?.module_name ?? "(unknown module)";
            const qStatus = r.questions?.parsing_status ?? "?";
            const reportedTitle = `${formatDateTime(r.created_at)}${r.resolved_at ? ` · Resolved ${formatDateTime(r.resolved_at)}` : ""}`;
            return (
              <DataRow
                key={r.id}
                expandBelow="lg"
                details={
                  <>
                    <DetailItem label="Reviewer note" priority="lg">
                      {r.note ?? "—"}
                    </DetailItem>
                  </>
                }
              >
                <Td kind="main" sticky="left">
                  <Link
                    href={`/admin/questions/${r.question_id}`}
                    className="block hover:text-warm-coral-text transition-colors"
                  >
                    <TwoLineCell
                      main={`Q${qNum ?? "?"}`}
                      detail={`${moduleName} · ${qStatus}`}
                      mainClassName="font-medium text-inherit"
                    />
                  </Link>
                </Td>
                <Td kind="long">
                  {note ? (
                    <TwoLineCell
                      main={note.headline}
                      detail={note.detail ?? ""}
                    />
                  ) : (
                    <span className="text-soft-mute text-xs">No audit flag</span>
                  )}
                </Td>
                <Td kind="long" priority="lg">
                  {r.note ? (
                    <TruncatedText title={r.note}>{r.note}</TruncatedText>
                  ) : (
                    <span className="text-soft-mute text-xs">—</span>
                  )}
                </Td>
                <Td priority="md">
                  <span title={reportedTitle} className="whitespace-nowrap">
                    {formatShortDate(r.created_at)}
                    {r.resolved_at && (
                      <span className="block text-xs text-soft-mute">
                        Resolved {formatShortDate(r.resolved_at)}
                      </span>
                    )}
                  </span>
                </Td>
                <Td>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${pill(r.status)}`}>
                    {r.status}
                  </span>
                </Td>
                <Td kind="actions" sticky="right">
                  {r.status === "open" ? <ResolveButton reportId={r.id} /> : null}
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
