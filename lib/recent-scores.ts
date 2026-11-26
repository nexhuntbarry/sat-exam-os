// "Recent practice tests" block on the student pages (support a05ff7b7).
//
// The pages already score every attempt with the shared helpers
// (lib/score-display scoreDisplay / attemptScore, lib/full-length-score);
// this only orders the finished ones newest first and adds the change vs.
// the previous test of the same kind. Pure: no DB, no new scoring.

/** Rows shown before "Show all". */
export const RECENT_SCORES_DEFAULT = 6;

export interface RecentScoreSection {
  /** "Reading & Writing" | "Math". */
  section: string;
  /** SAT section score (200–800); null when the helpers give none. */
  sat: number | null;
  /** M1 / M2 correct, e.g. ["22/27", "18/27"]. */
  modules: string[];
}

export interface RecentScoreItem {
  key: string;
  /** Last submitted_at of the attempt. */
  date: string;
  testName: string;
  href?: string | null;
  /** "section": one section test; "full": a full-length SAT (one row, real total). */
  kind: "section" | "full";
  /** The section test's section, or the full-length's two sections. */
  sections: RecentScoreSection[];
  /** Full-length total (400–1600); null for a section test. */
  total: number | null;
  /** A Custom test: the score is an estimate. */
  estimated?: boolean;
  /** A section test that completes an R&W + Math set (lib/test-pairing): the set's total. */
  set?: RecentSetTotal | null;
}

export interface RecentSetTotal {
  /** 400–1600, R&W + Math of the set. */
  total: number;
  /** The set's name; null for a same-day pair of differently named tests. */
  name: string | null;
}

/**
 * Submission id → the set total, for each section attempt in an R&W + Math
 * set (lib/one-page-report buildAssessments: pair assessments only). A
 * recent-tests row finds its set through one of its submission ids.
 */
export function setTotalsBySubmission(
  assessments: { kind: string; name: string | null; total: number | null; rw: { submissionIds: string[] } | null; math: { submissionIds: string[] } | null }[],
): Map<string, RecentSetTotal> {
  const out = new Map<string, RecentSetTotal>();
  for (const a of assessments) {
    if (a.kind !== "pair" || a.total == null) continue;
    for (const id of [...(a.rw?.submissionIds ?? []), ...(a.math?.submissionIds ?? [])]) out.set(id, { total: a.total, name: a.name });
  }
  return out;
}

export interface RecentScoreRow extends RecentScoreItem {
  /** The score compared: the full-length total, or the section score. */
  score: number | null;
  /** vs. the previous test of the same kind (same section, or full-length vs full-length). */
  change: { delta: number; vsDate: string } | null;
}

/**
 * What a row is compared with: full-length totals with full-length totals,
 * section scores with the same section's, estimates with estimates.
 */
function chainKey(it: RecentScoreItem): string {
  const base = it.kind === "full" ? "full" : `section:${it.sections[0]?.section ?? ""}`;
  return it.estimated ? `${base}:est` : base;
}

const scoreOf = (it: RecentScoreItem) => (it.kind === "full" ? it.total : it.sections[0]?.sat ?? null);

/** Newest first, each with its change vs. the previous scored test of the same kind. */
export function recentScoreRows(items: RecentScoreItem[]): RecentScoreRow[] {
  const oldestFirst = [...items].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const last = new Map<string, { score: number; date: string }>();
  const rows: RecentScoreRow[] = [];
  for (const it of oldestFirst) {
    const score = scoreOf(it);
    const k = chainKey(it);
    const prev = last.get(k);
    rows.push({
      ...it,
      score,
      change: score != null && prev ? { delta: score - prev.score, vsDate: prev.date } : null,
    });
    if (score != null) last.set(k, { score, date: it.date });
  }
  return rows.reverse();
}

/** "+30", "−20", "±0". */
export function formatScoreChange(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : "±0";
}
