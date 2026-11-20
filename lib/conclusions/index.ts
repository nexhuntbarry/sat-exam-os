// Three short rule-based conclusions for a student's Overview (support
// a05ff7b7): top strength, top focus area, one test-habit finding. No AI:
// each segment picks one sentence template from a bank of ~100
// (lib/conclusions/templates.{en,zh}) and fills in the student's numbers.
//
// Deterministic: the template is chosen by a hash of student id + latest
// test + segment, among the templates whose conditions the data meets, so
// the same data always reads the same way and a template never claims what
// the numbers don't say (e.g. "climbing" only on a comparable upward trend).
//
// Data window: the same one as Strengths & Focus Areas (lib/insights-window,
// last 3 tests per section). Pure: no DB.
//
// Strength: the highest-% domain in the window with at least
//   MIN_QUESTIONS_TO_COMPARE questions that is not slipping (a comparable
//   drop of 5+ points is never a strength).
// Focus: the lowest-% domain with at least MIN_QUESTIONS_TO_COMPARE
//   questions, other than the strength.
// Test habit: the first rule below that fires (HABIT_RULES has the numbers):
//   1. blanks       — questions left blank (no penalty for guessing).
//   2. clock        — at least half the timed modules used 95%+ of the time.
//   3. secondGuess  — changed answers end right clearly less often than kept ones.
//   4. quickMisses  — many misses answered much faster than the student's usual correct answer.
//   5. slowMisses   — misses take far longer than correct answers (time sinks).
//   6. m2Drop       — Module 2 accuracy well below Module 1 (hard adaptive Module 2 left out:
//                     it is harder by design).
//   7. earlyFinish  — modules finish with lots of time left and accuracy under 90%.
//   8. steady       — none of the above: accuracy (and pace, when timed).
// Per-question time and answer changes count only where the take page
// measured them (question_activity); older attempts stored an even split.

import { insightsForWindow, countTests } from "@/lib/insights-window";
import { MIN_QUESTIONS_TO_COMPARE, type AnswerRow, type DomainStat, type DomainTrend, type Occasion } from "@/lib/score-analysis";

export type Lang = "en" | "zh";
export type Segment = "strength" | "focus" | "habit";
export type HabitKind =
  | "blanks"
  | "clock"
  | "secondGuess"
  | "quickMisses"
  | "slowMisses"
  | "m2Drop"
  | "earlyFinish"
  | "steady";
export const HABIT_KINDS: HabitKind[] = ["blanks", "clock", "secondGuess", "quickMisses", "slowMisses", "m2Drop", "earlyFinish", "steady"];

/**
 * A language's sentence bank. A template is "text" or "tag1,tag2::text";
 * it is eligible only when the data has every tag. Placeholders: {name}.
 */
export interface TemplateBank {
  strength: string[];
  focus: string[];
  habit: Record<HabitKind, string[]>;
  fallback: { thin: string; noStrength: string; noFocus: string; noHabit: string };
  /** Display name of a domain / section. */
  domain: (name: string) => string;
  section: (name: string) => string;
}

export const HABIT_RULES = {
  /** blanks: at least this many blank answers in the window. */
  blanksMin: 2,
  /** clock: a module "ran close" at this share of its limit… */
  clockShare: 0.95,
  /** …in at least this share of the timed modules (and 2+ timed modules). */
  clockModulesShare: 0.5,
  /** secondGuess: changed answers (measured) at least… */
  changedMin: 4,
  /** …and their accuracy this many points below kept answers. */
  changedGap: 20,
  /** quickMisses: a miss faster than this share of the median correct time (and under quickMaxSeconds)… */
  quickShare: 0.4,
  quickMaxSeconds: 30,
  /** …at least this many, and this share of the measured misses. */
  quickMin: 3,
  quickOfMisses: 0.4,
  /** slowMisses: average miss time ≥ this × average correct time, and ≥ slowMinSeconds. */
  slowRatio: 1.8,
  slowMinSeconds: 60,
  slowMissesMin: 3,
  /** m2Drop: Module 1 vs Module 2 accuracy gap (points), each side with ≥ m2MinQuestions. */
  m2Gap: 10,
  m2MinQuestions: 10,
  /** earlyFinish: average share of the clock used at most this, accuracy under earlyMaxAcc. */
  earlyShare: 0.75,
  earlyMaxAcc: 90,
  /** Timed modules needed for any clock-based rule. */
  timedMin: 2,
  /** steady: measured answers needed to say "no rushing / stalling pattern". */
  measuredMin: 20,
} as const;

