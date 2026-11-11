// lib/live-progress-shared.ts
//
// Live progress of students taking a test, as admins / teachers watch it
// during class (Submissions page, teacher test page, class Scores grid).
// Pure and client-safe: the types the snapshot API returns plus the text
// rules (connection status, time left, summary line). The server loader is
// lib/live-progress.ts; the cells are components/analytics/LiveProgressCell.
//
// Liveness comes from two server-owned metadata keys the autosave PATCH
// (app/api/student/submissions/[id]) stamps with server now():
//   last_active_at — every real save (answer, flag, navigation, tab switch)
//   last_seen_at   — every save AND the take page's idle keepalive
// So "Idle" = page alive but nothing changed for a while; "Offline" = not
// even a keepalive (laptop closed / crashed / no network).

import { formatShortDate, formatShortDateTime, formatTime } from "@/lib/datetime";

/** How often an open take page pings while nothing needs saving. */
export const KEEPALIVE_INTERVAL_MS = 60_000;
/** The PATCH skips the keepalive write when last_seen_at is younger than this. */
export const KEEPALIVE_MIN_WRITE_MS = 45_000;
/** How often the watching page polls the snapshot API. */
export const LIVE_POLL_MS = 20_000;
/** Slower poll while nobody is in progress but someone hasn't started (catches a class starting). */
export const WAITING_POLL_MS = 60_000;
/** No save for this long → "Idle N min". */
export const IDLE_AFTER_SECONDS = 120;
/** No save or keepalive for this long → "Offline since …" (keepalive is 60 s; background tabs may stretch it). */
export const OFFLINE_AFTER_SECONDS = 180;

/** Should a keepalive write last_seen_at now? (Throttles many open tabs.) */
export function keepaliveWriteDue(metadata: unknown, nowMs: number): boolean {
  const v = (metadata as Record<string, unknown> | null | undefined)?.last_seen_at;
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  return !Number.isFinite(at) || nowMs - at >= KEEPALIVE_MIN_WRITE_MS || at > nowMs + 60_000;
}

/** One unfinished attempt as the watching page shows it. Times are relative to LiveSnapshot.generatedAt. */
export interface LiveProgress {
  /** Attempt group key (lib/full-length-score attemptGroupKey) — the row it belongs to. */
  key: string;
  studentId: string;
  /** "module" = in a module; "break" = full-length break; "between" = Module 1 graded, Module 2 not created yet. */
  phase: "module" | "break" | "between";
  /** "Module 2", "R&W · Module 1"; null for a single-module test. */
  moduleLabel: string | null;
  /** 1-based question on screen, when known. */
  questionNumber: number | null;
  answered: number | null;
  total: number | null;
  /** Seconds left in the module at generatedAt; null = untimed. */
  remainingSeconds: number | null;
  /** Module 2 created but not opened yet (its clock hasn't started). */
  notOpened: boolean;
  /** Full-length break: seconds left at generatedAt. */
  breakRemainingSeconds: number | null;
  lastSeenAt: string | null;
  lastActiveAt: string | null;
  /** Left-tab total over the attempt's modules. */
  tabSwitches: number | null;
}

export interface LiveCounts {
  submitted: number;
  inProgress: number;
  notStarted: number;
}

export interface NotStartedStudent {
  studentId: string;
  name: string;
  email: string;
}

export interface LiveSnapshot {
  /** Server time the snapshot was taken (ISO). */
  generatedAt: string;
  /** Unfinished attempts by attempt key. */
  live: Record<string, LiveProgress>;
  counts: LiveCounts;
  /** Assigned students (active accounts) without any submission. */
  notStarted: NotStartedStudent[];
  /** Test still open for starts (not Closed, due date not >24 h past): keep the slow not-started poll. */
  acceptingStarts: boolean;
  /** The page couldn't load the snapshot and shows an empty one; the client keeps polling until it can. */
  degraded?: boolean;
}

/** Nothing to show (also the fallback when the loader fails; the page's polling then retries). */
export function emptyLiveSnapshot(generatedAt = new Date().toISOString()): LiveSnapshot {
  return { generatedAt, live: {}, counts: { submitted: 0, inProgress: 0, notStarted: 0 }, notStarted: [], acceptingStarts: false };
}

