// lib/test-pairing.ts
//
// Which R&W test and which Math test make one "set" (one R&W + Math total),
// shared by every place a total is derived from two section tests: the
// one-page report, the student pages' chart and recent tests, the old PDF
// report and the class Scores grid (ticket f7276162). Pure, except the two
// DB helpers at the end (read / write the admin override).
//
// For one student's finished section attempts:
//   1. Admin override (tests.pairing, migration 0036): a test set to
//      "paired with B" forms a set with B only; a test set to "no pair"
//      never forms one. Either way it is left out of the automatic steps.
//   2. Same set name: each test name with the subject words removed
//      (normalizeSetName). An R&W and a Math test whose names are equal
//      after that form one set, whatever days they were taken on.
//   3. Fallback, as before: an R&W and a Math test finished on the same New
//      York day.
// A set with only one section finished has no total. A section taken more
// than once in a set: the latest attempt counts. Full-length SATs are not
// passed in (each keeps its own total). Scores are never changed here.

import type { SupabaseClient } from "@supabase/supabase-js";

export const PAIR_RW = "Reading & Writing";
export const PAIR_MATH = "Math";
export type PairSection = typeof PAIR_RW | typeof PAIR_MATH;

/**
 * Admin overrides by test id: the partner test id, or null = "explicitly no
 * pair". A test that isn't in the map is paired automatically.
 */
export type PairOverrides = ReadonlyMap<string, string | null>;

export interface PairItem {
  section: PairSection;
  /** ISO timestamp the attempt was finished. */
  date: string;
  testId?: string | null;
  testName?: string | null;
}

export interface PairedSet<T extends PairItem> {
  key: string;
  /** The set's name (normalized test name); null for a same-day pair of differently named tests. */
  name: string | null;
  rw: T | null;
  math: T | null;
  /** When the later section was finished. */
  date: string;
  via: "override" | "name" | "day";
}

// Longest first, so "Reading & Writing" goes before "RW" and "English" before "Eng".
const SUBJECT_WORDS =
  /(?<![\p{L}\p{N}])(?:reading\s*(?:&|and)\s*writing|english|r\s*&\s*w|rw|eng|math)(?![\p{L}\p{N}])/giu;

/**
 * The set name of a test: its name without the subject words (Eng, English,
 * RW, R&W, Reading & Writing, Reading and Writing, Math; any case), with the
 * whitespace and punctuation left dangling cleaned up.
 * "Nov 26 SAT Intensive Math day 1" → "Nov 26 SAT Intensive day 1".
 */
export function normalizeSetName(name: string | null | undefined): string {
  return (name ?? "")
    .replace(SUBJECT_WORDS, " ")
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ")
    .replace(/([[({])\s+/g, "$1")
    .replace(/\s+([\])}])/g, "$1")
    // A separator left standing alone ("SAT - - day 1") or doubled ("2025-09--Module").
    .replace(/(^|\s)[-–—_/|:,.+&]+(?=\s|$)/g, " ")
    .replace(/([-–—_/|:,.+&])\s+(?=[-–—_/|:,.+&])/g, "$1")
    .replace(/([-–—_/|:,.+&])[-–—_/|:,.+&]+/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—_/|:,.+&]+|[\s\-–—_/|:,.+&]+$/g, "")
    .trim();
}

