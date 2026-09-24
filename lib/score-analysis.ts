// ── Score-breakdown analysis + template narrative (no AI) ────────────
//
// Aggregates a student's answers by SAT domain, then assembles a written
// strengths/weaknesses report from a bank of sentence templates — no LLM call.
// The template chosen for each slot is picked deterministically from the
// student's own numbers, so the same result always reads the same way but
// different students (and different score profiles) get different wording.

export interface AnswerRow {
  is_correct: boolean;
  section: string | null;
  domain: string | null;
}

export interface DomainStat {
  section: string;
  domain: string;
  correct: number;
  total: number;
  pct: number; // 0..100, rounded
}

export interface Breakdown {
  domains: DomainStat[]; // all domains the student saw, strongest → weakest
  bySection: { section: string; domains: DomainStat[]; correct: number; total: number; pct: number }[];
  correct: number;
  total: number;
  pct: number;
}

export type Tier = "excellent" | "solid" | "developing" | "needs-work";

export function tierOf(pct: number): Tier {
  if (pct >= 85) return "excellent";
  if (pct >= 70) return "solid";
  if (pct >= 50) return "developing";
  return "needs-work";
}

export const TIER_LABEL: Record<Tier, string> = {
  excellent: "Excellent",
  solid: "Solid",
  developing: "Developing",
  "needs-work": "Needs work",
};

// Canonical domain order within a section (matches the SAT taxonomy).
const DOMAIN_ORDER: Record<string, number> = {
  "Information and Ideas": 1,
  "Craft and Structure": 2,
  "Expression of Ideas": 3,
  "Standard English Conventions": 4,
  Algebra: 1,
  "Advanced Math": 2,
  "Problem Solving and Data Analysis": 3,
  "Geometry and Trigonometry": 4,
};

export function computeBreakdown(rows: AnswerRow[]): Breakdown {
  const key = (r: AnswerRow) => `${r.section ?? "Other"}|||${r.domain ?? "Other"}`;
  const map = new Map<string, DomainStat>();
  let correct = 0;
  for (const r of rows) {
    if (!r.domain) continue;
    const k = key(r);
    let s = map.get(k);
    if (!s) {
      s = { section: r.section ?? "Other", domain: r.domain, correct: 0, total: 0, pct: 0 };
      map.set(k, s);
    }
    s.total += 1;
    if (r.is_correct) {
      s.correct += 1;
      correct += 1;
    }
  }
  const domains = [...map.values()];
  for (const d of domains) d.pct = d.total ? Math.round((d.correct / d.total) * 100) : 0;
  domains.sort((a, b) => b.pct - a.pct || b.total - a.total);

  const secMap = new Map<string, { section: string; domains: DomainStat[]; correct: number; total: number; pct: number }>();
  for (const d of domains) {
    let s = secMap.get(d.section);
    if (!s) {
      s = { section: d.section, domains: [], correct: 0, total: 0, pct: 0 };
      secMap.set(d.section, s);
    }
    s.domains.push(d);
    s.correct += d.correct;
    s.total += d.total;
  }
  const bySection = [...secMap.values()];
  for (const s of bySection) {
    s.pct = s.total ? Math.round((s.correct / s.total) * 100) : 0;
    s.domains.sort((a, b) => (DOMAIN_ORDER[a.domain] ?? 9) - (DOMAIN_ORDER[b.domain] ?? 9));
  }
  const total = domains.reduce((n, d) => n + d.total, 0);
  return { domains, bySection, correct, total, pct: total ? Math.round((correct / total) * 100) : 0 };
}

// ── Template bank ────────────────────────────────────────────────────
// Deterministic pick: index the variant list by a seed derived from the data.
function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(Math.trunc(seed)) % arr.length];
}

const OPENERS: string[] = [
  "Here's a look at how your performance breaks down across the tested areas.",
  "Your results point to a clear pattern of strengths and areas to build on.",
  "Let's turn this score into a plan — here's where you're strong and where to focus.",
  "Breaking your answers down by topic shows exactly where your points came from.",
  "This report groups every question by its skill area so you can see the full picture.",
];

const OVERALL_TIER: Record<Tier, string[]> = {
  excellent: [
    "Overall this is a strong, well-rounded performance — you're answering correctly across most areas.",
    "You're operating at a high level here, with solid accuracy nearly everywhere.",
    "This is excellent work overall; the foundation across topics is clearly there.",
  ],
  solid: [
    "Overall this is a solid performance with a few clear places to gain more points.",
    "You have a dependable base across most topics, with room to push a couple of areas higher.",
    "This is a good, steady result — sharpening a few areas will move the score up.",
  ],
  developing: [
    "Overall you're building a foundation — some areas are landing well while others need attention.",
    "This result is a work in progress: a few topics are close, and targeting the weaker ones will pay off quickly.",
    "You're partway there — the breakdown below shows the fastest places to gain ground.",
  ],
  "needs-work": [
    "Overall there's meaningful room to grow, and the breakdown makes the priorities clear.",
    "This is an early baseline — the good news is the weak areas below are very improvable with focused practice.",
    "There's a lot of upside here; the topics below are the ones to work through first.",
  ],
};

// Strength callouts (slot: {domain}, {pct}).
const STRENGTH_LINES: string[] = [
  "{domain} is a real strength — you got {pct}% of those questions right.",
  "You're strong in {domain} ({pct}%); keep that edge sharp.",
  "{domain} is working well for you at {pct}% — a reliable source of points.",
  "Your best area is {domain}, where you scored {pct}%.",
  "{domain} stands out as a strength at {pct}% correct.",
];