export interface HabitFinding {
  kind: HabitKind;
  tags: string[];
  vars: Record<string, number>;
}

export interface Conclusion {
  segment: Segment;
  text: string;
  /** The template's index in its list (tests / debugging). */
  template: number;
  /** Strength / focus: the domain named. */
  domain?: string;
  /** Habit: the rule that fired. */
  habit?: HabitKind;
}

export type ConclusionsResult =
  | { thin: true; message: string }
  | { thin: false; items: Conclusion[] };

// ── Deterministic pick ───────────────────────────────────────────────
/** FNV-1a 32-bit. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Split "tag1,tag2::text" into tags + text. */
export function parseTemplate(t: string): { tags: string[]; text: string } {
  const i = t.indexOf("::");
  if (i < 0) return { tags: [], text: t };
  return { tags: t.slice(0, i).split(",").map((x) => x.trim()).filter(Boolean), text: t.slice(i + 2) };
}

/** Templates whose tags the data has (index into the full list kept). */
export function eligible(list: string[], tags: readonly string[]): { index: number; text: string }[] {
  const have = new Set(tags);
  return list
    .map((t, index) => ({ index, ...parseTemplate(t) }))
    .filter((t) => t.tags.every((x) => have.has(x)))
    .map(({ index, text }) => ({ index, text }));
}

function formatValue(v: string | number): string {
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Fill {name} placeholders; unknown ones are left as-is (tests catch them). */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? formatValue(vars[k]) : m));
}

function choose(list: string[], tags: string[], seed: string): { index: number; text: string } | null {
  const pool = eligible(list, tags);
  if (pool.length === 0) return null;
  return pool[hashSeed(seed) % pool.length];
}

// ── Strength / focus ─────────────────────────────────────────────────
export interface DomainPick {
  stat: DomainStat;
  trend: DomainTrend | null;
  /** Tests in the window that include this domain. */
  tests: number;
}

const tierTag = (pct: number) => (pct >= 85 ? "high" : pct >= 70 ? "solid" : "low");

/** Strongest and weakest domains in the window (rules in the header). */
export function pickDomains(windowOccasions: Occasion[], insights: ReturnType<typeof insightsForWindow>): {
  strength: DomainPick | null;
  focus: DomainPick | null;
} {
  const enough = insights.breakdown.domains.filter((d) => d.total >= MIN_QUESTIONS_TO_COMPARE);
  const trendOf = (d: DomainStat) =>
    insights.progress?.domains.find((t) => t.domain === d.domain && t.section === d.section) ?? null;
  const testsWith = (d: DomainStat) =>
    new Set(
      windowOccasions
        .filter((o) => o.rows.some((r) => r.domain === d.domain && (r.section ?? "Other") === d.section))
        .map((o) => o.testKey ?? o.key ?? o.date),
    ).size;
  const toPick = (d: DomainStat): DomainPick => ({ stat: d, trend: trendOf(d), tests: testsWith(d) });
  // breakdown.domains is strongest → weakest (pct, then more questions).
  const s = enough.find((d) => !insights.declining.has(d.domain));
  const weakest = [...enough].sort((a, b) => a.pct - b.pct || b.total - a.total);
  // Below the strength, or "lowest" would read oddly next to a tie.
  const f = weakest.find((d) => d !== s && (!s || d.pct < s.pct));
  return { strength: s ? toPick(s) : null, focus: f ? toPick(f) : null };
}

export function domainTags(p: DomainPick): string[] {
  const tags = [tierTag(p.stat.pct)];
  if (p.tests >= 2) tags.push("multi");
  if (p.trend?.comparable) tags.push(p.trend.trend === "up" ? "rising" : p.trend.trend === "down" ? "falling" : "steady");
  return tags;
}

