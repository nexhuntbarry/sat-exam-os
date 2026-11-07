// scripts/backfill-bug-reports-to-support.ts
//
// One-off: every past "Report to dev" (bug_reports row) that has no
// "Report a Problem" thread yet gets one (lib/support.ts createSupportRequest,
// the code path /admin/support uses), so it shows on /admin/support with a
// question link, the reviewer's note, status and the "Add a message" box.
//
// Idempotent: the thread stores payload.source = { kind: "bug_report", id },
// and rows that already have one are skipped.
// Quiet: no bell items, and each thread ends with a dev message that carries
// the original report's state (resolved → Fixed, open → Received), so the
// ops watcher (.omc/support/watch.mjs: wakes only when the LAST message is
// the reporter's) isn't flooded. QA reporters are skipped (lib/qa.ts).
// bug_reports itself is not changed (scripts/audit-bug-reports.ts reads it).
//
//   npx tsx --env-file=.env.local scripts/backfill-bug-reports-to-support.ts           # dry run: counts
//   npx tsx --env-file=.env.local scripts/backfill-bug-reports-to-support.ts --apply
import { createClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { isQaEmail } from "@/lib/qa";
import { SUPPORT_TYPE, bugReportSupportBody, createSupportRequest } from "@/lib/support";
import { formatDateTime } from "@/lib/datetime";

const APPLY = process.argv.includes("--apply");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

interface Report {
  id: string;
  question_id: string | null;
  reporter_user_id: string | null;
  note: string | null;
  status: string | null;
  created_at: string;
  resolved_at: string | null;
}

async function main() {
  const { data: reports, error: rErr } = await fetchAllRows<Report>((from, to) =>
    db.from("bug_reports").select("id, question_id, reporter_user_id, note, status, created_at, resolved_at").order("created_at").range(from, to),
  );
  if (rErr) throw new Error(`bug_reports: ${String((rErr as { message?: string }).message ?? rErr)}`);
  const { data: threads, error: tErr } = await fetchAllRows<{ id: string; payload: { source?: { kind?: string; id?: string } } }>((from, to) =>
    db.from("notifications").select("id, payload").eq("type", SUPPORT_TYPE).order("id").range(from, to),
  );
  if (tErr) throw new Error(`support threads: ${String((tErr as { message?: string }).message ?? tErr)}`);
  const linked = new Set(threads.map((t) => (t.payload?.source?.kind === "bug_report" ? t.payload.source.id : null)).filter(Boolean));

  const userIds = [...new Set(reports.map((r) => r.reporter_user_id).filter((x): x is string => !!x))];
  const users = new Map<string, { display_name: string | null; email: string | null }>();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await db.from("users").select("id, display_name, email").in("id", userIds.slice(i, i + 200));
    for (const u of data ?? []) users.set(u.id as string, u as { display_name: string | null; email: string | null });
  }
  const qIds = [...new Set(reports.map((r) => r.question_id).filter((x): x is string => !!x))];
  const questions = new Map<string, { number: number | null; module_name: string | null }>();
  for (let i = 0; i < qIds.length; i += 200) {
    const { data } = await db.from("questions").select("id, original_question_number, modules(module_name)").in("id", qIds.slice(i, i + 200));
    for (const q of data ?? []) {
      const m = q.modules as unknown as { module_name?: string } | { module_name?: string }[] | null;
      questions.set(q.id as string, {
        number: (q.original_question_number as number | null) ?? null,
        module_name: (Array.isArray(m) ? m[0]?.module_name : m?.module_name) ?? null,
      });
    }
  }

  const counts = { reports: reports.length, alreadyLinked: 0, qa: 0, noReporter: 0, toCreate: 0, open: 0, resolved: 0, created: 0, failed: 0 };
  const now = new Date().toISOString();
  for (const r of reports) {
    if (linked.has(r.id)) {
      counts.alreadyLinked++;
      continue;
    }
    const u = r.reporter_user_id ? users.get(r.reporter_user_id) : undefined;
    if (!r.reporter_user_id || !u) {
      counts.noReporter++;
      continue;
    }
    if (isQaEmail(u.email)) {
      counts.qa++;
      continue;
    }
    counts.toCreate++;
    const resolved = r.status === "resolved";
    resolved ? counts.resolved++ : counts.open++;
    const q = r.question_id ? questions.get(r.question_id) : undefined;
    const devMessage = resolved
      ? `Imported from the earlier "Report to dev" queue: this report was resolved${r.resolved_at ? ` on ${formatDateTime(r.resolved_at)}` : ""}. If it's still happening, add a message here.`
      : `Imported from the earlier "Report to dev" queue: this report is still open and the dev team will follow up here.`;
    const label = `${q?.module_name ?? "?"} Q${q?.number ?? "?"} — ${resolved ? "fixed" : "new"} — ${(r.note ?? "(no note)").slice(0, 80)}`;
    if (!APPLY) {
      console.log(`would create: ${r.id} ${label}`);
      continue;
    }
    try {
      const id = await createSupportRequest(db as never, {
        userId: r.reporter_user_id,
        reporterName: u.display_name ?? u.email ?? "Reviewer",
        reporterEmail: u.email ?? "",
        body: bugReportSupportBody(r.note),
        status: resolved ? "fixed" : "new",
        question: r.question_id ? { id: r.question_id, module_name: q?.module_name ?? null, number: q?.number ?? null } : undefined,
        source: { kind: "bug_report", id: r.id },
        at: r.created_at,
        devMessage: { body: devMessage, at: resolved && r.resolved_at ? r.resolved_at : now },
      });
      counts.created++;
      console.log(`created ${id} ← ${r.id} ${label}`);
    } catch (e) {
      counts.failed++;
      console.error(`FAILED ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}`, counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
