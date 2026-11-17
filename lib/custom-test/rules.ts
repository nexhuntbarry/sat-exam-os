// lib/custom-test/rules.ts
//
// The saved rules of a Custom test (tests.custom_rules, migration 0035) and
// the pure arithmetic around them: defaults, module sizes, quotas, suggested
// times, validation. Plan: .omc/plans/custom-test.md, approved by Premier
// 2026-11-17 with the plan's defaults, plus: R&W + Math has no break unless
// the creator turns one on, and adaptive is an on/off switch per part.

import { domainsOf, isOtherSkill, otherSkill, type SatSection } from "@/lib/sat-skills";

export type PartKey = "rw" | "math";
export type Subject = "rw" | "math" | "both";
export type Difficulty = "Easy" | "Medium" | "Hard";
export const DIFFICULTIES: Difficulty[] = ["Easy", "Medium", "Hard"];
/** m1 / m2 (fixed two-module) / m2_easy + m2_hard (adaptive). */
export type StageKey = "m1" | "m2" | "m2_easy" | "m2_hard";
export type Mix = Record<Difficulty, number>;

export const PART_KEYS: PartKey[] = ["rw", "math"];
export const PART_SECTION: Record<PartKey, SatSection> = { rw: "Reading & Writing", math: "Math" };
export const PART_LABEL: Record<PartKey, string> = { rw: "Reading and Writing", math: "Math" };
export const STAGE_LABEL: Record<StageKey, string> = {
  m1: "Module 1",
  m2: "Module 2",
  m2_easy: "Module 2 (easier)",
  m2_hard: "Module 2 (harder)",
};

/** Suggested time per question (SAT pace): 71 s R&W, 95 s Math. */
export const SECONDS_PER_QUESTION: Record<PartKey, number> = { rw: 71, math: 95 };
/** Two full SAT modules per part at most. */
export const MAX_QUESTIONS: Record<PartKey, number> = { rw: 54, math: 44 };
export const DEFAULT_THRESHOLD = 60;
export const BREAK_MAX_MINUTES = 60;
export const DEFAULT_BREAK_MINUTES = 10;

export const DEFAULT_MIX: Record<"all" | "m1" | "m2_easy" | "m2_hard", Mix> = {
  all: { Easy: 30, Medium: 40, Hard: 30 },
  m1: { Easy: 20, Medium: 60, Hard: 20 },
  m2_easy: { Easy: 50, Medium: 40, Hard: 10 },
  m2_hard: { Easy: 10, Medium: 40, Hard: 50 },
};

export interface PartRules {
  /** Questions one student answers in this part (Module 1 + Module 2). */
  questions: number;
  adaptive: boolean;
  /** Module 1 percent at/above which Module 2 is the harder one. */
  threshold: number;
  /**
   * Questions per official skill over the part (what one student sees),
   * domain → skill → count. 0 leaves a skill out. Sums to `questions`.
   */
  skills: Record<string, Record<string, number>>;
  /** Difficulty mix, percent: `all` for fixed parts, m1 / m2_easy / m2_hard for adaptive. */
  mix: Record<"all" | "m1" | "m2_easy" | "m2_hard", Mix>;
  /** Module time limits, minutes (m2 null for a one-module test). */
  minutes: { m1: number; m2: number | null };
}

export interface Shortfall {
  part: PartKey;
  stage: StageKey;
  domain: string;
  difficulty: Difficulty;
  wanted: number;
  /** Exactly what was asked (this difficulty, the asked skills). */
  found: number;
  /** "2 Medium", "1 from another skill", "1 left empty". */
  used: string[];
  message: string;
}

