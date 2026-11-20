// One window for a student's insight blocks (support a05ff7b7).
//
// "Strengths & Focus Areas" and "Progress Over Time" used to read different
// data: strengths added up every test, progress compared the first test
// with the last. Both now read the same window of tests: by default the
// student's last INSIGHTS_RECENT_TESTS tests, or all of them. Pure: no DB.

import {
  computeBreakdown,
  computeProgress,
  type AnswerRow,
  type Breakdown,
  type Occasion,
  type Progress,
} from "@/lib/score-analysis";

/** Default window: the student's last 3 tests. */
export const INSIGHTS_RECENT_TESTS = 3;

export type InsightsWindow = "recent" | "all";

/** The test an occasion belongs to: a full-length SAT's two sections are one test. */
const testKeyOf = (o: Occasion) => o.testKey ?? `${o.date}|${o.label ?? ""}`;

/** Number of distinct tests among these occasions. */
export function countTests(occasions: Occasion[]): number {
  return new Set(occasions.filter((o) => o.rows.length > 0).map(testKeyOf)).size;
}

/**
 * The occasions in the window, oldest first. "recent" keeps the last `n`
 * tests (a test = every occasion sharing a testKey; its date is its latest
 * occasion's), "all" keeps every test. Occasions with no answer rows are
 * dropped either way.
 */
export function windowOccasions(
  occasions: Occasion[],
  window: InsightsWindow,
  n: number = INSIGHTS_RECENT_TESTS,
): Occasion[] {
  const withRows = occasions.filter((o) => o.rows.length > 0);
  let kept = withRows;
  if (window === "recent") {
    const lastDate = new Map<string, string>();
    for (const o of withRows) {
      const k = testKeyOf(o);
      if ((lastDate.get(k) ?? "") < o.date) lastDate.set(k, o.date);
    }
    const keep = new Set(
      [...lastDate.entries()]
        .sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]))
        .slice(0, Math.max(0, n))
        .map(([k]) => k),
    );
    kept = withRows.filter((o) => keep.has(testKeyOf(o)));
  }
  return [...kept].sort((a, b) => a.date.localeCompare(b.date));
}

export interface WindowInsights {
  window: InsightsWindow;
  /** Occasions in the window, oldest first. */
  occasions: Occasion[];
  /** Tests in the window / tests overall. */
  tests: number;
  totalTests: number;
  /** Every answer in the window (what Strengths & Focus Areas adds up). */
  rows: AnswerRow[];
  breakdown: Breakdown;
  /** Earlier → later tests within the same window (null under 2 tests). */
  progress: Progress | null;
  /**
   * Domains clearly slipping inside the window (a comparable "down" trend):
   * never labelled a strength, so the two blocks can't say "strength" and
   * "−22%" about the same domain.
   */
  declining: Set<string>;
}

/** Domains with a comparable downward trend. */
export function decliningDomains(progress: Progress | null): Set<string> {
  return new Set((progress?.domains ?? []).filter((d) => d.comparable && d.trend === "down").map((d) => d.domain));
}

/** Strengths (breakdown) and progress, both from the same window. */
export function insightsForWindow(
  occasions: Occasion[],
  window: InsightsWindow,
  n: number = INSIGHTS_RECENT_TESTS,
): WindowInsights {
  const occ = windowOccasions(occasions, window, n);
  const rows = occ.flatMap((o) => o.rows);
  const progress = computeProgress(occ);
  return {
    window,
    occasions: occ,
    tests: countTests(occ),
    totalTests: countTests(occasions),
    rows,
    breakdown: computeBreakdown(rows),
    progress,
    declining: decliningDomains(progress),
  };
}
