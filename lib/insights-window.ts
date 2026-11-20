// One window for a student's insight blocks (support a05ff7b7).
//
// "Strengths & Focus Areas" and "Progress Over Time" used to read different
// data: strengths added up every test, progress compared the first test
// with the last. Both now read the same window of tests: by default the
// last INSIGHTS_RECENT_TESTS tests PER SECTION (the last 3 tests with Math
// for Math skills, the last 3 with R&W for R&W skills; a full-length SAT
// counts for both), or all of them. Pure: no DB.

import {
  computeBreakdown,
  computeProgress,
  type AnswerRow,
  type Breakdown,
  type Occasion,
  type Progress,
} from "@/lib/score-analysis";

/** Default window: the last 3 tests of each section. */
export const INSIGHTS_RECENT_TESTS = 3;

export type InsightsWindow = "recent" | "all";

/** The test an occasion belongs to: a full-length SAT's two sections are one test. */
const testKeyOf = (o: Occasion) => o.testKey ?? `${o.date}|${o.label ?? ""}`;

/** The section an occasion scores (its own, else the section most of its questions are in). */
function sectionOf(o: Occasion): string {
  if (o.section) return o.section;
  const n = new Map<string, number>();
  for (const r of o.rows) n.set(r.section ?? "Other", (n.get(r.section ?? "Other") ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Other";
}

/** Number of distinct tests among these occasions (a full-length SAT = 1). */
export function countTests(occasions: Occasion[]): number {
  return new Set(occasions.filter((o) => o.rows.length > 0).map(testKeyOf)).size;
}

/** Distinct tests per section ("Math" → 4); a full-length SAT counts for both its sections. */
export function testsPerSection(occasions: Occasion[]): Map<string, number> {
  const keys = new Map<string, Set<string>>();
  for (const o of occasions) {
    if (o.rows.length === 0) continue;
    const s = sectionOf(o);
    keys.set(s, (keys.get(s) ?? new Set()).add(testKeyOf(o)));
  }
  return new Map([...keys].map(([s, k]) => [s, k.size]));
}

/**
 * The occasions in the window, oldest first. "recent" keeps, for each
 * section, the last `n` tests that include it (a test = every occasion of
 * that section sharing a testKey; dated by its latest occasion), so a
 * student alternating Math and R&W days keeps both trends. "all" keeps
 * every test. Occasions with no answer rows are dropped either way.
 */
export function windowOccasions(
  occasions: Occasion[],
  window: InsightsWindow,
  n: number = INSIGHTS_RECENT_TESTS,
): Occasion[] {
  const withRows = occasions.filter((o) => o.rows.length > 0);
  let kept = withRows;
  if (window === "recent") {
    const keyOf = (o: Occasion) => `${sectionOf(o)}|||${testKeyOf(o)}`;
    const lastDate = new Map<string, { section: string; date: string }>();
    for (const o of withRows) {
      const k = keyOf(o);
      const cur = lastDate.get(k);
      if (!cur || cur.date < o.date) lastDate.set(k, { section: sectionOf(o), date: o.date });
    }
    const keep = new Set<string>();
    const bySection = new Map<string, [string, string][]>();
    for (const [k, v] of lastDate) bySection.set(v.section, [...(bySection.get(v.section) ?? []), [k, v.date]]);
    for (const list of bySection.values()) {
      list
        .sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]))
        .slice(0, Math.max(0, n))
        .forEach(([k]) => keep.add(k));
    }
    kept = withRows.filter((o) => keep.has(keyOf(o)));
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
  /** Some section has more than `n` tests, so "recent" and "all" differ (show the toggle). */
  hasMore: boolean;
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
    hasMore: [...testsPerSection(occasions).values()].some((c) => c > n),
    rows,
    breakdown: computeBreakdown(rows),
    progress,
    declining: decliningDomains(progress),
  };
}
