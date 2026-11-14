// lib/review-queue-view.ts
//
// Paging, filters, cache keys and the undo rule of the review queue page
// (/admin/review-queue, Premier ticket 695b0797). The queue's grouping is
// built once and cached (app/(admin)/admin/review-queue/data.ts); this file
// decides which slice of that index one request shows. Pure (no DB, no
// Next imports): unit-tested in .omc/qa/unit/review-queue-view.test.ts.

import type { ReviewGroupId } from "@/lib/review-queue";

/** Cache tag of the queue index; every question / key / decision writer revalidates it. */
export const REVIEW_QUEUE_TAG = "review-queue";
/** Bumped when the cached index shape changes (old entries are then ignored). */
export const REVIEW_QUEUE_INDEX_VERSION = "v1";
/** Safety net for writers that can't revalidate the tag (scripts, cron SQL): seconds. */
export const REVIEW_QUEUE_REVALIDATE_S = 60;

export const DEFAULT_LIMIT = 15;
export const MAX_LIMIT = 200;
/** Cap of GET /api/admin/review-queue?limit= (Accept all pages through a module with the cursor). */
export const API_MAX_LIMIT = 30;

/** One question in the cached index: what grouping, ordering and filters need, no content. */
export interface QueueIndexEntry {
  id: string;
  primary: ReviewGroupId;
  also: ReviewGroupId[];
  status: string;
  /** In a published, assigned test now. */
  live: boolean;
  /** Real (non-QA) students who answered it. */
  students: number;
  moduleId: string | null;
  moduleName: string;
  /** "[Test #13] …" module prefix (null when the module has none). */
  testNo: number | null;
  section: string | null;
  number: number | null;
  /** Current key and a strong suggestion that differs from it ("Accept all"). */
  key: string | null;
  strong: string | null;
}

export interface QueueFilters {
  module: string | null;
  test: number | null;
  subject: string | null;
  liveOnly: boolean;
}

export const NO_FILTERS: QueueFilters = { module: null, test: null, subject: null, liveOnly: false };

/** "[Test #13] L Test 1 Math M2" → 13. */
export function testNoOf(moduleName: string | null | undefined): number | null {
  const m = (moduleName ?? "").match(/\[Test #(\d+)\]/i);
  return m ? Number(m[1]) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Filters from query params; anything malformed is ignored (no filter). */
export function parseFilters(p: URLSearchParams | Record<string, string | string[] | undefined>): QueueFilters {
  const get = (k: string): string | null => {
    if (p instanceof URLSearchParams) return p.get(k);
    const v = p[k];
    return Array.isArray(v) ? v[0] ?? null : v ?? null;
  };
  const module = get("module");
  const test = get("test");
  const subject = get("subject");
  return {
    module: module && UUID.test(module) ? module : null,
    test: test && /^\d{1,4}$/.test(test) ? Number(test) : null,
    subject: subject && subject.length <= 40 ? subject : null,
    liveOnly: get("live") === "1",
  };
}

/** The filters as query params (only the ones set). */
export function filterParams(f: QueueFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.module) out.module = f.module;
  if (f.test !== null) out.test = String(f.test);
  if (f.subject) out.subject = f.subject;
  if (f.liveOnly) out.live = "1";
  return out;
}

export function applyFilters(entries: QueueIndexEntry[], f: QueueFilters): QueueIndexEntry[] {
  return entries.filter(
    (e) =>
      (!f.module || e.moduleId === f.module) &&
      (f.test === null || e.testNo === f.test) &&
      (!f.subject || e.section === f.subject) &&
      (!f.liveOnly || e.live),
  );
}

export function parseLimit(raw: string | null | undefined, max = MAX_LIMIT): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

// ── Ordering and cursor ──────────────────────────────────────────────

export type SortKey = (string | number)[];

/** Live tests first, then most students, then module / question number (the old page's order). */
function baseKey(e: QueueIndexEntry): SortKey {
  return [e.live ? 0 : 1, -e.students, e.moduleId ?? "", e.number ?? 0, e.id];
}

export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * Entries of one group in display order, each with its sort key. Key
 * decisions are shown one block per module ("Accept all suggestions"): the
 * module's best entry places the block, the block keeps the base order.
 *
 * Known, accepted limit (review of 9d728a8, L3): a module block's key comes
 * from its best entry, so deciding that entry can move the block between two
 * page loads; a page boundary falling inside a moved block may then repeat
 * or skip a card of that module. The page de-duplicates by id, the counts
 * are unaffected, and switching / reloading the group lists everything.
 */
export function orderEntries(entries: QueueIndexEntry[], perModule: boolean): { entry: QueueIndexEntry; key: SortKey }[] {
  const mod = new Map<string, SortKey>();
  if (perModule) {
    for (const e of entries) {
      const m = e.moduleId ?? "";
      const k: SortKey = [e.live ? 0 : 1, -e.students, m];
      const cur = mod.get(m);
      if (!cur || compareKeys(k, cur) < 0) mod.set(m, k);
    }
  }
  return entries
    .map((entry) => ({ entry, key: perModule ? [...mod.get(entry.moduleId ?? "")!, ...baseKey(entry)] : baseKey(entry) }))
    .sort((a, b) => compareKeys(a.key, b.key));
}

export function encodeCursor(key: SortKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/** null for a missing or malformed cursor (= first page). */
export function decodeCursor(raw: string | null | undefined): SortKey | null {
  if (!raw || raw.length > 600) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length === 0 || v.length > 12) return null;
    if (!v.every((x) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x)))) return null;
    return v as SortKey;
  } catch {
    return null;
  }
}