/** What two set names are compared by: case, punctuation and spacing ignored. */
export function setNameKey(name: string | null | undefined): string {
  return normalizeSetName(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const NY_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
/** The New York calendar day of an ISO timestamp ("2026-11-20"). */
export function nyDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : NY_DAY.format(d);
}

const later = (a: string, b: string) => (a > b ? a : b);
function latest<T extends PairItem>(list: T[], section: PairSection): T | null {
  let best: T | null = null;
  for (const it of list) if (it.section === section && (!best || it.date > best.date)) best = it;
  return best;
}

/** The overrides made symmetric: "A paired with B" also reads as "B paired with A". */
function symmetric(overrides: PairOverrides | undefined): Map<string, string | null> {
  const out = new Map<string, string | null>(overrides ?? []);
  for (const [a, b] of overrides ?? []) if (b && !out.has(b)) out.set(b, a);
  return out;
}

/**
 * Group one student's finished section attempts into sets (oldest first).
 * Every item lands in exactly one set; an older attempt of a section that a
 * later one in the same set replaces is dropped.
 */
export function pairSections<T extends PairItem>(items: T[], overrides?: PairOverrides): PairedSet<T>[] {
  const ov = symmetric(overrides);
  const out: PairedSet<T>[] = [];
  const used = new Set<T>();
  const byTest = new Map<string, T[]>();
  for (const it of items) if (it.testId) byTest.set(it.testId, [...(byTest.get(it.testId) ?? []), it]);

  const make = (key: string, name: string | null, rw: T | null, math: T | null, via: PairedSet<T>["via"]): PairedSet<T> => ({
    key,
    name,
    rw,
    math,
    date: later(rw?.date ?? "", math?.date ?? ""),
    via,
  });

  // 1. Overrides. A test with an override never pairs automatically.
  const locked: T[] = [];
  for (const [testId, list] of byTest) {
    if (!ov.has(testId) || used.has(list[0])) continue;
    const partnerId = ov.get(testId) ?? null;
    const partner = partnerId && ov.get(partnerId) === testId ? byTest.get(partnerId) : undefined;
    const mine = list[0].section;
    if (partner && partner.length > 0 && partner[0].section !== mine) {
      const all = [...list, ...partner];
      const rw = latest(all, PAIR_RW);
      const math = latest(all, PAIR_MATH);
      const nRw = normalizeSetName(rw?.testName);
      const nMath = normalizeSetName(math?.testName);
      const name = setNameKey(nRw) === setNameKey(nMath) ? nRw : [nRw, nMath].filter(Boolean).join(" + ");
      out.push(make(`pair:${[testId, partnerId].sort().join(":")}`, name || null, rw, math, "override"));
      for (const it of all) used.add(it);
    } else {
      // "No pair", or the partner isn't taken (or is the same section): this test stands alone.
      for (const it of list) {
        locked.push(it);
        used.add(it);
      }
    }
  }

  // 2. Same set name, any day.
  const byName = new Map<string, T[]>();
  for (const it of items) {
    if (used.has(it)) continue;
    const k = setNameKey(it.testName);
    if (k) byName.set(k, [...(byName.get(k) ?? []), it]);
  }
  for (const [k, list] of byName) {
    const rw = latest(list, PAIR_RW);
    const math = latest(list, PAIR_MATH);
    if (!rw || !math) continue;
    out.push(make(`name:${k}`, normalizeSetName(rw.testName) || null, rw, math, "name"));
    for (const it of list) used.add(it);
  }

  // 3. Same New York day (an overridden test only with its own attempts that day).
  const byDay = new Map<string, T[]>();
  for (const it of [...items.filter((i) => !used.has(i)), ...locked]) {
    const k = locked.includes(it) ? `day:${nyDay(it.date)}:solo:${it.testId}` : `day:${nyDay(it.date)}`;
    byDay.set(k, [...(byDay.get(k) ?? []), it]);
  }
  for (const [k, list] of byDay) {
    const rw = latest(list, PAIR_RW);
    const math = latest(list, PAIR_MATH);
    const only = rw && math ? null : (rw ?? math)!;
    out.push(make(k, only ? normalizeSetName(only.testName) || null : null, rw, math, "day"));
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

// ── Chart labels ──────────────────────────────────────────────────────

/** Longest label drawn under a chart point (characters). */
export const SET_LABEL_MAX = 22;

const tokenKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Short chart labels for set names: the words a name shares at the start
 * (and end) with another set on the same chart are dropped, so sets of one
 * series read "Day 1", "Day 2"… ("Nov 26 SAT Intensive day 1" next to
 * "… day 2"). A number left on its own keeps the word before it. Long
 * labels are cut at SET_LABEL_MAX with "…". null stays null.
 */
export function shortSetLabels(names: (string | null)[]): (string | null)[] {
  const toks = names.map((n) => (n ? n.split(/\s+/).filter(Boolean) : null));
  const same = (a: string, b: string) => tokenKey(a) === tokenKey(b) && tokenKey(a) !== "";
  return toks.map((t, i) => {
    if (!t || t.length === 0) return null;
    let pre = 0;
    let suf = 0;
    const mine = t.map(tokenKey).join(" ");
    toks.forEach((o, j) => {
      if (j === i || !o || o.map(tokenKey).join(" ") === mine) return;
      let p = 0;
      while (p < t.length && p < o.length && same(t[p], o[p])) p++;
      let s = 0;
      while (s < t.length && s < o.length && same(t[t.length - 1 - s], o[o.length - 1 - s])) s++;
      pre = Math.max(pre, p);
      suf = Math.max(suf, s);
    });
    // Keep at least one word.
    if (pre + suf >= t.length) {
      suf = Math.max(0, t.length - pre - 1);
      if (pre >= t.length) pre = t.length - 1;
    }
    // "1" alone says little: keep the word before it ("day 1", "Test #19").
    if (pre > 0 && /^\d+$/.test(tokenKey(t[pre]))) pre--;
    let label = t.slice(pre, t.length - suf).join(" ");
    const open = (label.match(/[[({]/g) ?? []).length;
    const close = (label.match(/[\])}]/g) ?? []).length;
    if (open !== close) label = label.replace(/[[\](){}]/g, "").trim();
    // "[Test #19]" → "Test #19".
    label = label.replace(/^[[({]([^[\](){}]*)[\])}]$/, "$1").trim();
    label = label.charAt(0).toUpperCase() + label.slice(1);
    return label.length > SET_LABEL_MAX ? `${label.slice(0, SET_LABEL_MAX - 1).trimEnd()}…` : label;
  });
}

// ── Admin override (tests.pairing) ────────────────────────────────────
//
// tests.pairing jsonb (migration 0036): NULL = automatic; {"test_id": "<id>"}
// = paired with that test; {"test_id": null} = explicitly no pair. Until the
// migration is applied the column doesn't exist: reads return no overrides
// (automatic pairing everywhere), writes report "column-missing".

type DbError = { code?: string; message?: string; status?: number } | null | undefined;

/** The error is "tests.pairing doesn't exist yet" (migration 0036 not applied). */
export function isPairingColumnMissing(err: DbError): boolean {
  if (!err) return false;
  const msg = err.message ?? "";
  if (!/pairing/.test(msg)) return false;
  return err.code === "42703" || err.code === "PGRST204" || err.status === 400 || /does not exist|schema cache/.test(msg);
}

/** Pure: a tests.pairing value → override (undefined = automatic). */
export function parsePairing(v: unknown): string | null | undefined {
  if (!v || typeof v !== "object" || !("test_id" in v)) return undefined;
  const id = (v as { test_id: unknown }).test_id;
  return typeof id === "string" && id ? id : id === null ? null : undefined;
}

/**
 * Overrides of `testIds` (all tests when omitted). An override pointing at a
 * test that no longer exists counts as automatic. Never throws: a missing
 * column or a failed read means automatic pairing.
 */
export async function loadPairOverrides(db: SupabaseClient, testIds?: Iterable<string>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  try {
    const ids = testIds ? Array.from(new Set(testIds)) : null;
    if (ids && ids.length === 0) return out;
    let q = db.from("tests").select("id, pairing").not("pairing", "is", null);
    if (ids) q = q.in("id", ids);
    const { data, error } = await q;
    if (error) {
      if (!isPairingColumnMissing(error)) console.error("[test-pairing] override read failed:", error.message);
      return out;
    }
    const rows = (data ?? []) as { id: string; pairing: unknown }[];
    const partners = rows.map((r) => parsePairing(r.pairing)).filter((p): p is string => typeof p === "string");
    const existing = new Set<string>();
    if (partners.length) {
      const { data: found } = await db.from("tests").select("id").in("id", Array.from(new Set(partners)));
      for (const r of (found ?? []) as { id: string }[]) existing.add(r.id);
    }
    for (const r of rows) {
      const p = parsePairing(r.pairing);
      if (p === null) out.set(r.id, null);
      else if (p && existing.has(p)) out.set(r.id, p);
    }
  } catch (e) {
    console.error("[test-pairing] override read failed:", e);
  }
  return out;
}

export type PairingMode = { mode: "auto" } | { mode: "none" } | { mode: "pair"; partnerId: string };

/**
 * Set a test's override, keeping it symmetric: pairing A with B also sets
 * B → A, and any other test that pointed at A or B goes back to automatic.
 * "none" / "auto" on A also returns A's old partner to automatic. Callers
 * check the tests first (exist, sections, QA side). Writes tests.pairing only.
 */
export async function writePairOverride(db: SupabaseClient, testId: string, next: PairingMode): Promise<"ok" | "column-missing"> {
  const touched = next.mode === "pair" ? [testId, next.partnerId] : [testId];
  const { data: pointing, error: readErr } = await db.from("tests").select("id, pairing").not("pairing", "is", null);
  if (readErr) {
    if (isPairingColumnMissing(readErr)) return "column-missing";
    throw new Error(`pairing read failed: ${readErr.message}`);
  }
  // Whoever points at A (or B) now, other than A and B themselves: back to automatic.
  const stale = ((pointing ?? []) as { id: string; pairing: unknown }[])
    .filter((r) => !touched.includes(r.id))
    .filter((r) => {
      const p = parsePairing(r.pairing);
      return typeof p === "string" && touched.includes(p);
    })
    .map((r) => r.id);
  const updates: [string[], unknown][] = [[stale, null]];
  if (next.mode === "pair") {
    updates.push([[testId], { test_id: next.partnerId }], [[next.partnerId], { test_id: testId }]);
  } else {
    updates.push([[testId], next.mode === "none" ? { test_id: null } : null]);
  }
  for (const [ids, pairing] of updates) {
    if (ids.length === 0) continue;
    const { error } = await db.from("tests").update({ pairing }).in("id", ids);
    if (error) {
      if (isPairingColumnMissing(error)) return "column-missing";
      throw new Error(`pairing write failed: ${error.message}`);
    }
  }
  return "ok";
}

/**
 * Pure: the automatic partner of a test by set name among `candidates`
 * (tests of the other section): the newest one with the same set name, or
 * null (sets then fall back to the same New York day, per student).
 */
export function autoPartnerByName<C extends { id: string; name: string; createdAt?: string | null }>(
  testName: string,
  candidates: C[],
): C | null {
  const k = setNameKey(testName);
  if (!k) return null;
  return candidates.filter((c) => setNameKey(c.name) === k).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0] ?? null;
}
