import { getTranslations } from "next-intl/server";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import ProgressReport from "@/components/analytics/ProgressReport";
import InsightsWindowToggle from "@/components/analytics/InsightsWindowToggle";
import { INSIGHTS_RECENT_TESTS, insightsForWindow, type WindowInsights } from "@/lib/insights-window";
import type { Occasion } from "@/lib/score-analysis";

/**
 * "Strengths & Focus Areas" + "Progress Over Time", both read from the same
 * window of tests (lib/insights-window): the last INSIGHTS_RECENT_TESTS of
 * each section by default, "All tests" on the toggle. When no section has
 * more tests than that, the two windows are the same and no toggle is shown.
 */
export default async function StudentInsights({
  occasions,
  strengthsTitle = "Strengths & Focus Areas",
  progressTitle = "Progress Over Time",
  name,
}: {
  occasions: Occasion[];
  strengthsTitle?: string;
  progressTitle?: string;
  /** Student name for the progress subtitle (omit on the student's own page). */
  name?: string;
}) {
  const recent = insightsForWindow(occasions, "recent");
  if (recent.rows.length === 0) return null;
  const t = await getTranslations("studentInsights");
  const blocks = (w: WindowInsights) => {
    const scope =
      w.window === "recent" && w.hasMore
        ? t("scopeRecent", { n: INSIGHTS_RECENT_TESTS, used: w.tests, total: w.totalTests })
        : t("scopeAll", { n: w.totalTests });
    return (
      <div className="space-y-6">
        <ScoreBreakdown rows={w.rows} title={strengthsTitle} subtitle={scope} notStrengths={w.declining} />
        <ProgressReport
          occasions={w.occasions}
          title={progressTitle}
          subtitle={name ? `${name} · ${scope}` : scope}
        />
      </div>
    );
  };
  if (!recent.hasMore) return blocks(recent);
  const list = Array.from(new Set(recent.occasions.map((o) => o.label ?? "Test"))).join(", ");
  return (
    <InsightsWindowToggle
      recentTests={INSIGHTS_RECENT_TESTS}
      totalTests={recent.totalTests}
      recentList={list}
      recent={blocks(recent)}
      all={blocks(insightsForWindow(occasions, "all"))}
    />
  );
}