/**
 * One page after `cursor` (entries strictly after it in display order).
 * The cursor is the last key served, not an offset, so questions decided
 * meanwhile (gone from the index) don't make the next page skip any.
 */
export function pageAfter<T>(ordered: { entry: T; key: SortKey }[], cursor: SortKey | null, limit: number): { entries: T[]; nextCursor: string | null } {
  const start = cursor ? ordered.findIndex((o) => compareKeys(o.key, cursor) > 0) : 0;
  if (start < 0) return { entries: [], nextCursor: null };
  const slice = ordered.slice(start, start + limit);
  const more = start + limit < ordered.length;
  return { entries: slice.map((o) => o.entry), nextCursor: more && slice.length ? encodeCursor(slice[slice.length - 1].key) : null };
}

// ── Counts ───────────────────────────────────────────────────────────

export interface GroupCount {
  waiting: number;
  /** Other groups the waiting questions also need: group → count. */
  also: Partial<Record<ReviewGroupId, number>>;
  /** Questions in the group per module. */
  byModule: Record<string, number>;
  /** Questions in the group with a strong suggestion that differs from the key, per module. */
  strongByModule: Record<string, number>;
}

export function groupCounts(entries: QueueIndexEntry[]): Partial<Record<ReviewGroupId, GroupCount>> {
  const out: Partial<Record<ReviewGroupId, GroupCount>> = {};
  for (const e of entries) {
    const c = (out[e.primary] ??= { waiting: 0, also: {}, byModule: {}, strongByModule: {} });
    c.waiting++;
    c.byModule[e.moduleId ?? ""] = (c.byModule[e.moduleId ?? ""] ?? 0) + 1;
    for (const a of e.also) c.also[a] = (c.also[a] ?? 0) + 1;
    if (e.strong && e.strong !== e.key) c.strongByModule[e.moduleId ?? ""] = (c.strongByModule[e.moduleId ?? ""] ?? 0) + 1;
  }
  return out;
}

