import { unstable_cache } from "next/cache";
import { ShieldCheck } from "lucide-react";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { LIVE_FIX_TAG } from "@/lib/live-questions";
import { STUDENT_REPORT_TYPE } from "@/lib/student-reports-shared";
import { STUDENT_VISIBLE_QUESTION_STATUS } from "@/lib/student-exam";
import { formatDuration, reportStats, type ReportRow } from "@/lib/question-quality";

const WINDOW_DAYS = 30;

// Read-only counts (see lib/question-quality.ts for what each one means),
// refreshed at most every 5 minutes, one cache entry per QA side.
const getQuality = unstable_cache(
  async (viewerIsQa: boolean) => {
    const db = getServiceClient();
    const qaUserIds = await getQaUserIds();
    const [approved, liveFix, reports] = await Promise.all([
      db.from("questions").select("id", { count: "exact", head: true }).eq("parsing_status", STUDENT_VISIBLE_QUESTION_STATUS),
      db.from("questions").select("id", { count: "exact", head: true }).ilike("parsing_notes", `${LIVE_FIX_TAG}%`),
      // Every report: one resolved in the window may have come in before it.
      // Students are rate-limited, so this stays small.
      fetchAllRows<ReportRow>((from, to) =>
        scopeIds(
          db
            .from("notifications")
            .select("created_at, status:payload->>status, handled_at:payload->>handled_at")
            .eq("type", STUDENT_REPORT_TYPE),
          "user_id",
          qaUserIds,
          viewerIsQa,
        )
          .order("id")
          .range(from, to) as unknown as PromiseLike<{ data: ReportRow[] | null; error: unknown }>,
      ),
    ]);
    if (approved.error) throw new Error(`approved count failed: ${approved.error.message}`);
    if (liveFix.error) throw new Error(`live-fix count failed: ${liveFix.error.message}`);
    if (reports.error) throw new Error(`student reports lookup failed: ${JSON.stringify(reports.error)}`);
    return {
      approved: approved.count ?? 0,
      liveFixPending: liveFix.count ?? 0,
      reports: reportStats(reports.data, Date.now(), WINDOW_DAYS),
    };
  },
  ["admin-question-quality"],
  { revalidate: 300 },
);

export default async function QuestionQualityCard({ viewerIsQa }: { viewerIsQa: boolean }) {
  let q: Awaited<ReturnType<typeof getQuality>>;
  try {
    q = await getQuality(viewerIsQa);
  } catch (e) {
    console.error("[admin/QuestionQualityCard]", e);
    return (
      <div className="bg-surface border border-divider rounded-2xl p-6 text-sm text-soft-mute">
        Question quality stats couldn&apos;t load right now.
      </div>
    );
  }
  const { approved, liveFixPending, reports } = q;
  const items = [
    { label: "Approved questions", value: approved.toLocaleString("en-US"), href: "/admin/questions?status=Approved" },
    {
      label: "Live fixes to re-check",
      value: liveFixPending,
      href: "/admin/review-queue",
      title: "Questions changed while in a live test. They stay Approved until someone confirms or undoes the change in the Review Queue.",
    },
    { label: `Student reports (last ${WINDOW_DAYS} days)`, value: reports.received, href: "/admin/student-reports?status=all" },
    {
      label: `Reports resolved (last ${WINDOW_DAYS} days)`,
      value: reports.resolved,
      href: "/admin/student-reports?status=all",
      title: "Forwarded to the dev team or dismissed.",
    },
    {
      label: "Median time to resolve",
      value: reports.medianResolveMs != null ? formatDuration(reports.medianResolveMs) : "—",
      title: `From the student's report to forwarded / dismissed, for reports resolved in the last ${WINDOW_DAYS} days.`,
    },
  ];
  return (
    <div className="bg-surface border border-divider rounded-2xl p-6">
      <h2 className="font-semibold text-charcoal flex items-center gap-2 mb-4">
        <ShieldCheck size={16} className="text-status-success" />
        Question quality
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {items.map((it) => {
          const body = (
            <>
              <div className="text-xl font-bold text-charcoal">{it.value}</div>
              <div className="text-mid-gray text-xs mt-0.5">{it.label}</div>
            </>
          );
          const cls = "block rounded-xl border border-divider p-3";
          return it.href ? (
            <a key={it.label} href={it.href} title={it.title} className={`${cls} hover:bg-light-bg transition-colors`}>
              {body}
            </a>
          ) : (
            <div key={it.label} title={it.title} className={cls}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