export type ConnectionKind = "active" | "idle" | "offline" | "unknown";

/**
 * "Active now" / "Idle 3 min" / "Offline since 4:15 PM" from the two
 * stamps, at `nowMs` (server-aligned). lastActiveAt falls back to lastSeenAt.
 */
export function connectionStatus(
  lastSeenAt: string | null,
  lastActiveAt: string | null,
  nowMs: number,
): { kind: ConnectionKind; text: string } {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(seen)) return { kind: "unknown", text: "No signal yet" };
  const active = lastActiveAt ? Date.parse(lastActiveAt) : NaN;
  const lastActive = Number.isFinite(active) ? active : seen;
  const lastContact = Math.max(seen, lastActive);
  if ((nowMs - lastContact) / 1000 >= OFFLINE_AFTER_SECONDS) {
    return { kind: "offline", text: `Offline since ${formatTime(lastContact)}` };
  }
  const activeAgo = Math.max(0, (nowMs - lastActive) / 1000);
  if (activeAgo >= IDLE_AFTER_SECONDS) {
    return { kind: "idle", text: `Idle ${Math.floor(activeAgo / 60)} min` };
  }
  return { kind: "active", text: "Active now" };
}

/** "12:34" / "1:02:03" (whole seconds, never negative). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "12:34 left" / "Time up" / null (untimed). */
export function timeLeftText(seconds: number | null): string | null {
  if (seconds == null) return null;
  return seconds <= 0 ? "Time up" : `${formatClock(seconds)} left`;
}

/** Seconds left now, from a value taken `elapsedMs` ago. */
export function secondsLeftAfter(seconds: number | null, elapsedMs: number): number | null {
  if (seconds == null) return null;
  return Math.max(0, Math.ceil(seconds - Math.max(0, elapsedMs) / 1000));
}

/** The take page's 0-based metadata.current_index → 1-based question number, when it fits the module. */
export function questionNumberOf(index: unknown, total: number | null): number | null {
  const n = typeof index === "number" ? index : typeof index === "string" && index.trim() ? Number(index) : NaN;
  if (!Number.isInteger(n) || n < 0) return null;
  if (total != null && n >= total) return null;
  return n + 1;
}

/** Answers actually given (an empty value is a cleared answer). */
export function answeredCount(answers: Record<string, unknown> | null | undefined): number {
  return Object.values(answers ?? {}).filter((v) => typeof v === "string" && v !== "").length;
}

/** "Module 2 · Q14" / "Q14" / "Module 2" / null. */
export function positionText(p: Pick<LiveProgress, "moduleLabel" | "questionNumber">): string | null {
  const q = p.questionNumber != null ? `Q${p.questionNumber}` : null;
  return [p.moduleLabel, q].filter(Boolean).join(" · ") || null;
}

/** "Module 2" → "M2", "R&W · Module 1" → "R&W M1" (the class Scores grid's short form). */
export function shortModuleLabel(label: string | null): string | null {
  if (!label) return null;
  return label.replace(/(?:\s*·\s*)?Module (\d+)$/, (_m, n: string) => ` M${n}`).trim() || null;
}

/**
 * One-line position for a grid cell: "M2 · Q14 · 11/22 · 12:34 left",
 * "R&W M2 · not opened yet". `timeLeft` is timeLeftText's output (now).
 */
export function compactModuleLine(
  p: Pick<LiveProgress, "moduleLabel" | "questionNumber" | "answered" | "total" | "notOpened">,
  timeLeft: string | null,
): string {
  const parts = [
    shortModuleLabel(p.moduleLabel),
    p.questionNumber != null ? `Q${p.questionNumber}` : null,
    p.answered != null ? (p.total != null ? `${p.answered}/${p.total}` : `${p.answered} answered`) : null,
    p.notOpened ? "not opened yet" : timeLeft,
  ];
  return parts.filter(Boolean).join(" · ") || "In module";
}

