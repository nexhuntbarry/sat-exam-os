// lib/custom-test/select.ts
//
// Pure, seeded question selection for a Custom test (plan section E).
// Input: the eligible pool (lib/custom-test/pool, already annotated with the
// official domain/skill and a duplicate key) and the rules. Output: each
// module's question ids plus every shortfall, in words. No database here;
// the same seed and pool always give the same test.
//
// Rules it keeps:
//  - per module, the skill counts and difficulty quotas of the rules;
//  - no question and no duplicate (same R&W passage / same Math stem, the
//    ~240 copies imported from more than one PDF) twice in the whole test;
//  - a skill never exceeds the cap over what one student sees (Module 1 +
//    the Module 2 they get; the easier and harder Module 2 may share);
//  - when a cell is empty: another difficulty of the same skill
//    (Hard → Medium → Easy, Easy → Medium → Hard, Medium → whichever
//    neighbour has more left), then another skill of the same domain with
//    cap room — never another domain. Each substitution is reported.

import { DIFFICULTIES, PART_LABEL, STAGE_LABEL, difficultyQuotas, partStages, skillCap, splitSkillKey, stageMix, stageSkillCounts, type CustomRules, type Difficulty, type PartKey, type PartRules, type PoolCounts, type Shortfall, type StageKey } from "@/lib/custom-test/rules";
import { domainsOf, isOtherSkill } from "@/lib/sat-skills";
import { PART_SECTION } from "@/lib/custom-test/rules";

export interface PoolQuestion {
  id: string;
  part: PartKey;
  /** Official domain / skill (lib/sat-skills canonicalSkill). */
  domain: string;
  skill: string;
  difficulty: Difficulty;
  /** Same key = copies of one question (shared R&W passage / same Math stem). */
  dupKey: string;
}

export interface StagePick {
  key: StageKey;
  questionIds: string[];
}

export interface Selection {
  parts: Partial<Record<PartKey, StagePick[]>>;
  shortfalls: Shortfall[];
}

// ------------------------------------------------------------------ rng

/** Deterministic RNG from a string seed (mulberry32 over an FNV-1a hash). */
export function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------- counts

/** Eligible counts per official (domain, skill, difficulty), one per duplicate group. */
export function poolCounts(pool: PoolQuestion[], part: PartKey, exclude: ReadonlySet<string> = new Set()): PoolCounts {
  const seen = new Set<string>();
  const out: PoolCounts = {};
  const excludedKeys = new Set(pool.filter((q) => exclude.has(q.id)).map((q) => q.dupKey));
  for (const q of pool) {
    if (q.part !== part || exclude.has(q.id) || excludedKeys.has(q.dupKey) || seen.has(q.dupKey)) continue;
    seen.add(q.dupKey);
    const cell = ((out[q.domain] ??= {})[q.skill] ??= { Easy: 0, Medium: 0, Hard: 0 });
    cell[q.difficulty]++;
  }
  return out;
}

// --------------------------------------------------------------- fallback

/** Difficulties to try for a wanted one, in order. */
export function difficultyFallback(want: Difficulty, remaining: (d: Difficulty) => number): Difficulty[] {
  if (want === "Hard") return ["Hard", "Medium", "Easy"];
  if (want === "Easy") return ["Easy", "Medium", "Hard"];
  return remaining("Hard") > remaining("Easy") ? ["Medium", "Hard", "Easy"] : ["Medium", "Easy", "Hard"];
}

interface Slot {
  domain: string;
  skill: string;
  difficulty: Difficulty;
}

/** What a student sees together with this module (for the skill cap). */
function companions(stage: StageKey, all: StageKey[]): StageKey[] {
  if (stage === "m1") return all.filter((s) => s !== "m1");
  return all.includes("m1") ? ["m1"] : [];
}