/** The filter choices offered (from the whole index, so a filter never hides its own options). */
export function filterOptions(entries: QueueIndexEntry[]): { modules: { id: string; name: string }[]; tests: number[]; subjects: string[] } {
  const modules = new Map<string, string>();
  const tests = new Set<number>();
  const subjects = new Set<string>();
  for (const e of entries) {
    if (e.moduleId) modules.set(e.moduleId, e.moduleName);
    if (e.testNo !== null) tests.add(e.testNo);
    if (e.section) subjects.add(e.section);
  }
  return {
    modules: [...modules.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    tests: [...tests].sort((a, b) => a - b),
    subjects: [...subjects].sort(),
  };
}

// ── Session progress ("12 / 100 done today") ─────────────────────────

/** Calendar day in New York (the team's day), YYYY-MM-DD. */
export function nyDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** sessionStorage key of today's per-group decision counts. */
export function progressStorageKey(d: Date = new Date()): string {
  return `review-queue-done:${nyDay(d)}`;
}

// ── Undo of the last decision ────────────────────────────────────────

/** What the page remembers about the last decision it made (from the decide response). */
export interface DecisionRecord {
  action: string;
  /** The question is in a live test (the decide / key-change result said so). */
  live: boolean;
  /** set_key: the key actually changed. */
  keyChanged?: boolean;
  oldKey?: string | null;
  newKey?: string | null;
  /** The key the decision left (the new key, or the unchanged one). */
  keyAfter: string | null;
  /** The row's updated_at right after the decision (decide response); null = unknown. */
  updatedAt: string | null;
}

/**
 * Why an Undo must be refused now (null = it may go ahead): `card` is the
 * question re-read just before undoing. Undo only puts back what this page
 * changed, so the row must be exactly as the decision left it: same key,
 * same updated_at (any other edit, rescore or decision since moves it).
 */
export function undoBlocked(r: Pick<DecisionRecord, "keyAfter" | "updatedAt">, card: { key: string | null; updatedAt: string | null } | null): string | null {
  if (!card) return "The question couldn't be read again. Reload and check it before undoing.";
  if ((card.key ?? null) !== (r.keyAfter ?? null)) return `The key is now ${card.key ?? "∅"}, not ${r.keyAfter ?? "∅"} as your decision left it: someone changed it since. Reload and check it before undoing.`;
  if (!r.updatedAt) return "This decision's saved version is unknown, so it can't be undone safely. Reload and check the question.";
  if (card.updatedAt !== r.updatedAt) return "The question changed since your decision. Reload and check it before undoing.";
  return null;
}

// ── Focus mode: which card comes next ────────────────────────────────

/** The next card after `from` nobody decided (`done`) or just decided; stays at the end when none is left. */
export function nextOpenIndex(ids: string[], from: number, done: Set<string>, justDone: string | null = null): number {
  for (let i = from + 1; i < ids.length; i++) if (!done.has(ids[i]) && ids[i] !== justDone) return i;
  return Math.min(from + 1, Math.max(ids.length - 1, 0));
}

/**
 * After a decision on `decidedId`: the card to show, or null to stay put.
 * Only when that card is still the focused one (the person may have moved on
 * while the request ran, or this is a list-mode decision).
 */
export function advanceAfterDecision(ids: string[], focused: number, decidedId: string, done: Set<string>): number | null {
  if (ids[focused] !== decidedId) return null;
  return nextOpenIndex(ids, focused, done, decidedId);
}

/** Decision keys (1 / 2 / E / S) are ignored this long after the focused card changes. */
export const KEY_GUARD_MS = 400;

/** May a decision key act now? Not on auto-repeat, and not right after the card changed under the finger. */
export function decisionKeyAllowed(e: { repeat: boolean }, now: number, focusChangedAt: number): boolean {
  return !e.repeat && now - focusChangedAt >= KEY_GUARD_MS;
}

export type UndoPlan =
  /** Change the key back through the normal key path (rescore preview, then decide set_key). */
  | { kind: "set_key"; key: string; expectedKey: string | null }
  /** The live-fix Undo (snapshot recorded by the decision): restoreKey = key to put back after the rescore preview. */
  | { kind: "undo_live_fix"; restoreKey: string | null }
  /** Skip: only the page moved on. */
  | { kind: "unskip" }
  | { kind: "none"; why: string };

/**
 * How the last decision can be undone, using only data the decision itself
 * recorded and the server paths a normal decision uses (same audit notes,
 * same rescoring). A status is never lowered, so nothing that only approved
 * a question or cleared its notes can be undone.
 */
export function undoPlan(r: DecisionRecord): UndoPlan {
  switch (r.action) {
    case "skip":
      return { kind: "unskip" };
    case "set_key":
      if (!r.keyChanged) return { kind: "none", why: "The key didn't change, so there is nothing to put back." };
      // A live key change recorded the earlier version: the live-fix Undo puts back key + content.
      if (r.live) return { kind: "undo_live_fix", restoreKey: r.oldKey ?? null };
      if (!r.oldKey) return { kind: "none", why: "There was no key before; the queue never clears a key." };
      return { kind: "set_key", key: r.oldKey, expectedKey: r.newKey ?? null };
    case "use_pdf":
    case "use_pdf_text":
    case "regen_explanation":
      if (r.live) return { kind: "undo_live_fix", restoreKey: null };
      return { kind: "none", why: "The earlier content is only recorded for questions in a live test, so it can't be put back. Edit the question by hand." };
    case "keep_key":
    case "keep_figure":
    case "approve":
      return { kind: "none", why: "This decision only settled notes or approved the question; a status is never lowered and the old notes aren't recorded. Edit the question by hand." };
    case "confirm_live_fix":
      return { kind: "none", why: "Confirming drops the earlier version, so there is nothing to put back." };
    case "undo_live_fix":
      return { kind: "none", why: "This was already an Undo; the earlier version is gone." };
    default:
      return { kind: "none", why: "This decision can't be undone here." };
  }
}