export function domainVars(p: DomainPick, bank: TemplateBank): Record<string, string | number> {
  const v: Record<string, string | number> = {
    domain: bank.domain(p.stat.domain),
    section: bank.section(p.stat.section),
    pct: p.stat.pct,
    correct: p.stat.correct,
    total: p.stat.total,
  };
  if (p.tests >= 2) v.tests = p.tests;
  if (p.trend?.comparable) {
    v.early = p.trend.earlyPct;
    v.recent = p.trend.recentPct;
    v.delta = Math.abs(p.trend.delta);
  }
  return v;
}

// ── Test habit ───────────────────────────────────────────────────────
const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The most notable test habit in these occasions (rules in the header), or null with no answers. */
export function habitFinding(occasions: Occasion[]): HabitFinding | null {
  const R = HABIT_RULES;
  const rows: AnswerRow[] = occasions.flatMap((o) => o.rows);
  if (rows.length === 0) return null;
  const tests = countTests(occasions);
  const correct = rows.filter((r) => r.is_correct).length;
  const acc = pctOf(correct, rows.length);

  // 1. Blanks.
  const blanks = rows.filter((r) => r.answered === false).length;
  if (blanks >= R.blanksMin) {
    return { kind: "blanks", tags: tests >= 2 ? ["multi"] : [], vars: { blanks, questions: rows.length, tests } };
  }

  // Module clocks with both a limit and a time.
  const timed = occasions
    .flatMap((o) => o.clocks ?? [])
    .filter((c) => c.limitSeconds != null && c.limitSeconds > 0 && c.usedSeconds != null && c.usedSeconds > 0);
  const shares = timed.map((c) => Math.min(1, c.usedSeconds! / c.limitSeconds!));
  const usedPct = Math.round(avg(shares) * 100);

  // 2. Clock pressure.
  if (timed.length >= R.timedMin) {
    const close = shares.filter((s) => s >= R.clockShare);
    if (close.length >= Math.max(2, Math.ceil(timed.length * R.clockModulesShare))) {
      return {
        kind: "clock",
        tags: [],
        vars: { close: close.length, timed: timed.length, closePct: Math.round(avg(close) * 100) },
      };
    }
  }

  // Measured per-question time / changes.
  const measured = rows.filter((r) => r.seconds != null && r.answered !== false);

  // 3. Second-guessing.
  const changed = measured.filter((r) => r.changed);
  const kept = measured.filter((r) => !r.changed);
  if (changed.length >= R.changedMin && kept.length > 0) {
    const changedPct = pctOf(changed.filter((r) => r.is_correct).length, changed.length);
    const keptPct = pctOf(kept.filter((r) => r.is_correct).length, kept.length);
    if (keptPct - changedPct >= R.changedGap) {
      return {
        kind: "secondGuess",
        tags: [],
        vars: { changed: changed.length, changedRight: changed.filter((r) => r.is_correct).length, changedPct, keptPct },
      };
    }
  }

  // 4. Quick misses (per section: Math and R&W questions take different times).
  const misses = measured.filter((r) => !r.is_correct);
  const medianRight = new Map<string, number>();
  for (const sec of new Set(measured.map((r) => r.section ?? "Other"))) {
    medianRight.set(sec, median(measured.filter((r) => r.is_correct && (r.section ?? "Other") === sec).map((r) => r.seconds!)));
  }
  const quick = misses.filter((r) => {
    const m = medianRight.get(r.section ?? "Other") ?? 0;
    return m > 0 && r.seconds! < Math.min(R.quickMaxSeconds, R.quickShare * m);
  });
  if (quick.length >= R.quickMin && quick.length >= misses.length * R.quickOfMisses) {
    return {
      kind: "quickMisses",
      tags: [],
      vars: { quick: quick.length, misses: misses.length, quickSec: Math.round(avg(quick.map((r) => r.seconds!))) },
    };
  }

  // 5. Slow misses.
  const rights = measured.filter((r) => r.is_correct);
  if (misses.length >= R.slowMissesMin && rights.length >= 5) {
    const missSec = avg(misses.map((r) => r.seconds!));
    const rightSec = avg(rights.map((r) => r.seconds!));
    if (rightSec > 0 && missSec >= R.slowMinSeconds && missSec >= R.slowRatio * rightSec) {
      return {
        kind: "slowMisses",
        tags: [],
        vars: {
          missSec: Math.round(missSec),
          rightSec: Math.round(rightSec),
          ratio: Math.round((missSec / rightSec) * 10) / 10,
          misses: misses.length,
        },
      };
    }
  }

  // 6. Module 2 fade (a hard adaptive Module 2 is harder by design: left out).
  const m1 = rows.filter((r) => r.track === "module_1");
  const m2 = rows.filter((r) => r.track === "module_2" || r.track === "module_2_easy");
  if (m1.length >= R.m2MinQuestions && m2.length >= R.m2MinQuestions) {
    const m1Pct = pctOf(m1.filter((r) => r.is_correct).length, m1.length);
    const m2Pct = pctOf(m2.filter((r) => r.is_correct).length, m2.length);
    if (m1Pct - m2Pct >= R.m2Gap) {
      return { kind: "m2Drop", tags: [], vars: { m1: m1Pct, m2: m2Pct, gap: m1Pct - m2Pct } };
    }
  }

  // 7. Finishing early without the accuracy to show for it.
  if (timed.length >= R.timedMin && avg(shares) <= R.earlyShare && acc < R.earlyMaxAcc) {
    const leftMin = Math.round(avg(timed.map((c) => (c.limitSeconds! - Math.min(c.usedSeconds!, c.limitSeconds!)) / 60)));
    if (leftMin >= 1) return { kind: "earlyFinish", tags: [], vars: { usedPct, leftMin, acc } };
  }

  // 8. Steady.
  // "measured": enough timed answers to say there's no rushing / stalling pattern.
  const tags = [
    ...(timed.length >= R.timedMin ? ["paced"] : []),
    ...(tests >= 2 ? ["multi"] : []),
    ...(measured.length >= R.measuredMin ? ["measured"] : []),
  ];
  const vars: Record<string, number> = { acc, questions: rows.length };
  if (timed.length >= R.timedMin) vars.usedPct = usedPct;
  if (tests >= 2) vars.tests = tests;
  return { kind: "steady", tags, vars };
}