class Picker {
  private used = new Set<string>();
  private usedKeys = new Set<string>();
  /** stage → skill key → count. */
  private skillCount = new Map<StageKey, Map<string, number>>();
  private byCell = new Map<string, PoolQuestion[]>();
  private reuseByCell = new Map<string, PoolQuestion[]>();
  private readonly cap: number;
  private readonly stages: StageKey[];
  readonly rng: () => number;
  constructor(
    pool: PoolQuestion[],
    reuse: PoolQuestion[],
    rng: () => number,
    part: PartRules,
    stages: StageKey[],
    taken: { ids: Set<string>; keys: Set<string> },
  ) {
    this.rng = rng;
    this.cap = skillCap(part);
    this.stages = stages;
    this.used = taken.ids;
    this.usedKeys = taken.keys;
    for (const [list, map] of [[pool, this.byCell], [reuse, this.reuseByCell]] as const) {
      for (const q of list) {
        const k = cellKey(q.domain, q.skill, q.difficulty);
        const arr = map.get(k) ?? [];
        arr.push(q);
        map.set(k, arr);
      }
      // Seeded shuffle once; draws then take the first free one.
      for (const arr of map.values()) shuffle(arr, rng);
    }
  }

  remaining(domain: string, skill: string, d: Difficulty): number {
    return (this.byCell.get(cellKey(domain, skill, d)) ?? []).filter((q) => this.free(q)).length;
  }

  private free(q: PoolQuestion) {
    return !this.used.has(q.id) && !this.usedKeys.has(q.dupKey);
  }

  private take(domain: string, skill: string, d: Difficulty): PoolQuestion | null {
    for (const map of [this.byCell, this.reuseByCell]) {
      const q = (map.get(cellKey(domain, skill, d)) ?? []).find((x) => this.free(x));
      if (q) return q;
    }
    return null;
  }

  private count(stage: StageKey, skill: string): number {
    return this.skillCount.get(stage)?.get(skill) ?? 0;
  }

  /** Room left for `skill` in `stage` under the cap (what one student sees). */
  capRoom(stage: StageKey, domain: string, skill: string): number {
    const k = `${domain}\u0000${skill}`;
    const seen = [stage, ...companions(stage, this.stages)];
    // The worst case over the Module 2 tracks a student might get.
    const m2s = seen.filter((s) => s !== "m1");
    const m1 = seen.includes("m1") ? this.count("m1", k) : 0;
    const worst = stage === "m1" ? Math.max(0, ...m2s.map((s) => this.count(s, k))) + this.count("m1", k) : m1 + this.count(stage, k);
    return this.cap - worst;
  }

  record(stage: StageKey, q: PoolQuestion) {
    this.used.add(q.id);
    this.usedKeys.add(q.dupKey);
    const k = `${q.domain}\u0000${q.skill}`;
    const m = this.skillCount.get(stage) ?? new Map<string, number>();
    m.set(k, (m.get(k) ?? 0) + 1);
    this.skillCount.set(stage, m);
  }

  release(stage: StageKey, q: PoolQuestion) {
    this.used.delete(q.id);
    this.usedKeys.delete(q.dupKey);
    const k = `${q.domain}\u0000${q.skill}`;
    const m = this.skillCount.get(stage);
    if (m) m.set(k, Math.max(0, (m.get(k) ?? 0) - 1));
  }

  /**
   * One question for a slot, with the fallback chain. `how`: "exact",
   * a difficulty ("Medium" = same skill, other difficulty) or "skill"
   * (another skill of the same domain).
   */
  draw(stage: StageKey, slot: Slot, skillsInDomain: string[]): { q: PoolQuestion; how: "exact" | Difficulty | "skill" } | null {
    const order = difficultyFallback(slot.difficulty, (d) => this.remaining(slot.domain, slot.skill, d));
    for (const d of order) {
      const q = this.take(slot.domain, slot.skill, d);
      if (q) return { q, how: d === slot.difficulty ? "exact" : d };
    }
    // Another skill of the same domain with cap room: same difficulty first.
    const others = skillsInDomain.filter((s) => s !== slot.skill);
    for (const d of order) {
      const candidates = shuffle(
        others.filter((s) => this.capRoom(stage, slot.domain, s) > 0),
        this.rng,
      ).sort((a, b) => this.remaining(slot.domain, b, d) - this.remaining(slot.domain, a, d));
      for (const s of candidates) {
        const q = this.take(slot.domain, s, d);
        if (q) return { q, how: "skill" };
      }
    }
    return null;
  }
}

