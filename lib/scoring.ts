/**
 * SAT scaled-score estimator.
 *
 * Real SAT scoring uses a section-and-difficulty-specific table that
 * depends on which Module 2 (easy / hard) was served — College Board
 * does not publish a single conversion table. Until we wire up the
 * adaptive Module 2 routing (Sprint 3 item #1), this helper produces
 * a piecewise-linear approximation calibrated against TestNinja's
 * publicly-shared score charts. Scores from this helper should be
 * presented with an "(estimated)" label.
 *
 * Output range: 200..800 per section; 400..1600 total when both
 * sections are available.
 */

export type SatSection = "Math" | "Reading & Writing";

interface Anchor {
  pct: number;
  scaled: number;
}

// Anchor points in percentage (raw-correct / total-questions * 100).
// Tuned to land at the documented endpoints (0%=200, 100%=800) and to
// match TestNinja's mid-range curve where bulk of practice scores fall.
const ANCHORS: Anchor[] = [
  { pct: 0, scaled: 200 },
  { pct: 25, scaled: 340 },
  { pct: 40, scaled: 420 },
  { pct: 55, scaled: 510 },
  { pct: 65, scaled: 570 },
  { pct: 75, scaled: 630 },
  { pct: 85, scaled: 690 },
  { pct: 92, scaled: 740 },
  { pct: 96, scaled: 770 },
  { pct: 100, scaled: 800 },
];

/**
 * Convert a raw-correct percentage (0..100) to a scaled SAT section
 * score (200..800). Output is rounded to the nearest 10 to match SAT's
 * conventional 10-point granularity.
 */
export function scaleSectionScore(percentage: number): number {
  const p = Math.max(0, Math.min(100, percentage));
  for (let i = 1; i < ANCHORS.length; i++) {
    const a = ANCHORS[i - 1];
    const b = ANCHORS[i];
    if (p <= b.pct) {
      const t = (p - a.pct) / (b.pct - a.pct);
      const raw = a.scaled + t * (b.scaled - a.scaled);
      return Math.round(raw / 10) * 10;
    }
  }
  return 800;
}

/**
 * Convenience: combine two section scores into a total. Returns null
 * when either section is missing so callers don't show "200" for
 * not-yet-taken halves.
 */
export function combineSectionScores(
  rw: number | null,
  math: number | null,
): number | null {
  if (rw == null || math == null) return null;
  return rw + math;
}
