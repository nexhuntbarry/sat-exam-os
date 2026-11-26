// One-page parent report (support a05ff7b7, batch 2): what goes on the
// page, worked out from the student's scored attempts (lib/student-analytics
// getStudentProgressOccasions, scored with the shared score display). Pure:
// no DB, no new scoring — section scores are the attempts' own SAT scores,
// a total is combineSectionScores (R&W + Math), domain % is computeBreakdown.
//
// One "assessment" =
//   - a full-length SAT attempt (both sections scored) → its own total;
//   - otherwise one set of section tests (lib/test-pairing pairSections:
//     admin override, else the same set name, else the same New York day):
//     an R&W and a Math test → one assessment, total = R&W + Math; one
//     section only → that section, no total. (A section taken twice in a
//     set: the later one counts.)
// Custom tests (estimated scores) and attempts without a SAT score yet
// (Module 2 open, Incomplete) are not practice-test scores and are left out.

import { combineSectionScores } from "@/lib/scoring";
import { computeBreakdown, MIN_QUESTIONS_TO_COMPARE, type AnswerRow, type Occasion } from "@/lib/score-analysis";
import { normalizeSetName, nyDay, pairSections, shortSetLabels, type PairOverrides } from "@/lib/test-pairing";

export { nyDay };

export const RW = "Reading & Writing";
export const MATH = "Math";
export type ReportSection = typeof RW | typeof MATH;

/** The four domains of each section, in the SAT's order (stored names). */
export const REPORT_DOMAINS: Record<ReportSection, string[]> = {
  [MATH]: ["Algebra", "Advanced Math", "Problem Solving and Data Analysis", "Geometry and Trigonometry"],
  [RW]: ["Information and Ideas", "Craft and Structure", "Expression of Ideas", "Standard English Conventions"],
};

/** A domain at or above this % is drawn green ("strong"), below it gold — the strength line the student page's narrative uses. */
export const STRONG_PCT = 70;

/** At most this many assessments on the chart (the latest ones). */
export const CHART_MAX_POINTS = 20;

export interface SectionResult {
  /** SAT section score, 200–800. */
  sat: number;
  /** That section's answers in this assessment (for the domain %). */
  rows: AnswerRow[];
  date: string;
  testId: string | null;
  testName: string | null;
  /** The attempt's submission rows (to find a test row's set). */
  submissionIds: string[];
}

export interface Assessment {
  key: string;
  /** Latest submitted_at among its tests. */
  date: string;
  kind: "full" | "pair" | "section";
  /** The set's name ("Nov 26 SAT Intensive day 1"; a full-length SAT: its test name); null when it has none. */
  name: string | null;
  rw: SectionResult | null;
  math: SectionResult | null;
  /** 400–1600 for a full-length SAT or an R&W + Math set; null otherwise. */
  total: number | null;
}

const isSection = (s: string | null | undefined): s is ReportSection => s === RW || s === MATH;

/** A scored, non-estimated occasion of a known section. */
function scored(o: Occasion): o is Occasion & { section: ReportSection } {
  return isSection(o.section) && o.score?.sat != null && !o.score.estimated && o.rows.length > 0 && Boolean(o.date);
}

const result = (o: Occasion): SectionResult => ({
  sat: o.score!.sat!,
  rows: o.rows.filter((r) => r.section === o.section),
  date: o.date,
  testId: o.testId ?? null,
  testName: o.label ?? null,
  submissionIds: o.submissionIds ?? [],
});

/** The admin pairing overrides carried on the occasions (Occasion.pairWith). */
export function occasionOverrides(occasions: Occasion[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const o of occasions) if (o.testId && o.pairWith !== undefined) out.set(o.testId, o.pairWith);
  return out;
}

/**
 * The student's assessments, oldest first. `sections` limits what is shown
 * (a teacher of one subject): with one section only, nothing has a total.
 * `overrides`: the admin pairing overrides (default: those on the occasions).
 */