export interface CustomRules {
  v: 1;
  subject: Subject;
  /** Phase 1: R&W first only. */
  order: PartKey[];
  /** R&W + Math only: null / minutes 0 = no break (the default). */
  break: { minutes: number; allowPause: boolean } | null;
  parts: Partial<Record<PartKey, PartRules>>;
  /** Selection seed of the saved draw. */
  seed: string;
  /** Versions made with "Make another version" share this. */
  family_id: string;
  version: number;
  /** "Make another version": earlier versions' questions may refill shortfalls. */
  allow_reuse?: boolean;
  /** Shortfalls accepted when saved. */
  shortfalls?: Shortfall[];
}

export function partsOf(subject: Subject): PartKey[] {
  return subject === "both" ? ["rw", "math"] : [subject];
}

/** Minimum questions per part: 6 adaptive, 4 in R&W + Math, else 1. */
export function minQuestions(subject: Subject, adaptive: boolean): number {
  if (adaptive) return 6;
  return subject === "both" ? 4 : 1;
}

/**
 * A part's modules and how many questions each serves. Adaptive: Module 1
 * gets ceil(N/2), each Module 2 track the rest. R&W + Math fixed: Module 1
 * + Module 2 (the full-length runner needs both). Single-subject fixed: one.
 */
export function partStages(subject: Subject, part: Pick<PartRules, "questions" | "adaptive">): { key: StageKey; n: number }[] {
  const n = Math.max(0, Math.floor(part.questions));
  const n1 = Math.ceil(n / 2);
  if (part.adaptive) return [{ key: "m1", n: n1 }, { key: "m2_easy", n: n - n1 }, { key: "m2_hard", n: n - n1 }];
  if (subject === "both") return [{ key: "m1", n: n1 }, { key: "m2", n: n - n1 }];
  return [{ key: "m1", n }];
}

/** Suggested module time: ceil(n · seconds per question / 60), at least 1 minute. */
export function suggestedMinutes(part: PartKey, n: number): number {
  return Math.max(1, Math.ceil((n * SECONDS_PER_QUESTION[part]) / 60));
}

export function suggestedPartMinutes(subject: Subject, key: PartKey, part: Pick<PartRules, "questions" | "adaptive">): PartRules["minutes"] {
  const stages = partStages(subject, part);
  const m2 = stages.find((s) => s.key !== "m1");
  return { m1: suggestedMinutes(key, stages[0].n), m2: m2 ? suggestedMinutes(key, m2.n) : null };
}

/**
 * Largest-remainder apportionment: split `total` in proportion to
 * `weights` (keys in order). Ties go to the earlier key.
 */
export function apportion<K extends string>(total: number, weights: [K, number][]): Record<K, number> {
  const out = {} as Record<K, number>;
  const sum = weights.reduce((s, [, w]) => s + Math.max(0, w), 0);
  if (sum <= 0 || total <= 0) {
    for (const [k] of weights) out[k] = 0;
    return out;
  }
  const raw = weights.map(([k, w], i) => ({ k, i, exact: (total * Math.max(0, w)) / sum }));
  let given = 0;
  for (const r of raw) {
    out[r.k] = Math.floor(r.exact);
    given += out[r.k];
  }
  const order = [...raw].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.i - b.i);
  for (let j = 0; given < total && j < order.length; j++, given++) out[order[j].k]++;
  return out;
}

/** Eligible question counts: domain → skill → difficulty → n (after de-duplication). */
export type PoolCounts = Record<string, Record<string, Mix>>;

const cellTotal = (m: Mix | undefined) => (m ? m.Easy + m.Medium + m.Hard : 0);

/**
 * Default per-skill counts for a part of `questions`: the official domain
 * weights first, then an even spread over the domain's official skills
 * that have eligible questions (largest remainder; a tie goes to the skill
 * with more questions). "Other" skills start at 0.
 */
