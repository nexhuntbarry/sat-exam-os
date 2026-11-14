// lib/test-assign-shared.ts
//
// Pure, client-safe helpers for assigning several tests at once (ticket
// b271dd38) and for the scheduled publish (tests.publish_at, migration
// 0034): duplicate skipping, the one-line summary, New York time input,
// and which Drafts are due. The DB side is lib/test-assign.ts.

import { formatShortDateTime } from "./datetime";

const NY_ZONE = "America/New_York";

// ── duplicate skipping ───────────────────────────────────────────────────────

/**
 * Which (test, student) pairs are new. `has(testId)` is the set of students
 * who can already see the test (directly or through a class); a pair already
 * there is skipped, never written twice. Repeated ids in the input count once.
 */
export function planStudentPairs(
  testIds: string[],
  studentIds: string[],
  has: (testId: string) => Set<string>,
): { add: Map<string, string[]>; skipped: number } {
  const students = Array.from(new Set(studentIds));
  const add = new Map<string, string[]>();
  let skipped = 0;
  for (const testId of Array.from(new Set(testIds))) {
    const already = has(testId);
    const fresh = students.filter((s) => !already.has(s));
    skipped += students.length - fresh.length;
    add.set(testId, fresh);
  }
  return { add, skipped };
}

/** `incoming` minus what's already in `existing` (order kept, repeats dropped). */
export function newIds(existing: Iterable<string>, incoming: Iterable<string>): string[] {
  const have = new Set(existing);
  const out: string[] = [];
  for (const id of incoming) {
    if (have.has(id)) continue;
    have.add(id);
    out.push(id);
  }
  return out;
}

/**
 * One notification per student: student id → the tests they newly got,
 * from every (test → newly reached students) entry. Order of first sight.
 */
export function testsPerStudent(newlyReached: Map<string, Iterable<string>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [testId, students] of newlyReached) {
    for (const s of students) {
      const list = out.get(s) ?? [];
      if (!list.includes(testId)) list.push(testId);
      out.set(s, list);
    }
  }
  return out;
}

// ── summary ──────────────────────────────────────────────────────────────────

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface BulkAssignTotals {
  /** Tests that were assigned (not refused, not failed). */
  tests: number;
  students: number;
  classes: number;
  teachers: number;
  /** Pairs already there (student, class or teacher), not written again. */
  skipped: number;
  /** publish_at of each Draft scheduled by this request. */
  scheduled: string[];
  /** Closed tests / full-length sections, refused (reasons per test). */
  refused: number;
  /** Tests that failed with an error. */
  failed: number;
  /** New pairs written (students + classes + teachers); 0 = everything was already there. */
  added?: number;
}

/**
 * "Assigned 3 tests to 5 students · 2 already assigned, skipped · 1 will
 * publish 11/20 4:00 PM" (New York time). `now` only decides whether the
 * year is shown.
 */
export function bulkAssignSummary(t: BulkAssignTotals, now: Date = new Date()): string {
  const who = [
    t.students > 0 ? plural(t.students, "student") : null,
    t.classes > 0 ? plural(t.classes, "class", "classes") : null,
    t.teachers > 0 ? plural(t.teachers, "teacher") : null,
  ].filter(Boolean);
  const parts: string[] = [];
  if (t.tests > 0 && t.added === 0 && t.scheduled.length === 0) parts.push("Nothing new");
  else if (t.tests > 0) parts.push(`Assigned ${plural(t.tests, "test")}${who.length ? ` to ${who.join(", ")}` : ""}`);
  else parts.push("No tests assigned");
  if (t.skipped > 0) parts.push(`${t.skipped} already assigned, skipped`);
  if (t.scheduled.length > 0) {
    const when = Array.from(new Set(t.scheduled.map((iso) => formatShortDateTime(iso, now))));
    parts.push(
      when.length === 1
        ? `${t.scheduled.length} will publish ${when[0]}`
        : `${t.scheduled.length} scheduled to publish`,
    );
  }
  if (t.refused > 0) parts.push(`${t.refused} refused`);
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  return parts.join(" · ");
}

