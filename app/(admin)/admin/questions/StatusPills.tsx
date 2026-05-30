import { getServiceClient } from "@/lib/supabase";

async function getStatusCounts() {
  const db = getServiceClient();
  const statuses = ["Approved", "Draft", "Needs Review", "Rejected"] as const;
  const counts = await Promise.all(
    statuses.map(async (s) => {
      const { count } = await db
        .from("questions")
        .select("id", { count: "exact", head: true })
        .eq("parsing_status", s);
      return { status: s, count: count ?? 0 };
    }),
  );
  return counts;
}

export default async function StatusPills() {
  const counts = await getStatusCounts();
  const styles: Record<string, string> = {
    Approved: "bg-status-success/10 text-status-success border-status-success/20 hover:bg-status-success/20",
    Draft: "bg-light-bg text-soft-mute border-divider hover:bg-divider",
    "Needs Review": "bg-status-warning/10 text-status-warning border-status-warning/20 hover:bg-status-warning/20",
    Rejected: "bg-status-error/10 text-status-error border-status-error/20 hover:bg-status-error/20",
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-soft-mute mr-1">Review queue:</span>
      {counts.map(({ status, count }) => (
        <a
          key={status}
          href={`/admin/questions?status=${encodeURIComponent(status)}`}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border font-medium transition-colors ${styles[status]}`}
        >
          <span>{status}</span>
          <span className="text-xs font-mono">{count}</span>
        </a>
      ))}
    </div>
  );
}