export function defaultSkillCounts(key: PartKey, questions: number, counts: PoolCounts = {}): PartRules["skills"] {
  const domains = domainsOf(PART_SECTION[key]);
  const perDomain = apportion(questions, domains.map((d) => [d.name, d.weight] as [string, number]));
  const out: PartRules["skills"] = {};
  for (const d of domains) {
    const withPool = d.skills.filter((s) => cellTotal(counts[d.name]?.[s]) > 0);
    const spreadOver = (withPool.length > 0 ? withPool : d.skills)
      .map((s) => [s, cellTotal(counts[d.name]?.[s])] as const)
      .sort((a, b) => b[1] - a[1]);
    const even = apportion(perDomain[d.name], spreadOver.map(([s]) => [s, 1] as [string, number]));
    out[d.name] = Object.fromEntries(d.skills.map((s) => [s, even[s] ?? 0]));
    out[d.name][otherSkill(d.name)] = 0;
  }
  return out;
}

/** Sum of a part's skill counts. */
export function skillTotal(skills: PartRules["skills"]): number {
  let n = 0;
  for (const d of Object.values(skills)) for (const v of Object.values(d)) n += v;
  return n;
}

/** Domain → its questions (sum of its skills). */
export function domainTotals(skills: PartRules["skills"]): Record<string, number> {
  return Object.fromEntries(Object.entries(skills).map(([d, s]) => [d, Object.values(s).reduce((a, b) => a + b, 0)]));
}

/**
 * The most questions any one skill may have for one student: the largest
 * skill count asked for, at least 1. Fallbacks may fill another skill of
 * the same domain up to this. With the default even spread this is 1 while
 * the part is small and rises (2, 3) only when the length needs it — shown
 * on the builder screen (plan open question 1).
 */
export function skillCap(part: Pick<PartRules, "skills">): number {
  let cap = 1;
  for (const d of Object.values(part.skills)) for (const [s, v] of Object.entries(d)) if (!isOtherSkill(s)) cap = Math.max(cap, v);
  return cap;
}

/** The difficulty mix for one module. */
export function stageMix(part: Pick<PartRules, "adaptive" | "mix">, stage: StageKey): Mix {
  if (!part.adaptive) return part.mix.all;
  return stage === "m2_easy" ? part.mix.m2_easy : stage === "m2_hard" ? part.mix.m2_hard : part.mix.m1;
}

/** Difficulty quotas of an n-question module. */
export function difficultyQuotas(mix: Mix, n: number): Mix {
  return apportion(n, DIFFICULTIES.map((d) => [d, mix[d]] as [Difficulty, number]));
}

/**
 * Per-module skill counts. Module 1 gets its share of every skill (largest
 * remainder, never more than the skill has); each Module 2 gets the rest,
 * so one student's Module 1 + Module 2 is exactly the part's counts.
 */
export function stageSkillCounts(
  subject: Subject,
  part: Pick<PartRules, "questions" | "adaptive" | "skills">,
): Record<StageKey, Map<string, number>> {
  const flat: [string, number][] = [];
  for (const [d, skills] of Object.entries(part.skills)) for (const [s, v] of Object.entries(skills)) if (v > 0) flat.push([`${d}\u0000${s}`, v]);
  const total = flat.reduce((a, [, v]) => a + v, 0);
  const stages = partStages(subject, { questions: total, adaptive: part.adaptive });
  const out = {} as Record<StageKey, Map<string, number>>;
  const all = new Map(flat);
  if (stages.length === 1) {
    out.m1 = all;
    return out;
  }
  const m1 = apportion(stages[0].n, flat);
  out.m1 = new Map(flat.map(([k]) => [k, Math.min(m1[k], all.get(k)!)]));
  const rest = new Map(flat.map(([k, v]) => [k, v - out.m1.get(k)!]));
  for (const s of stages.slice(1)) out[s.key] = new Map(rest);
  return out;
}

export function splitSkillKey(k: string): { domain: string; skill: string } {
  const [domain, skill] = k.split("\u0000");
  return { domain, skill };
}