// ── New York time input ─────────────────────────────────────────────────────

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function nyWallClock(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** New York's offset from UTC at `ms`, in ms (e.g. -5 h in winter). */
function nyOffset(ms: number): number {
  const w = nyWallClock(ms);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * "2026-11-20T16:00" (an <input type="datetime-local"> value) read as New
 * York wall-clock time → ISO string. Whatever the browser's own zone.
 * null for an empty or malformed value. A time skipped by the spring DST
 * jump moves forward an hour; an ambiguous fall-back time takes the first.
 */
export function nyLocalToIso(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((value ?? "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // Feb 30 etc.
  // The offset at the guess, then at the corrected instant; keep the one
  // that reads back as the requested wall clock. Neither does inside the
  // spring-forward gap: take the later (the time moves forward).
  const first = asUtc - nyOffset(asUtc);
  const second = asUtc - nyOffset(first);
  const reads = (ms: number) => {
    const w = nyWallClock(ms);
    return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
  };
  const ms = reads(second) ? second : reads(first) ? first : Math.max(first, second);
  return new Date(ms).toISOString();
}

/** ISO → "YYYY-MM-DDTHH:mm" New York wall-clock (for a datetime-local input). "" when empty/invalid. */
export function isoToNyLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const w = nyWallClock(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** Latest a new publish time may lie in the past (a slow form submit). */
export const PUBLISH_AT_GRACE_MS = 5 * 60_000;

/** Error for a requested publish time, or null when it's usable. */
export function publishAtError(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return "Publish time is not a valid date/time";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "Publish time is not a valid date/time";
  if (ms < now.getTime() - PUBLISH_AT_GRACE_MS) return "Publish time is in the past";
  if (ms > now.getTime() + 366 * 86_400_000) return "Publish time must be within a year";
  return null;
}

// ── scheduled publish ───────────────────────────────────────────────────────

export interface ScheduledRow {
  id: string;
  status: string | null;
  publish_at: string | null;
  publish_at_error: string | null;
  parent_test_id?: string | null;
  test_kind?: string | null;
}

/**
 * Drafts whose publish time has come: status Draft, publish_at ≤ now, and no
 * error note from an earlier failed try (those wait for a reschedule). A
 * full-length section never publishes on its own (it follows its parent).
 * Oldest first.
 */
export function duePublishes<T extends ScheduledRow>(rows: T[], now: Date = new Date()): T[] {
  return rows
    .filter((r) => {
      if (r.status !== "Draft" || !r.publish_at || r.publish_at_error) return false;
      if (r.parent_test_id || r.test_kind === "fl_section") return false;
      const ms = new Date(r.publish_at).getTime();
      return !Number.isNaN(ms) && ms <= now.getTime();
    })
    .sort((a, b) => new Date(a.publish_at!).getTime() - new Date(b.publish_at!).getTime());
}

/** The note kept on a test whose scheduled publish was refused. */
export function publishAtErrorNote(reason: string, at: Date = new Date()): string {
  return `${formatShortDateTime(at, at)}: not published — ${reason}`.slice(0, 1000);
}

// ── notifications ───────────────────────────────────────────────────────────

export const TESTS_ASSIGNED_TYPE = "tests_assigned";
export const SCHEDULED_PUBLISH_FAILED_TYPE = "scheduled_publish_failed";

/** Bell text for a student: "New test: X" / "3 new tests: X, Y, Z". */
export function testsAssignedMessage(
  tests: { name: string; publishAt?: string | null }[],
  now: Date = new Date(),
): { title: string; message: string } {
  const title = tests.length === 1 ? "New test assigned" : `${tests.length} new tests assigned`;
  const names = tests.map((t) =>
    t.publishAt ? `${t.name} (opens ${formatShortDateTime(t.publishAt, now)})` : t.name,
  );
  const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? `, +${names.length - 5} more` : "");
  return { title, message: shown };
}
