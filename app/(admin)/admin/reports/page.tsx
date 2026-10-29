import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import PageIntro from "@/components/shared/PageIntro";
import { formatDateTime } from "@/lib/datetime";
import {
  CHANGE_TYPE_LABEL,
  SOURCE_KIND_LABEL,
  listDevLog,
  type BankChangeEntry,
  type ChangeEntry,
  type ChangeType,
  type DevLogRow,
  type OpenItemEntry,
  type QaRunEntry,
  type SourceKind,
} from "@/lib/devlog";

// Temporary use of the Reports page during the QA / fix stage: a running log
// of nightly QA runs, fixes and features, question bank / score changes and
// open decisions. Platform analytics comes back later as its own tab.

const TABS = [
  { key: "qa", label: "QA runs" },
  { key: "changes", label: "Changelog" },
  { key: "bank", label: "Question bank & scores" },
  { key: "open", label: "Still open" },
  { key: "analytics", label: "Platform analytics" },
] as const;
type Tab = (typeof TABS)[number]["key"];

interface Search {
  tab?: string;
  from?: string;
  to?: string;
  type?: string;
  source?: string;
}

const NY = "America/New_York";
const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: NY });
function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function showDay(day: string): string {
  if (!isDay(day)) return day;
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function TicketLink({ id }: { id?: string | null }) {
  if (!id) return null;
  return (
    <Link href={`/admin/support#${id}`} className="text-warm-coral-dark hover:underline">
      ticket {id.slice(0, 8)}
    </Link>
  );
}

function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "bad" | "warn" }) {
  const cls = {
    neutral: "bg-light-bg text-charcoal",
    good: "bg-status-success/15 text-status-success",
    bad: "bg-status-error/15 text-status-error",
    warn: "bg-status-warning/15 text-status-warning",
  }[tone];
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${cls}`}>{children}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-soft-mute text-sm py-8 text-center">{children}</p>;
}

const card = "bg-surface rounded-xl border border-border";

export default async function AdminReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const auth = await requireRole("admin");
  if (auth instanceof Response) redirect("/sign-in");
  const sp = await searchParams;
  const tab: Tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "changes") as Tab;
  const from = isDay(sp.from) ? sp.from : "";
  const to = isDay(sp.to) ? sp.to : "";
  const typeFilter = (sp.type && sp.type in CHANGE_TYPE_LABEL ? sp.type : "") as ChangeType | "";
  const sourceFilter = (sp.source && sp.source in SOURCE_KIND_LABEL ? sp.source : "") as SourceKind | "";

  const db = getServiceClient();
  let loadError: string | null = null;
  const [rows, needsReview, draft] = await Promise.all([
    listDevLog().catch((e: unknown) => {
      loadError = e instanceof Error ? e.message : String(e);
      return [] as Awaited<ReturnType<typeof listDevLog>>;
    }),
    db.from("questions").select("id", { count: "exact", head: true }).eq("parsing_status", "Needs Review"),
    db.from("questions").select("id", { count: "exact", head: true }).eq("parsing_status", "Draft"),
  ]);
  const needsReviewCount = needsReview.count ?? 0;
  const draftCount = draft.count ?? 0;

  const of = <K extends DevLogRow["payload"]["kind"]>(kind: K) =>
    rows.filter((r) => r.payload.kind === kind) as DevLogRow<Extract<DevLogRow["payload"], { kind: K }>>[];
  const byDateDesc = <T extends DevLogRow>(a: T, b: T) =>
    b.payload.date.localeCompare(a.payload.date) || b.created_at.localeCompare(a.created_at);
  const inRange = (r: DevLogRow) => (!from || r.payload.date >= from) && (!to || r.payload.date <= to);

  const qaRuns = of("qa_run").sort(byDateDesc);
  const changes = of("change").sort(byDateDesc);
  const bank = of("bank_change").sort(byDateDesc);
  const open = of("open_item").filter((r) => !r.payload.resolved_at).sort(byDateDesc);

  // ── Weekly summary (last 7 days, New York dates) ──
  const today = nyToday();
  const weekStart = shiftDay(today, -6);
  const inWeek = (r: DevLogRow) => r.payload.date >= weekStart && r.payload.date <= today;
  const weekRuns = qaRuns.filter(inWeek);
  const latestRun = qaRuns[0]?.payload as QaRunEntry | undefined;
  const weekChanges = changes.filter(inWeek);
  const weekByType = (Object.keys(CHANGE_TYPE_LABEL) as ChangeType[])
    .map((t) => [t, weekChanges.filter((c) => c.payload.type === t).length] as const)
    .filter(([, n]) => n > 0);
  const weekBank = bank.filter(inWeek);
  const weekRescored = weekBank.reduce((s, r) => s + (r.payload.rescored ?? 0), 0);
  const weekVerified = weekChanges.filter((c) => c.payload.verified.length > 0).length;

  const qs = (over: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged = { tab, from, to, type: typeFilter, source: sourceFilter, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/admin/reports?${p.toString()}`;
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <PageIntro tKey="admin.reports" />
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Reports</h1>
        <p className="text-sm text-mid-gray mt-1">
          A running log for the current testing stage: what the nightly checks found, what changed and when it went
          live, anything that touched the question bank or students&apos; scores, and what is still waiting on a decision.
        </p>
      </div>
      {loadError && (
        <div className="rounded-xl border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">
          Couldn&apos;t load the log right now ({loadError}). Refresh to try again.
        </div>
      )}

      {/* Weekly summary */}
      <section className={`${card} p-4 space-y-3`}>
        <h2 className="text-sm font-semibold text-charcoal">
          This week <span className="font-normal text-soft-mute">({showDay(weekStart)} – {showDay(today)})</span>
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <div>
            <p className="text-xs text-soft-mute">Nightly QA</p>
            <p className="text-charcoal font-medium">
              {weekRuns.length} run{weekRuns.length === 1 ? "" : "s"}
              {latestRun && (
                <span className="block text-xs font-normal text-mid-gray">
                  Latest {latestRun.passed}/{latestRun.total} passed
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-soft-mute">Changes live</p>
            <p className="text-charcoal font-medium">
              {weekChanges.length}
              <span className="block text-xs font-normal text-mid-gray">
                {weekByType.length
                  ? weekByType.map(([t, n]) => `${n} ${CHANGE_TYPE_LABEL[t].toLowerCase()}`).join(", ")
                  : "none"}
              </span>
            </p>
          </div>
          <div>
            <p className="text-xs text-soft-mute">Verified by a check</p>
            <p className="text-charcoal font-medium">
              {weekVerified} of {weekChanges.length}
            </p>
          </div>
          <div>
            <p className="text-xs text-soft-mute">Question bank / scores</p>
            <p className="text-charcoal font-medium">
              {weekBank.length} change{weekBank.length === 1 ? "" : "s"}
              <span className="block text-xs font-normal text-mid-gray">
                {weekRescored > 0 ? `${weekRescored} attempts rescored` : "no scores changed"}
              </span>
            </p>
          </div>
          <div>
            <p className="text-xs text-soft-mute">Still open</p>
            <p className="text-charcoal font-medium">
              {open.length} item{open.length === 1 ? "" : "s"}
              <span className="block text-xs font-normal text-mid-gray">
                {needsReviewCount} Needs Review · {draftCount} Draft
              </span>
            </p>
          </div>
        </div>
      </section>

      {/* Tabs */}
      <nav className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={qs({ tab: t.key })}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key ? "bg-charcoal text-white" : "bg-surface text-charcoal hover:bg-light-bg"
            }`}
          >
            {t.label}
            {t.key === "open" && open.length > 0 ? ` (${open.length})` : ""}
          </Link>
        ))}
      </nav>

      {/* Filters (plain GET form so it works without client JS) */}
      {tab !== "analytics" && tab !== "open" && (
        <form method="get" action="/admin/reports" className={`${card} p-3 flex flex-wrap items-end gap-3 text-sm`}>
          <input type="hidden" name="tab" value={tab} />
          <label className="flex flex-col gap-1">
            <span className="text-xs text-soft-mute">From</span>
            <input type="date" name="from" defaultValue={from} className="border border-border rounded-md px-2 py-1 bg-surface" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-soft-mute">To</span>
            <input type="date" name="to" defaultValue={to} className="border border-border rounded-md px-2 py-1 bg-surface" />
          </label>
          {tab === "changes" && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-soft-mute">Type</span>
                <select name="type" defaultValue={typeFilter} className="border border-border rounded-md px-2 py-1 bg-surface">
                  <option value="">All types</option>
                  {Object.entries(CHANGE_TYPE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-soft-mute">Source</span>
                <select name="source" defaultValue={sourceFilter} className="border border-border rounded-md px-2 py-1 bg-surface">
                  <option value="">All sources</option>
                  {Object.entries(SOURCE_KIND_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button type="submit" className="px-3 py-1.5 rounded-lg bg-charcoal text-white font-medium">Apply</button>
          {(from || to || typeFilter || sourceFilter) && (
            <Link href={`/admin/reports?tab=${tab}`} className="px-2 py-1.5 text-mid-gray hover:underline">Clear</Link>
          )}
        </form>
      )}

      {tab === "qa" && <QaRuns runs={qaRuns.filter(inRange)} />}
      {tab === "changes" && (
        <Changelog
          rows={changes.filter(
            (r) =>
              inRange(r) &&
              (!typeFilter || r.payload.type === typeFilter) &&
              (!sourceFilter || r.payload.source_kind === sourceFilter),
          )}
        />
      )}
      {tab === "bank" && <BankChanges rows={bank.filter(inRange)} />}
      {tab === "open" && <OpenItems rows={open} needsReview={needsReviewCount} draft={draftCount} />}
      {tab === "analytics" && (
        <div className={`${card} p-6 text-sm text-mid-gray`}>
          Platform analytics (test completion rates, student performance trends, module effectiveness) is coming
          later. While we&apos;re in the testing stage this page is used as the QA and changes log.
        </div>
      )}
    </div>
  );
}

function QaRuns({ runs }: { runs: DevLogRow<QaRunEntry>[] }) {
  if (!runs.length) return <Empty>No QA runs logged for this period.</Empty>;
  return (
    <div className="space-y-3">
      {runs.map(({ id, payload: r }) => {
        const ok = r.passed === r.total;
        return (
          <div key={id} className={`${card} p-4 space-y-2`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-charcoal">{showDay(r.date)}</h3>
              <Pill tone={ok ? "good" : "bad"}>
                {r.passed}/{r.total} passed
              </Pill>
              {r.report_url && (
                <a href={r.report_url} target="_blank" rel="noreferrer" className="text-xs text-warm-coral-dark hover:underline">
                  Full report
                </a>
              )}
            </div>
            {r.notes && <p className="text-sm text-charcoal whitespace-pre-line">{r.notes}</p>}
            {r.failed.length > 0 ? (
              <ul className="text-sm space-y-1.5">
                {r.failed.map((c) => (
                  <li key={c.id} className="border-l-2 border-status-error/50 pl-3">
                    <p className="text-charcoal">
                      <span className="font-mono text-xs">{c.id}</span> <Pill tone="bad">{c.result}</Pill>{" "}
                      {c.title}
                    </p>
                    {c.details && <p className="text-xs text-soft-mute break-words">{c.details}</p>}
                    <p className="text-xs text-mid-gray">
                      What was done: {c.action ? c.action : <span className="italic">not recorded yet</span>}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-mid-gray">All checks passed.</p>
            )}
            {r.checks && r.checks.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-mid-gray">All {r.checks.length} checks</summary>
                <ul className="mt-2 grid md:grid-cols-2 gap-x-4 gap-y-1">
                  {r.checks.map((c) => (
                    <li key={c.id} className="text-xs text-charcoal">
                      <span className={c.result === "PASS" ? "text-status-success" : "text-status-error"}>{c.result}</span>{" "}
                      <span className="font-mono">{c.id}</span> {c.title}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Changelog({ rows }: { rows: DevLogRow<ChangeEntry>[] }) {
  if (!rows.length) return <Empty>No changes match these filters.</Empty>;
  return (
    <div className={`${card} overflow-x-auto`}>
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-light-bg text-left text-xs uppercase text-soft-mute">
          <tr>
            <th className="px-4 py-2.5 w-28">Live</th>
            <th className="px-4 py-2.5">What changed</th>
            <th className="px-4 py-2.5 w-32">Type</th>
            <th className="px-4 py-2.5 w-44">Source</th>
            <th className="px-4 py-2.5 w-32">Affects</th>
            <th className="px-4 py-2.5 w-40">Verified</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, payload: c }) => (
            <tr key={id} className="border-t border-border align-top">
              <td className="px-4 py-3 text-charcoal whitespace-nowrap">{showDay(c.date)}</td>
              <td className="px-4 py-3">
                <p className="font-medium text-charcoal">{c.title}</p>
                {c.body && <p className="text-xs text-mid-gray mt-0.5 whitespace-pre-line">{c.body}</p>}
              </td>
              <td className="px-4 py-3">
                <Pill tone={c.type === "bug" ? "warn" : "neutral"}>{CHANGE_TYPE_LABEL[c.type] ?? c.type}</Pill>
              </td>
              <td className="px-4 py-3 text-xs text-charcoal space-y-0.5">
                <p className="text-soft-mute">{SOURCE_KIND_LABEL[c.source_kind] ?? c.source_kind}</p>
                {c.source && <p>{c.source}</p>}
                <TicketLink id={c.ticket_id} />
              </td>
              <td className="px-4 py-3 text-xs text-charcoal capitalize">{c.roles.length ? c.roles.join(", ") : "—"}</td>
              <td className="px-4 py-3 text-xs">
                {c.verified.length ? (
                  <>
                    <Pill tone="good">Automated check</Pill>
                    <p className="text-soft-mute mt-1 break-words font-mono">{c.verified.join(", ")}</p>
                  </>
                ) : (
                  <Pill>Code change only</Pill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BankChanges({ rows }: { rows: DevLogRow<BankChangeEntry>[] }) {
  if (!rows.length) return <Empty>No question bank or score changes logged for this period.</Empty>;
  return (
    <div className="space-y-3">
      {rows.map(({ id, payload: b }) => (
        <div key={id} className={`${card} p-4 space-y-1`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-soft-mute">{showDay(b.date)}</span>
            <h3 className="font-semibold text-charcoal">{b.title}</h3>
            {b.rescored ? (
              <Pill tone="warn">Scores changed on {b.rescored} attempt{b.rescored === 1 ? "" : "s"}</Pill>
            ) : (
              <Pill>No scores changed</Pill>
            )}
          </div>
          {b.body && <p className="text-sm text-mid-gray whitespace-pre-line">{b.body}</p>}
          {b.ticket_id && (
            <p className="text-xs">
              <TicketLink id={b.ticket_id} />
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function OpenItems({ rows, needsReview, draft }: { rows: DevLogRow<OpenItemEntry>[]; needsReview: number; draft: number }) {
  return (
    <div className="space-y-3">
      <div className={`${card} p-4 flex flex-wrap gap-6 text-sm`}>
        <Link href="/admin/questions" className="hover:underline">
          <span className="text-2xl font-bold text-charcoal">{needsReview}</span>{" "}
          <span className="text-mid-gray">questions in Needs Review</span>
        </Link>
        <Link href="/admin/questions" className="hover:underline">
          <span className="text-2xl font-bold text-charcoal">{draft}</span>{" "}
          <span className="text-mid-gray">questions in Draft</span>
        </Link>
      </div>
      {rows.length === 0 ? (
        <Empty>Nothing is waiting on a decision.</Empty>
      ) : (
        rows.map(({ id, created_at, payload: o }) => (
          <div key={id} className={`${card} p-4 space-y-1`}>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="warn">{o.waiting === "barry" ? "Waiting for Barry" : "Waiting for an admin"}</Pill>
              <h3 className="font-semibold text-charcoal">{o.title}</h3>
            </div>
            {o.body && <p className="text-sm text-mid-gray whitespace-pre-line">{o.body}</p>}
            <p className="text-xs text-soft-mute">
              Opened {formatDateTime(created_at)}
              {o.ticket_id && (
                <>
                  {" · "}
                  <TicketLink id={o.ticket_id} />
                </>
              )}
            </p>
          </div>
        ))
      )}
    </div>
  );
}
