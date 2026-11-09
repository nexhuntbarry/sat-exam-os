import { StatusBadge } from "@/components/ui/StatusBadge";
import { getServiceClient } from "@/lib/supabase";
import { LIVE_FIX_TAG } from "@/lib/live-questions";
import { spotCheckLine, spotCheckStats } from "@/lib/spot-check";

// Question Bank counts (Premier 2026-11-07, Question Bank item 4): the
// system / person split is part of Approved, not a separate status, so it
// reads "Approved 1896 (system 1599 · person 297)", with the spot-check
// result and the live-fix count (a Review Queue group) beside it.
async function getCounts() {
  const db = getServiceClient();
  const statuses = ["Approved", "Needs Review", "Draft", "Rejected"] as const;
  const [statusCounts, liveFixRes, spot] = await Promise.all([
    Promise.all(
      statuses.map(async (s) => {
        const { count } = await db.from("questions").select("id", { count: "exact", head: true }).eq("parsing_status", s);
        return { status: s, count: count ?? 0 };
      }),
    ),
    // Changed while in a live test — kept Approved, tagged "[live-fix]" for a
    // person to Confirm or Undo in the Review Queue (lib/live-fix.ts).
    db.from("questions").select("id", { count: "exact", head: true }).ilike("parsing_notes", `${LIVE_FIX_TAG}%`),
    spotCheckStats(db),
  ]);
  return { statusCounts, liveFixCount: liveFixRes.count ?? 0, spot };
}

const pill = "flex items-center gap-2 px-2 py-1 rounded-lg border border-divider bg-surface hover:bg-light-bg transition-colors";

export default async function StatusPills() {
  const { statusCounts, liveFixCount, spot } = await getCounts();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-soft-mute mr-1">Questions:</span>
      {statusCounts.map(({ status, count }) =>
        status === "Approved" ? (
          <span key={status} className="flex flex-wrap items-center gap-1 rounded-lg border border-divider bg-surface px-2 py-1">
            <a href="/admin/questions?status=Approved" className="flex items-center gap-2 hover:opacity-80">
              <StatusBadge kind="question" status="Approved" />
              <span className="text-xs font-mono text-mid-gray">{count}</span>
            </a>
            <span className="text-xs text-soft-mute">
              (
              <a href="/admin/questions?status=Approved&autoApproved=true" className="underline-offset-2 hover:underline" title="Approved by the system: every automatic check passed (no person reviewed it)">
                system {spot.system}
              </a>{" "}
              · person {spot.person})
            </span>
          </span>
        ) : (
          <a key={status} href={status === "Needs Review" ? "/admin/review-queue" : `/admin/questions?status=${encodeURIComponent(status)}`} className={pill}>
            <StatusBadge kind="question" status={status} />
            <span className="text-xs font-mono text-mid-gray">{count}</span>
          </a>
        ),
      )}
      <span
        className={`rounded-lg border px-2 py-1 text-xs ${spot.paused ? "border-status-error/30 bg-status-error/10 font-semibold text-status-error" : "border-divider bg-surface text-mid-gray"}`}
        title="A random 5% of the system-approved questions is re-checked independently (code solve + second solve). Automatic approval pauses if the error rate goes above 5%."
      >
        {spotCheckLine(spot)}
        {spot.paused ? " · automatic approval paused" : ""}
      </span>
      {liveFixCount > 0 && (
        <a
          href="/admin/review-queue?group=live_fix"
          className="flex items-center gap-2 px-2 py-1 rounded-lg border font-medium transition-colors bg-status-warning/12 text-status-warning border-status-warning/20 hover:bg-status-warning/20"
          title="Changed while students are taking the test. Kept Approved; Confirm or Undo each one in the Review Queue."
        >
          <span>Fixed in a live test · Confirm or Undo</span>
          <span className="text-xs font-mono">{liveFixCount}</span>
        </a>
      )}
    </div>
  );
}