// ── All three ────────────────────────────────────────────────────────
/**
 * The three conclusions for the student's Overview. `occasions` must already
 * be limited to what the viewer may see (a single-subject teacher: their
 * section only). Fewer than 2 tests → one neutral message.
 */
export function studentConclusions(
  occasions: Occasion[],
  studentId: string,
  bank: TemplateBank,
  /** How templates name the student ({name}); first name is best. */
  name: string,
): ConclusionsResult {
  if (countTests(occasions) < 2) return { thin: true, message: bank.fallback.thin };
  const insights = insightsForWindow(occasions, "recent");
  const win = insights.occasions;
  const latest = [...win].sort((a, b) => b.date.localeCompare(a.date))[0];
  const latestId = latest?.key ?? latest?.testKey ?? latest?.date ?? "";
  const seed = (segment: Segment) => `${studentId}|${latestId}|${segment}`;
  const { strength, focus } = pickDomains(win, insights);
  const items: Conclusion[] = [];

  const domainLine = (segment: "strength" | "focus", p: DomainPick | null, none: string) => {
    if (!p) return items.push({ segment, text: none, template: -1 });
    const pick = choose(bank[segment], domainTags(p), seed(segment));
    items.push(
      pick
        ? { segment, text: fill(pick.text, { ...domainVars(p, bank), name }), template: pick.index, domain: p.stat.domain }
        : { segment, text: none, template: -1 },
    );
  };
  domainLine("strength", strength, bank.fallback.noStrength);
  domainLine("focus", focus, bank.fallback.noFocus);

  const h = habitFinding(win);
  const pick = h ? choose(bank.habit[h.kind], h.tags, seed("habit")) : null;
  items.push(
    h && pick
      ? { segment: "habit", text: fill(pick.text, { ...h.vars, name }), template: pick.index, habit: h.kind }
      : { segment: "habit", text: bank.fallback.noHabit, template: -1 },
  );
  return { thin: false, items };
}
