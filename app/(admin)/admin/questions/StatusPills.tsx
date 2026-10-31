import { StatusBadge } from "@/components/ui/StatusBadge";
import { getServiceClient } from "@/lib/supabase";
import { LIVE_FIX_TAG } from "@/lib/live-questions";

async function getCounts() {
  const db = getServiceClient();
  const statuses = ["Approved", "Draft", "Needs Review", "Rejected"] as const;
  const [statusCounts, autoApprovedRes, liveFixRes] = await Promise.all([
    Promise.all(
      statuses.map(async (s) => {
        const { count } = await db
          .from("questions")
          .select("id", { count: "exact", head: true })
          .eq("parsing_status", s);
        return { status: s, count: count ?? 0 };
      }),
    ),
    // Rows the auto-promote-high-confidence script approved without a
    // human reviewer (reviewed_by IS NULL). Pinned as its own pill so
    // the admin can jump straight into the sample audit.
    db
      .from("questions")
      .select("id", { count: "exact", head: true })
      .eq("parsing_status", "Approved")
      .is("reviewed_by", null),
    // Fixed by an automatic tool while in a live test — kept Approved and
    // tagged "[live-fix]" for a person to re-check (lib/live-questions.ts).
    db
      .from("questions")
      .select("id", { count: "exact", head: true })
      .ilike("parsing_notes", `${LIVE_FIX_TAG}%`),
  ]);
  return {
    statusCounts,
    autoApprovedCount: autoApprovedRes.count ?? 0,
    liveFixCount: liveFixRes.count ?? 0,
  };
}

export default async function StatusPills() {
  const { statusCounts, autoApprovedCount, liveFixCount } = await getCounts();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-soft-mute mr-1">Review queue:</span>
      {statusCounts.map(({ status, count }) => (
        <a
          key={status}
          href={`/admin/questions?status=${encodeURIComponent(status)}`}
          className="flex items-center gap-2 px-2 py-1 rounded-lg border border-divider bg-surface hover:bg-light-bg transition-colors"
        >
          <StatusBadge kind="question" status={status} />
          <span className="text-xs font-mono text-mid-gray">{count}</span>
        </a>
      ))}
      {autoApprovedCount > 0 && (
        <a
          href="/admin/questions?status=Approved&autoApproved=true"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border font-medium transition-colors bg-warm-coral/10 text-warm-coral-text border-warm-coral/20 hover:bg-warm-coral/20"
          title="Approved by the auto-promote-high-confidence script (reviewed_by IS NULL). Sample-audit before trusting."
        >
          <span>⚠ Auto-approved · audit me</span>
          <span className="text-xs font-mono">{autoApprovedCount}</span>
        </a>
      )}
      {liveFixCount > 0 && (
        <a
          href="/admin/questions?status=Approved&liveFix=true"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border font-medium transition-colors bg-status-warning/12 text-status-warning border-status-warning/20 hover:bg-status-warning/20"
          title="Changed by an automatic tool while in a live test. Kept Approved so students still see it — re-check, then approve to clear."
        >
          <span>Fixed in a live test · re-check</span>
          <span className="text-xs font-mono">{liveFixCount}</span>
        </a>
      )}
    </div>
  );
}