const cellKey = (domain: string, skill: string, d: Difficulty) => `${domain}\u0000${skill}\u0000${d}`;

function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Give each slot (one per skill unit) a difficulty so the module meets its
 * quotas, putting each difficulty where that skill has questions left:
 * scarcest difficulty first, each unit to the skill with the most of it.
 */
function assignDifficulties(
  skillUnits: { domain: string; skill: string }[],
  quotas: Record<Difficulty, number>,
  supply: (domain: string, skill: string, d: Difficulty) => number,
  rng: () => number,
): Slot[] {
  const free = shuffle(skillUnits.map((u, i) => ({ ...u, i })), rng);
  const used = new Map<string, number>(); // skill+difficulty planned so far
  const slots: Slot[] = [];
  const totalSupply = (d: Difficulty) => skillUnits.reduce((s, u) => s + supply(u.domain, u.skill, d), 0);
  const order = [...DIFFICULTIES].sort((a, b) => (quotas[b] / Math.max(1, totalSupply(b))) - (quotas[a] / Math.max(1, totalSupply(a))));
  for (const d of order) {
    for (let n = 0; n < quotas[d] && free.length > 0; n++) {
      let best = 0;
      let bestLeft = -Infinity;
      free.forEach((u, idx) => {
        const left = supply(u.domain, u.skill, d) - (used.get(`${u.domain}\u0000${u.skill}\u0000${d}`) ?? 0);
        if (left > bestLeft) {
          bestLeft = left;
          best = idx;
        }
      });
      const [u] = free.splice(best, 1);
      const k = `${u.domain}\u0000${u.skill}\u0000${d}`;
      used.set(k, (used.get(k) ?? 0) + 1);
      slots.push({ domain: u.domain, skill: u.skill, difficulty: d });
    }
  }
  // Quotas always add up to the module size; anything left is Medium.
  for (const u of free) {
    const k = `${u.domain}\u0000${u.skill}\u0000Medium`;
    used.set(k, (used.get(k) ?? 0) + 1);
    slots.push({ domain: u.domain, skill: u.skill, difficulty: "Medium" });
  }
  // Swap difficulties between two slots when that turns a cell with no
  // questions into two cells that have them (quotas stay the same).
  const key = (s: Slot, d = s.difficulty) => `${s.domain}\u0000${s.skill}\u0000${d}`;
  const short = (s: Slot, d = s.difficulty) => (used.get(key(s, d)) ?? 0) > supply(s.domain, s.skill, d);
  const fits = (s: Slot, d: Difficulty) => (used.get(key(s, d)) ?? 0) < supply(s.domain, s.skill, d);
  for (const a of slots) {
    if (!short(a)) continue;
    const b = slots.find((s) => s.difficulty !== a.difficulty && fits(a, s.difficulty) && fits(s, a.difficulty));
    if (!b) continue;
    const [da, db] = [a.difficulty, b.difficulty];
    for (const [s, from, to] of [[a, da, db], [b, db, da]] as const) {
      used.set(key(s, from), (used.get(key(s, from)) ?? 1) - 1);
      used.set(key(s, to), (used.get(key(s, to)) ?? 0) + 1);
    }
    a.difficulty = db;
    b.difficulty = da;
  }
  return slots;
}

const DIFF_RANK: Record<Difficulty, number> = { Easy: 0, Medium: 1, Hard: 2 };

/** Order inside a module: R&W by official domain order then difficulty; Math by difficulty. */
export function orderModule(part: PartKey, qs: PoolQuestion[]): PoolQuestion[] {
  const domainRank = new Map(domainsOf(PART_SECTION[part]).map((d, i) => [d.name, i]));
  return [...qs].sort((a, b) =>
    part === "rw"
      ? (domainRank.get(a.domain) ?? 9) - (domainRank.get(b.domain) ?? 9) || DIFF_RANK[a.difficulty] - DIFF_RANK[b.difficulty]
      : DIFF_RANK[a.difficulty] - DIFF_RANK[b.difficulty] || (domainRank.get(a.domain) ?? 9) - (domainRank.get(b.domain) ?? 9),
  );
}