const SECOND_STRENGTH_LINES: string[] = [
  "{domain} is also solid at {pct}%.",
  "You're holding up well in {domain} too ({pct}%).",
  "Close behind is {domain} at {pct}%.",
  "{domain} is another dependable area for you ({pct}%).",
];

// Focus/weakness callouts (slot: {domain}, {pct}).
const FOCUS_LINES: string[] = [
  "Your biggest opportunity is {domain} — currently {pct}%. A focused push here gains the most points.",
  "{domain} is the area to prioritize ({pct}%); small gains here move your score the most.",
  "Start with {domain}, your lowest area at {pct}% — it has the most room to grow.",
  "The clearest place to improve is {domain} at {pct}%.",
  "{domain} needs the most attention right now ({pct}%).",
];

const SECOND_FOCUS_LINES: string[] = [
  "{domain} is worth some practice too ({pct}%).",
  "Keep an eye on {domain} as well — {pct}% so far.",
  "Another area to build is {domain} ({pct}%).",
  "{domain} is also on the lower side at {pct}%.",
];

// Per-domain study tips (2 variants each; picked by seed).
const DOMAIN_TIPS: Record<string, string[]> = {
  Algebra: [
    "Drill linear equations, systems, and inequalities until the setup is automatic.",
    "Practice translating word problems into equations — that's where most Algebra points are won or lost.",
  ],
  "Advanced Math": [
    "Review quadratics, exponentials, and function notation, and practice reading graphs of nonlinear functions.",
    "Work on factoring, function transformations, and interpreting nonlinear models in context.",
  ],
  "Problem Solving and Data Analysis": [
    "Practice ratios, percentages, and reading data from tables and graphs under time pressure.",
    "Focus on unit conversions, probability, and interpreting statistics from charts.",
  ],
  "Geometry and Trigonometry": [
    "Memorize the core formulas (area, volume, right-triangle trig) and practice diagram problems.",
    "Review angle relationships, circles, and SOH-CAH-TOA until they're second nature.",
  ],
  "Information and Ideas": [
    "Practice locating textual evidence and drawing inferences directly supported by the passage.",
    "Work on main-idea and command-of-evidence questions — always anchor the answer to the text.",
  ],
  "Craft and Structure": [
    "Build vocabulary-in-context skills and practice questions on word choice, tone, and text structure.",
    "Focus on how word choice and structure shape meaning, and on cross-text comparison questions.",
  ],
  "Expression of Ideas": [
    "Practice revising sentences for clarity, transitions, and how ideas connect across a passage.",
    "Work on rhetorical-synthesis questions — choose the option that best meets the stated goal.",
  ],
  "Standard English Conventions": [
    "Review comma, semicolon, and colon rules, subject-verb agreement, and pronoun clarity.",
    "Drill punctuation and sentence-boundary rules — these follow consistent, learnable patterns.",
  ],
};

const CLOSERS: string[] = [
  "Focus your next few sessions on the areas above and you'll see the score respond.",
  "Put your practice time where the points are — the focus areas above are the fastest wins.",
  "Keep the strengths warm and spend the extra reps on the focus areas.",
  "A little targeted work on the weaker areas goes a long way here.",
];

/**
 * Build a written strengths/weaknesses report from the breakdown using only
 * templates — no AI. Returns an array of paragraphs.
 */
export function narrative(b: Breakdown): string[] {
  if (!b.domains.length || b.total === 0) return [];
  const seed = b.correct * 7 + b.total * 3 + b.domains.length;
  const fill = (t: string, d: DomainStat) => t.replace("{domain}", d.domain).replace("{pct}", String(d.pct));

  const strengths = b.domains.filter((d) => d.pct >= 70);
  const focus = [...b.domains].reverse().filter((d) => d.pct < 70);
  const best = b.domains[0];
  const worst = b.domains[b.domains.length - 1];

  const paras: string[] = [];
  paras.push(pick(OPENERS, seed));
  paras.push(pick(OVERALL_TIER[tierOf(b.pct)], seed + 1));

  // Strengths paragraph
  const sLines: string[] = [];
  if (strengths.length) {
    sLines.push(fill(pick(STRENGTH_LINES, seed + 2), strengths[0]));
    if (strengths.length > 1) sLines.push(fill(pick(SECOND_STRENGTH_LINES, seed + 3), strengths[1]));
  } else {
    // No domain ≥70% — frame the relative best as the emerging strength.
    sLines.push(fill(pick(STRENGTH_LINES, seed + 2), best));
  }
  paras.push(sLines.join(" "));

  // Focus paragraph + tip
  const fLines: string[] = [];
  const primaryFocus = focus[0] ?? worst;
  fLines.push(fill(pick(FOCUS_LINES, seed + 4), primaryFocus));
  const tips = DOMAIN_TIPS[primaryFocus.domain];
  if (tips) fLines.push(pick(tips, seed + 5));
  if (focus.length > 1 && focus[1].domain !== primaryFocus.domain) {
    fLines.push(fill(pick(SECOND_FOCUS_LINES, seed + 6), focus[1]));
  }
  paras.push(fLines.join(" "));

  paras.push(pick(CLOSERS, seed + 7));
  return paras;
}
