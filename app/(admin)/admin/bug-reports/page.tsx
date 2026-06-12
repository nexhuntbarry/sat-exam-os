import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import PageIntro from "@/components/shared/PageIntro";
import { friendlyParsingNote } from "@/lib/friendly-parsing-notes";
import { formatDateTime } from "@/lib/datetime";
import ResolveButton from "./ResolveButton";

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
  let q = db
    .from("bug_reports")
    .select(
      "id, status, note, created_at, resolved_at, reporter_user_id, question_id, module_id, " +
        "questions(original_question_number, parsing_status, parsing_notes, modules(module_name))",
    )
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
    <div className="max-w-7xl mx-auto space-y-4">
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

      {reports.length === 0 ? (
        <p className="text-soft-mute text-sm py-8 text-center">
          No bug reports {filter !== "all" ? `with status "${filter}"` : ""}.
        </p>
      ) : (
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-light-bg text-left text-xs uppercase text-soft-mute">
              <tr>
                <th className="px-4 py-2.5">Question</th>
                <th className="px-4 py-2.5">Audit flag</th>
                <th className="px-4 py-2.5">Reviewer note</th>
                <th className="px-4 py-2.5">Reported</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const note = friendlyParsingNote(
                  r.questions?.parsing_notes ?? null,
                );
                return (
                  <tr
                    key={r.id}
                    className="border-t border-border hover:bg-light-bg/40"
                  >
                    <td className="px-4 py-3 align-top">
                      <Link
                        href={`/admin/questions/${r.question_id}`}
                        className="font-medium text-charcoal hover:underline"
                      >
                        Q{r.questions?.original_question_number ?? "?"}
                      </Link>
                      <p className="text-xs text-soft-mute">
                        {r.questions?.modules?.module_name ?? "(unknown module)"}
                      </p>
                      <p className="text-[11px] text-soft-mute">
                        Now {r.questions?.parsing_status ?? "?"}
                      </p>
                    </td>
                    <td className="px-4 py-3 align-top max-w-xs">
                      {note ? (
                        <>
                          <p className="text-charcoal">{note.headline}</p>
                          {note.detail && (
                            <p className="text-xs text-soft-mute mt-0.5">
                              {note.detail}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="text-soft-mute text-xs">No audit flag</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top max-w-xs text-charcoal">
                      {r.note ? (
                        <span>{r.note}</span>
                      ) : (
                        <span className="text-soft-mute text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-xs text-soft-mute whitespace-nowrap">
                      {formatDateTime(r.created_at)}
                      {r.resolved_at && (
                        <p className="text-[11px]">
                          Resolved {formatDateTime(r.resolved_at)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${pill(
                          r.status,
                        )}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {r.status === "open" ? (
                        <ResolveButton reportId={r.id} />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