/** The order modules are filled in: hardest scarcity first. */
const FILL_ORDER: StageKey[] = ["m2_hard", "m1", "m2_easy", "m2"];

interface ShortfallAcc {
  part: PartKey;
  stage: StageKey;
  domain: string;
  difficulty: Difficulty;
  wanted: number;
  found: number;
  used: Map<string, number>;
}

function shortfallMessage(s: ShortfallAcc, single: boolean): Shortfall {
  const used = [...s.used.entries()].map(([how, n]) =>
    how === "skill" ? `${n} from another ${s.domain} skill` : how === "empty" ? `${n} left empty` : `${n} ${how}`,
  );
  const where = single ? PART_LABEL[s.part] : `${PART_LABEL[s.part]} ${STAGE_LABEL[s.stage]}`;
  return {
    part: s.part,
    stage: s.stage,
    domain: s.domain,
    difficulty: s.difficulty,
    wanted: s.wanted,
    found: s.found,
    used,
    message: `${where}: asked for ${s.wanted} ${s.difficulty} ${s.domain}, found ${s.found}${used.length ? `, ${used.join(", ")}` : ""}.`,
  };
}

export interface SelectOptions {
  seed: string;
  /** Ids (and their duplicates) never to use: earlier versions of this family. */
  exclude?: ReadonlySet<string>;
  /** "Make another version": excluded questions may refill shortfalls. */
  allowReuse?: boolean;
}

/** Build every module of a Custom test from the pool. */
export function buildSelection(pool: PoolQuestion[], rules: CustomRules, opts: SelectOptions): Selection {
  const rng = seededRng(opts.seed);
  const exclude = opts.exclude ?? new Set<string>();
  const excludedKeys = new Set(pool.filter((q) => exclude.has(q.id)).map((q) => q.dupKey));
  const fresh = pool.filter((q) => !exclude.has(q.id) && !excludedKeys.has(q.dupKey));
  const reuse = opts.allowReuse ? pool.filter((q) => exclude.has(q.id) || excludedKeys.has(q.dupKey)) : [];
  const out: Selection = { parts: {}, shortfalls: [] };
  const taken = { ids: new Set<string>(), keys: new Set<string>() };

  for (const key of rules.order.filter((k) => rules.parts[k])) {
    const part = rules.parts[key]!;
    const stages = partStages(rules.subject, part);
    const stageKeys = stages.map((s) => s.key);
    const picker = new Picker(
      fresh.filter((q) => q.part === key),
      reuse.filter((q) => q.part === key),
      rng,
      part,
      stageKeys,
      taken,
    );
    const skillCounts = stageSkillCounts(rules.subject, part);
    const skillsByDomain = new Map<string, string[]>();
    for (const [d, skills] of Object.entries(part.skills)) {
      const inPool = new Set(fresh.filter((q) => q.part === key && q.domain === d).map((q) => q.skill));
      skillsByDomain.set(d, [...new Set([...Object.keys(skills), ...inPool])]);
    }
    const picked = new Map<StageKey, PoolQuestion[]>();
    const acc = new Map<string, ShortfallAcc>();

    for (const stageKey of FILL_ORDER.filter((s) => stageKeys.includes(s))) {
      const units: { domain: string; skill: string }[] = [];
      for (const [k, n] of skillCounts[stageKey] ?? new Map()) {
        const { domain, skill } = splitSkillKey(k);
        for (let i = 0; i < n; i++) units.push({ domain, skill });
      }
      const quotas = difficultyQuotas(stageMix(part, stageKey), units.length);
      const slots = assignDifficulties(units, quotas, (d, s, diff) => picker.remaining(d, s, diff), rng);
      // Scarcest cells first.
      slots.sort((a, b) => picker.remaining(a.domain, a.skill, a.difficulty) - picker.remaining(b.domain, b.skill, b.difficulty));
      const mine: PoolQuestion[] = [];
      for (const slot of slots) {
        const got = picker.draw(stageKey, slot, skillsByDomain.get(slot.domain) ?? [slot.skill]);
        const accKey = `${stageKey}\u0000${slot.domain}\u0000${slot.difficulty}`;
        const a = acc.get(accKey) ?? { part: key, stage: stageKey, domain: slot.domain, difficulty: slot.difficulty, wanted: 0, found: 0, used: new Map() };
        a.wanted++;
        acc.set(accKey, a);
        if (!got) {
          a.used.set("empty", (a.used.get("empty") ?? 0) + 1);
          continue;
        }
        picker.record(stageKey, got.q);
        mine.push(got.q);
        if (got.how === "exact") a.found++;
        else a.used.set(got.how, (a.used.get(got.how) ?? 0) + 1);
      }
      picked.set(stageKey, mine);
    }

    out.parts[key] = stages.map((s) => ({ key: s.key, questionIds: orderModule(key, picked.get(s.key) ?? []).map((q) => q.id) }));
    for (const a of acc.values()) {
      if (a.found < a.wanted) out.shortfalls.push(shortfallMessage(a, stages.length === 1));
    }
  }
  return out;
}

