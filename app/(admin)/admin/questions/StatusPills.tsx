import { getServiceClient } from "@/lib/supabase";

async function getCounts() {
  const db = getServiceClient();
  const statuses = ["Approved", "Draft", "Needs Review", "Rejected"] as const;
  const [statusCounts, autoApprovedRes] = await Promise.all([
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
  ]);
  return { statusCounts, autoApprovedCount: autoApprovedRes.count ?? 0 };
}

export default async function StatusPills() {
  const { statusCounts, autoApprovedCount } = await getCounts();
  const styles: Record<string, string> = {
    Approved: "bg-status-success/10 text-status-success border-status-success/20 hover:bg-status-success/20",
    Draft: "bg-light-bg text-soft-mute border-divider hover:bg-divider",
    "Needs Review": "bg-status-warning/10 text-status-warning border-status-warning/20 hover:bg-status-warning/20",
    Rejected: "bg-status-error/10 text-status-error border-status-error/20 hover:bg-status-error/20",
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-soft-mute mr-1">Review queue:</span>
      {statusCounts.map(({ status, count }) => (
        <a
          key={status}
          href={`/admin/questions?status=${encodeURIComponent(status)}`}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border font-medium transition-colors ${styles[status]}`}
        >
          <span>{status}</span>
          <span className="text-xs font-mono">{count}</span>
        </a>
      ))}
      {autoApprovedCount > 0 && (
        <a
          href="/admin/questions?status=Approved&autoApproved=true"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border font-medium transition-colors bg-warm-coral/10 text-warm-coral border-warm-coral/20 hover:bg-warm-coral/20"
          title="Approved by the auto-promote-high-confidence script (reviewed_by IS NULL). Sample-audit before trusting."
        >
          <span>⚠ Auto-approved · audit me</span>
          <span className="text-xs font-mono">{autoApprovedCount}</span>
        </a>
      )}
    </div>
  );
}