/** Live entry of a class Scores cell: column (test) id + student id. */
export function gradebookLiveKey(testId: string, studentId: string): string {
  return `${testId}:${studentId}`;
}

/**
 * Per-test live maps (attempt key → progress) → one map by grid cell
 * (gradebookLiveKey). Two unfinished attempts of one test (rare) → the
 * one heard from last.
 */
export function byGradebookCell(perTest: { testId: string; live: Record<string, LiveProgress> }[]): Record<string, LiveProgress> {
  const out: Record<string, LiveProgress> = {};
  const contact = (p: LiveProgress) => Math.max(Date.parse(p.lastSeenAt ?? "") || 0, Date.parse(p.lastActiveAt ?? "") || 0);
  for (const { testId, live } of perTest) {
    for (const p of Object.values(live)) {
      const k = gradebookLiveKey(testId, p.studentId);
      const cur = out[k];
      if (!cur || contact(p) > contact(cur)) out[k] = { ...p, key: k };
    }
  }
  return out;
}

/** Answered share 0–100 for the progress bar, or null. */
export function answeredPercent(answered: number | null, total: number | null): number | null {
  if (answered == null || !total || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((answered / total) * 100)));
}

/** Attempt status → summary bucket ("Closed …" counts as finished). */
export function countBucket(status: string): keyof LiveCounts | null {
  if (status === "Not started") return "notStarted";
  if (status === "In progress" || status === "On break") return "inProgress";
  if (status === "Submitted" || status === "Late" || status.startsWith("Closed")) return "submitted";
  return null;
}

/**
 * Per-student summary: each student's latest attempt (highest attempt
 * number) decides their bucket; assigned students with no attempt are
 * not started.
 */
export function summarizeCounts(
  attempts: { studentId: string; attemptNumber: number; status: string }[],
  assignedStudentIds: Iterable<string>,
): LiveCounts {
  const latest = new Map<string, { n: number; status: string }>();
  for (const a of attempts) {
    const cur = latest.get(a.studentId);
    if (!cur || a.attemptNumber > cur.n) latest.set(a.studentId, { n: a.attemptNumber, status: a.status });
  }
  const counts: LiveCounts = { submitted: 0, inProgress: 0, notStarted: 0 };
  for (const { status } of latest.values()) {
    const b = countBucket(status);
    if (b) counts[b]++;
  }
  for (const id of new Set(assignedStudentIds)) if (!latest.has(id)) counts.notStarted++;
  return counts;
}

/** "3 submitted · 1 in progress · 0 not started". */
export function summaryText(c: LiveCounts): string {
  return `${c.submitted} submitted · ${c.inProgress} in progress · ${c.notStarted} not started`;
}

/** "Updated 10s ago" / "Updated 2 min ago". */
export function updatedAgoText(elapsedMs: number): string {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  return s < 60 ? `Updated ${s}s ago` : `Updated ${Math.floor(s / 60)} min ago`;
}

/**
 * The Submitted column: "11/11 4:11 PM" once finished, "Started 4:11 PM"
 * while unfinished (date added when it wasn't today in New York), "—" else.
 */
export function submittedColumnText(
  a: { finished: boolean; submittedAt: string | null; startedAt: string | null },
  now: Date = new Date(),
): string {
  if (a.finished) return a.submittedAt ? formatShortDateTime(a.submittedAt, now) : "—";
  if (!a.startedAt) return "—";
  const sameDay = formatShortDate(a.startedAt, now) === formatShortDate(now, now);
  return `Started ${sameDay ? formatTime(a.startedAt) : formatShortDateTime(a.startedAt, now)}`;
}

/** Live keys or counts differ → rows were added / finished; the page re-renders its rows. */
export function snapshotShapeChanged(a: LiveSnapshot, b: LiveSnapshot): boolean {
  const ka = Object.keys(a.live).sort().join("|");
  const kb = Object.keys(b.live).sort().join("|");
  return (
    ka !== kb ||
    a.counts.submitted !== b.counts.submitted ||
    a.counts.inProgress !== b.counts.inProgress ||
    a.counts.notStarted !== b.counts.notStarted
  );
}