/**
 * Replace one question with another from the same skill and difficulty
 * (then the same fallback chain), keeping the cap and de-duplication over
 * the whole test. Returns the new selection, or an error when nothing fits.
 */
export function replaceQuestion(
  pool: PoolQuestion[],
  rules: CustomRules,
  selection: Selection,
  target: { part: PartKey; questionId: string },
  opts: SelectOptions,
): { selection: Selection; note: string | null } | { error: string } {
  const stages = selection.parts[target.part];
  const part = rules.parts[target.part];
  if (!stages || !part) return { error: "That part isn't in this test" };
  const stage = stages.find((s) => s.questionIds.includes(target.questionId));
  if (!stage) return { error: "That question isn't in this test" };
  const byId = new Map(pool.map((q) => [q.id, q]));
  const old = byId.get(target.questionId);
  if (!old) return { error: "That question is no longer eligible — regenerate the test" };

  const exclude = opts.exclude ?? new Set<string>();
  const excludedKeys = new Set(pool.filter((q) => exclude.has(q.id)).map((q) => q.dupKey));
  const inPart = pool.filter((q) => q.part === target.part);
  const fresh = inPart.filter((q) => !exclude.has(q.id) && !excludedKeys.has(q.dupKey));
  const reuse = opts.allowReuse ? inPart.filter((q) => exclude.has(q.id) || excludedKeys.has(q.dupKey)) : [];
  // Everything in the test is taken, plus the replaced question's own
  // duplicates (a copy of it is no replacement).
  const taken = { ids: new Set<string>([target.questionId]), keys: new Set<string>([old.dupKey]) };
  const picker = new Picker(fresh, reuse, seededRng(`${opts.seed}:${target.questionId}`), part, stages.map((s) => s.key), taken);
  for (const s of Object.values(selection.parts).flat()) {
    for (const id of s!.questionIds) {
      const q = byId.get(id);
      if (q && id !== target.questionId) picker.record(s!.key, q);
    }
  }
  const skillsInDomain = [...new Set(inPart.filter((q) => q.domain === old.domain).map((q) => q.skill))];
  const got = picker.draw(stage.key, { domain: old.domain, skill: old.skill, difficulty: old.difficulty }, skillsInDomain);
  if (!got) return { error: `No other ${old.difficulty} ${old.skill} question is available (or any substitute in ${old.domain}).` };
  const parts = { ...selection.parts };
  parts[target.part] = stages.map((s) =>
    s.key === stage.key ? { key: s.key, questionIds: s.questionIds.map((id) => (id === target.questionId ? got.q.id : id)) } : s,
  );
  const note =
    got.how === "exact" ? null : got.how === "skill" ? `Used a ${got.q.skill} question (no other ${old.skill} left).` : `Used a ${got.how} question (no other ${old.difficulty} ${old.skill} left).`;
  return { selection: { parts, shortfalls: selection.shortfalls }, note };
}

