import { scaleSectionScore } from "@/lib/scoring";

// One score display everywhere (support f83c766b): SAT section score first,
// per-module correct counts second. No per-module SAT estimate (the real SAT
// only reports section and total scores); % is secondary text only.

/** Questions per module on a full SAT. Fewer scored means some were left
 *  out (Needs Review questions aren't shown to students or scored). */
export const FULL_MODULE: Record<string, number> = { "Reading & Writing": 27, Math: 22 };

export interface ScoreModule {
  number: number;
  /** false = not finished yet. */
  graded: boolean;
  correct: number | null;
  total: number | null;
}

export interface ScoreDisplay {
  /** SAT section score (200–800); null until every module is finished. */
  sat: number | null;
  /** "M1 22/27 · M2 18/27", "M1 15/27 · M2 —" or "22/27" for one module. */
  modules: string;
  /** Percent correct across finished modules (secondary text only). */
  pct: number | null;
  /** "M1: 1 question in review, not scored". */
  notes: string[];
}

/** Percent rounded the way grading stores it (1 decimal). */
export function pctOf(correct: number, total: number): number | null {
  return total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
}

/** SAT section score from raw counts, same rounding as grading. */
export function satFromCounts(correct: number, total: number): number | null {
  const p = pctOf(correct, total);
  return p == null ? null : scaleSectionScore(p);
}

/** Build the score cell for one attempt. Returns null when nothing has been
 *  started (render "—"). */
export function scoreDisplay(modules: ScoreModule[], section: string | null | undefined): ScoreDisplay | null {
  if (modules.length === 0) return null;
  const two = modules.length > 1;
  const full = section ? FULL_MODULE[section] : undefined;
  const notes: string[] = [];
  const parts = modules.map((m) => {
    const tag = two ? `M${m.number} ` : "";
    if (!m.graded) return `${tag}—`;
    const missing = full != null && m.total != null ? full - m.total : 0;
    if (missing > 0) {
      notes.push(`${two ? `M${m.number}: ` : ""}${missing} question${missing === 1 ? "" : "s"} in review, not scored`);
    }
    return `${tag}${m.correct ?? 0}/${m.total ?? 0}`;
  });
  const done = modules.filter((m) => m.graded);
  const correct = done.reduce((n, m) => n + (m.correct ?? 0), 0);
  const total = done.reduce((n, m) => n + (m.total ?? 0), 0);
  const finished = done.length === modules.length;
  return {
    sat: finished ? satFromCounts(correct, total) : null,
    modules: parts.join(" · "),
    pct: finished ? pctOf(correct, total) : null,
    notes,
  };
}

/** Mean of SAT scores, rounded to a whole number. */
export function averageSat(scores: (number | null | undefined)[]): number | null {
  const xs = scores.filter((x): x is number => x != null);
  return xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}