/** A fresh part with the official split and default mixes. */
export function defaultPart(subject: Subject, key: PartKey, counts: PoolCounts = {}): PartRules {
  const questions = subject === "both" ? (key === "rw" ? 54 : 44) : key === "rw" ? 27 : 22;
  const part: PartRules = {
    questions,
    adaptive: false,
    threshold: DEFAULT_THRESHOLD,
    skills: defaultSkillCounts(key, questions, counts),
    mix: structuredClone(DEFAULT_MIX),
    minutes: { m1: 0, m2: null },
  };
  part.minutes = suggestedPartMinutes(subject, key, part);
  return part;
}

// ------------------------------------------------------------ validation

const isInt = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function mixError(m: unknown, label: string): string | null {
  if (!m || typeof m !== "object") return `${label}: difficulty mix is missing`;
  const mix = m as Record<string, unknown>;
  if (!DIFFICULTIES.every((d) => isInt(mix[d], 0, 100))) return `${label}: each difficulty share must be 0–100`;
  if (DIFFICULTIES.reduce((s, d) => s + (mix[d] as number), 0) !== 100) return `${label}: difficulty shares must add up to 100%`;
  return null;
}

/**
 * Check rules from a request (never trusted): shape, counts, mixes, times.
 * Returns the problems, empty when the rules are usable.
 */
export function rulesErrors(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return ["Rules are missing"];
  const r = raw as Partial<CustomRules>;
  if (r.subject !== "rw" && r.subject !== "math" && r.subject !== "both") return ["Choose R&W, Math or R&W + Math"];
  if (r.subject === "both") {
    if (r.break != null) {
      if (!isInt(r.break.minutes, 0, BREAK_MAX_MINUTES)) errors.push(`Break must be 0–${BREAK_MAX_MINUTES} minutes`);
      if (typeof r.break.allowPause !== "boolean") errors.push("Break: say whether students may leave");
    }
  }
  for (const key of partsOf(r.subject)) {
    const p = r.parts?.[key];
    const label = PART_LABEL[key];
    if (!p) {
      errors.push(`${label}: settings are missing`);
      continue;
    }
    const min = minQuestions(r.subject, Boolean(p.adaptive));
    if (!isInt(p.questions, min, MAX_QUESTIONS[key])) {
      errors.push(`${label}: questions must be ${min}–${MAX_QUESTIONS[key]}${p.adaptive ? " for an adaptive part" : ""}`);
    }
    if (typeof p.adaptive !== "boolean") errors.push(`${label}: adaptive must be on or off`);
    if (p.adaptive && !isInt(p.threshold, 1, 100)) errors.push(`${label}: threshold must be 1–100%`);
    if (!p.skills || typeof p.skills !== "object") errors.push(`${label}: domain split is missing`);
    else {
      const domains = new Set(domainsOf(PART_SECTION[key]).map((d) => d.name));
      for (const [d, skills] of Object.entries(p.skills)) {
        if (!domains.has(d)) errors.push(`${label}: unknown domain "${d}"`);
        for (const v of Object.values(skills ?? {})) if (!isInt(v, 0, MAX_QUESTIONS[key])) errors.push(`${label}: skill counts must be whole numbers`);
      }
      if (errors.length === 0 && skillTotal(p.skills) !== p.questions) {
        errors.push(`${label}: the domain split adds up to ${skillTotal(p.skills)}, not ${p.questions} questions`);
      }
    }
    for (const [k, l] of p.adaptive
      ? ([["m1", "Module 1"], ["m2_easy", "Module 2 (easier)"], ["m2_hard", "Module 2 (harder)"]] as const)
      : ([["all", "Difficulty"]] as const)) {
      const e = mixError(p.mix?.[k], `${label} ${l}`);
      if (e) errors.push(e);
    }
    const two = partStages(r.subject, { questions: p.questions ?? 0, adaptive: Boolean(p.adaptive) }).length > 1;
    if (!isInt(p.minutes?.m1, 1, 180)) errors.push(`${label}: Module 1 time must be 1–180 minutes`);
    if (two && !isInt(p.minutes?.m2, 1, 180)) errors.push(`${label}: Module 2 time must be 1–180 minutes`);
  }
  return errors;
}