/**
 * Server-side check of a selection before saving (never trust the preview
 * payload): every question eligible now and in the right part, no question
 * or duplicate twice in the test, module sizes within the rules, the skill
 * cap over what one student sees, and no earlier version's question unless
 * reuse was allowed. Returns the problems, empty when it can be saved.
 */
export function selectionErrors(
  pool: PoolQuestion[],
  rules: CustomRules,
  selection: Selection,
  opts: { exclude?: ReadonlySet<string>; allowReuse?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const byId = new Map(pool.map((q) => [q.id, q]));
  const ids = new Set<string>();
  const keys = new Map<string, string>();
  for (const key of Object.keys(selection.parts) as PartKey[]) {
    if (!rules.parts[key]) errors.push(`${PART_LABEL[key]} isn't part of this test`);
  }
  for (const key of rules.order.filter((k) => rules.parts[k])) {
    const part = rules.parts[key]!;
    const expected = partStages(rules.subject, part);
    const got = selection.parts[key] ?? [];
    if (got.length !== expected.length || expected.some((s, i) => got[i]?.key !== s.key)) {
      errors.push(`${PART_LABEL[key]}: modules don't match the rules — regenerate`);
      continue;
    }
    const cap = skillCap(part);
    const count = new Map<StageKey, Map<string, number>>();
    expected.forEach((s, i) => {
      const list = got[i].questionIds;
      const label = expected.length === 1 ? PART_LABEL[key] : `${PART_LABEL[key]} ${STAGE_LABEL[s.key]}`;
      if (list.length === 0) errors.push(`${label} has no questions`);
      if (list.length > s.n) errors.push(`${label} has ${list.length} questions; the rules allow ${s.n}`);
      const m = new Map<string, number>();
      for (const id of list) {
        const q = byId.get(id);
        if (!q || q.part !== key) {
          errors.push(`${label}: question ${id.slice(0, 8)} is no longer eligible — replace it`);
          continue;
        }
        if (ids.has(id)) errors.push(`${label}: question ${id.slice(0, 8)} appears twice`);
        else if (keys.has(q.dupKey)) errors.push(`${label}: question ${id.slice(0, 8)} is a copy of ${keys.get(q.dupKey)!.slice(0, 8)}`);
        if (opts.exclude?.has(id) && !opts.allowReuse) errors.push(`${label}: question ${id.slice(0, 8)} was used in an earlier version`);
        ids.add(id);
        keys.set(q.dupKey, id);
        const sk = `${q.domain}\u0000${q.skill}`;
        if (!isOtherSkill(q.skill)) m.set(sk, (m.get(sk) ?? 0) + 1);
      }
      count.set(s.key, m);
    });
    const m1 = count.get("m1") ?? new Map<string, number>();
    const m2s = expected.filter((s) => s.key !== "m1").map((s) => count.get(s.key) ?? new Map<string, number>());
    for (const path of m2s.length ? m2s : [new Map<string, number>()]) {
      for (const sk of new Set([...m1.keys(), ...path.keys()])) {
        const n = (m1.get(sk) ?? 0) + (path.get(sk) ?? 0);
        if (n > cap) errors.push(`${PART_LABEL[key]}: ${splitSkillKey(sk).skill} has ${n} questions for one student; the cap is ${cap}`);
      }
    }
    const perStudent = (got[0]?.questionIds.length ?? 0) + Math.min(...(got.length > 1 ? got.slice(1).map((s) => s.questionIds.length) : [0]));
    if (perStudent < Math.min(1, part.questions)) errors.push(`${PART_LABEL[key]} has no questions`);
  }
  return [...new Set(errors)];
}

/** Every question id of a selection (all modules). */
export function selectionIds(selection: Selection): string[] {
  return Object.values(selection.parts).flatMap((stages) => (stages ?? []).flatMap((s) => s.questionIds));
}