export function buildAssessments(
  occasions: Occasion[],
  sections: readonly ReportSection[] = [RW, MATH],
  overrides: PairOverrides = occasionOverrides(occasions),
): Assessment[] {
  const ok = occasions.filter(scored).filter((o) => sections.includes(o.section));
  const both = sections.includes(RW) && sections.includes(MATH);
  const out: Assessment[] = [];
  const loose: (Occasion & { section: ReportSection })[] = [];

  // Full-length SATs: both sections of one attempt share a testKey "fl:…".
  const fl = new Map<string, (Occasion & { section: ReportSection })[]>();
  for (const o of ok) {
    if (o.testKey?.startsWith("fl:")) fl.set(o.testKey, [...(fl.get(o.testKey) ?? []), o]);
    else loose.push(o);
  }
  for (const [key, list] of fl) {
    const latest = (s: ReportSection) => list.filter((o) => o.section === s).sort((a, b) => b.date.localeCompare(a.date))[0];
    const rw = latest(RW);
    const math = latest(MATH);
    if (both && rw && math) {
      out.push({
        key,
        date: rw.date > math.date ? rw.date : math.date,
        kind: "full",
        name: normalizeSetName(rw.label ?? math.label) || null,
        rw: result(rw),
        math: result(math),
        total: combineSectionScores(rw.score!.sat!, math.score!.sat!),
      });
    } else {
      // One section of a full-length SAT scored (or one subject shown): a section result like any other.
      loose.push(...list);
    }
  }

  // Section tests: one assessment per set (lib/test-pairing). A teacher of
  // one subject sees one section only, so nothing pairs.
  const items = loose.map((o) => ({ section: o.section, date: o.date, testId: o.testId ?? null, testName: o.label ?? null, o }));
  for (const set of pairSections(items, both ? overrides : new Map())) {
    const rw = set.rw?.o ?? null;
    const math = set.math?.o ?? null;
    out.push({
      key: set.key,
      date: set.date,
      kind: rw && math ? "pair" : "section",
      name: set.name,
      rw: rw ? result(rw) : null,
      math: math ? result(math) : null,
      total: rw && math ? combineSectionScores(rw.score!.sat!, math.score!.sat!) : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** What the header calls the assessments. */
export function assessmentType(list: Assessment[]): "full" | "sections" | "mixed" | "none" {
  if (list.length === 0) return "none";
  if (list.every((a) => a.kind === "full")) return "full";
  if (list.every((a) => a.kind !== "full")) return "sections";
  return "mixed";
}

export interface CardValue {
  value: number;
  date: string;
  /** false = an earlier assessment's value (the latest one has none). */
  fromLatest: boolean;
}

export interface ReportCards {
  /** Latest assessment with a total (null: none has one). */
  total: CardValue | null;
  /** Latest total − first total (null under two assessments with a total). */
  change: { delta: number; since: string; from: number } | null;
  math: CardValue | null;
  rw: CardValue | null;
}

function lastWith(list: Assessment[], pick: (a: Assessment) => number | null | undefined): CardValue | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const v = pick(list[i]);
    if (v != null) return { value: v, date: list[i].date, fromLatest: i === list.length - 1 };
  }
  return null;
}

/**
 * The four cards. A card whose latest assessment lacks that score shows the
 * latest one that has it, with its date (fromLatest = false); none → null ("—").
 */
export function reportCards(list: Assessment[]): ReportCards {
  const totals = list.filter((a) => a.total != null);
  const first = totals[0];
  const last = totals[totals.length - 1];
  return {
    total: lastWith(list, (a) => a.total),
    change: totals.length >= 2 ? { delta: last.total! - first.total!, since: first.date, from: first.total! } : null,
    math: lastWith(list, (a) => a.math?.sat),
    rw: lastWith(list, (a) => a.rw?.sat),
  };
}

export interface DomainRow {
  section: ReportSection;
  domain: string;
  /** % at the first assessment with this section; null = no change shown (one assessment, or too few questions). */
  initial: number | null;
  /** % at the latest assessment with this section; null = no questions in this domain there. */
  latest: number | null;
  latestTotal: number;
}

const sectionResult = (a: Assessment, s: ReportSection) => (s === RW ? a.rw : a.math);

/**
 * Each domain's first → latest %: the first and the latest assessment that
 * include the section. The initial % is shown only when both have at least
 * MIN_QUESTIONS_TO_COMPARE questions in the domain (else latest only).
 */
export function domainRows(list: Assessment[], section: ReportSection): DomainRow[] {
  const withS = list.filter((a) => sectionResult(a, section));
  const firstA = withS[0];
  const lastA = withS[withS.length - 1];
  const stat = (a: Assessment | undefined) =>
    new Map(a ? computeBreakdown(sectionResult(a, section)!.rows).domains.map((d) => [d.domain, d]) : []);
  const first = stat(firstA);
  const last = stat(lastA);
  return REPORT_DOMAINS[section].map((domain) => {
    const f = first.get(domain);
    const l = last.get(domain);
    const comparable =
      firstA !== lastA && f != null && l != null && f.total >= MIN_QUESTIONS_TO_COMPARE && l.total >= MIN_QUESTIONS_TO_COMPARE;
    return {
      section,
      domain,
      initial: comparable ? f!.pct : null,
      latest: l ? l.pct : null,
      latestTotal: l?.total ?? 0,
    };
  });
}

/** The `n` weakest domains at the latest assessment (lowest latest %; more questions first on a tie). */
export function targetedReview(rows: DomainRow[], n = 3): DomainRow[] {
  return rows
    .filter((r) => r.latest != null)
    .sort((a, b) => a.latest! - b.latest! || b.latestTotal - a.latestTotal)
    .slice(0, n);
}

// ── Chart ─────────────────────────────────────────────────────────────

export interface Scale {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
}

const STEPS = [10, 20, 25, 50, 100, 200];

/**
 * An axis fitted to the values: at least `minSpan` wide (centred on the
 * values), on multiples of a round step with at most 4 intervals, inside
 * [floor, ceil].
 */
export function niceScale(values: number[], minSpan: number, floor: number, ceil: number): Scale {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < minSpan) {
    const mid = (min + max) / 2;
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
  }
  const step = STEPS.find((s) => Math.ceil(max / s) - Math.floor(min / s) <= 4) ?? 400;
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  if (lo < floor) {
    hi += floor - lo;
    lo = floor;
  }
  if (hi > ceil) {
    lo = Math.max(floor, lo - (hi - ceil));
    hi = ceil;
  }
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  return { lo, hi, step, ticks };
}

export type SeriesKey = "total" | "math" | "rw";

export interface ChartColumn {
  i: number;
  x: number;
  /** The assessment's date (the later section). */
  date: string;
  /** Short set name for the x axis ("Day 1"); null = show the date only. */
  label: string | null;
  /** Each section's finish time, distinct New York days, oldest first. */
  sectionDates: string[];
}

/** Short x-axis labels of the assessments (lib/test-pairing shortSetLabels). */
export function setLabels(list: Assessment[]): (string | null)[] {
  return shortSetLabels(list.map((a) => a.name));
}

/** Each section's finish time of an assessment, one per New York day, oldest first. */
export function sectionDates(a: Assessment): string[] {
  const seen = new Set<string>();
  return [a.rw?.date, a.math?.date]
    .filter((d): d is string => Boolean(d))
    .sort()
    .filter((d) => (seen.has(nyDay(d)) ? false : (seen.add(nyDay(d)), true)));
}

export interface ChartPoint {
  /** Index of the assessment on the chart (0-based). */
  i: number;
  x: number;
  y: number;
  value: number;
  /** Where the score label goes: above or below the point. */
  label: "above" | "below";
}

export interface ChartLayout {
  width: number;
  height: number;
  plot: { left: number; right: number };
  /** Total band (left axis) and section band (right axis), in px. */
  totalBand: { top: number; bottom: number } | null;
  sectionBand: { top: number; bottom: number } | null;
  totalScale: Scale | null;
  sectionScale: Scale | null;
  /** Gridlines: each axis tick and its y. */
  totalTicks: { value: number; y: number }[];
  sectionTicks: { value: number; y: number }[];
  /** x of each assessment, its date, its short set label (null: none) and its sections' dates. */
  columns: ChartColumn[];
  series: Record<SeriesKey, ChartPoint[]>;
  /** Assessments left off the front of the chart (more than CHART_MAX_POINTS). */
  hidden: number;
}

export interface ChartBox {
  width: number;
  height: number;
  /** Space for the axis labels on each side. */
  axis: number;
  /** Space at the bottom for the x labels. */
  xLabels: number;
  /** Space above/below the bands for the point labels. */
  pad: number;
  /** Gap between the total band and the section band. */
  gap: number;
}

export const CHART_BOX: ChartBox = { width: 688, height: 290, axis: 44, xLabels: 30, pad: 18, gap: 34 };

/**
 * Pure layout of the progression chart: Total (left axis) in the upper band,
 * Math and R&W (right axis) in the lower band, each scale fitted to the
 * student's own scores. A point only where the assessment has that score.
 * Section labels never stack: at each assessment the higher section score is
 * labelled above its point, the lower one below (a tie: Math above).
 */
export function chartLayout(all: Assessment[], box: ChartBox = CHART_BOX): ChartLayout {
  const list = all.slice(-CHART_MAX_POINTS);
  const hidden = all.length - list.length;
  const labels = setLabels(list);
  const left = box.axis;
  const right = box.width - box.axis;
  const inner = 22; // keep the end points (and their labels) off the axes
  const xOf = (i: number) =>
    list.length <= 1 ? (left + right) / 2 : left + inner + ((right - left - 2 * inner) * i) / (list.length - 1);

  const totals = list.map((a) => a.total).filter((v): v is number => v != null);
  const sections = list.flatMap((a) => [a.math?.sat, a.rw?.sat]).filter((v): v is number => v != null);
  const top = box.pad;
  const bottom = box.height - box.xLabels - box.pad;
  let totalBand: ChartLayout["totalBand"] = null;
  let sectionBand: ChartLayout["sectionBand"] = null;
  if (totals.length > 0 && sections.length > 0) {
    const h = (bottom - top - box.gap) / 2;
    totalBand = { top, bottom: top + h };
    sectionBand = { top: bottom - h, bottom };
  } else if (totals.length > 0) totalBand = { top, bottom };
  else if (sections.length > 0) sectionBand = { top, bottom };

  const totalScale = totals.length ? niceScale(totals, 100, 400, 1600) : null;
  const sectionScale = sections.length ? niceScale(sections, 60, 200, 800) : null;
  const yOf = (v: number, s: Scale, band: { top: number; bottom: number }) =>
    band.bottom - ((v - s.lo) / (s.hi - s.lo)) * (band.bottom - band.top);

  const series: Record<SeriesKey, ChartPoint[]> = { total: [], math: [], rw: [] };
  list.forEach((a, i) => {
    const x = xOf(i);
    if (a.total != null && totalScale && totalBand) {
      series.total.push({ i, x, y: yOf(a.total, totalScale, totalBand), value: a.total, label: "above" });
    }
    if (sectionScale && sectionBand) {
      const m = a.math?.sat;
      const r = a.rw?.sat;
      if (m != null) series.math.push({ i, x, y: yOf(m, sectionScale, sectionBand), value: m, label: r != null && r > m ? "below" : "above" });
      if (r != null) series.rw.push({ i, x, y: yOf(r, sectionScale, sectionBand), value: r, label: m != null && m >= r ? "below" : "above" });
    }
  });

  return {
    width: box.width,
    height: box.height,
    plot: { left, right },
    totalBand,
    sectionBand,
    totalScale,
    sectionScale,
    totalTicks: totalScale && totalBand ? totalScale.ticks.map((value) => ({ value, y: yOf(value, totalScale, totalBand!) })) : [],
    sectionTicks: sectionScale && sectionBand ? sectionScale.ticks.map((value) => ({ value, y: yOf(value, sectionScale, sectionBand!) })) : [],
    columns: list.map((a, i) => ({ i, x: xOf(i), date: a.date, label: labels[i], sectionDates: sectionDates(a) })),
    series,
    hidden,
  };
}

/** SVG path through the points in order ("" under two points). */
export function linePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  return points.map((p, k) => `${k === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}
