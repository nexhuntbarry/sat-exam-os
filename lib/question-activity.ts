// lib/question-activity.ts
//
// What a student did on each question during a module, for teacher
// analytics: time on screen, how often they came to it, the answers they
// went through, and whether they left it unanswered on the first pass.
//
// The take page records it in memory and sends it with every autosave as
// submissions.metadata.question_activity; grading copies the time into
// answer_records.time_spent_seconds. It never affects scoring.

/** One question's record. Short keys: it rides every autosave. */
export interface QuestionActivity {
  /** Milliseconds the question was on screen while the page was visible. */
  t: number;
  /** Times the student came to the question (a page reload is not one). */
  v: number;
  /** Distinct answers in the order given, oldest first (capped). */
  h: string[];
  /** Set when the first visit ends: 1 = left unanswered, 0 = answered. */
  s?: 0 | 1;
}

export type ActivityMap = Record<string, QuestionActivity>;

/** Answers kept per question; the first is never dropped. */
const MAX_HISTORY = 8;
/** One question can't plausibly be on screen longer than this (3 h). */
const MAX_MS = 3 * 60 * 60 * 1000;

/** Coerce stored/untrusted data into a clean map for the given questions. */
export function parseActivity(raw: unknown, validIds?: Set<string>): ActivityMap {
  const out: ActivityMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [qid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (validIds && !validIds.has(qid)) continue;
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const t = typeof r.t === "number" && Number.isFinite(r.t) ? Math.min(Math.max(0, r.t), MAX_MS) : 0;
    const visits = typeof r.v === "number" && Number.isFinite(r.v) ? Math.max(0, Math.floor(r.v)) : 0;
    const h = Array.isArray(r.h) ? r.h.filter((x): x is string => typeof x === "string").slice(-MAX_HISTORY) : [];
    const rec: QuestionActivity = { t: Math.round(t), v: visits, h };
    if (r.s === 0 || r.s === 1) rec.s = r.s;
    out[qid] = rec;
  }
  return out;
}

/**
 * Combine two copies (server + this device's backup): the one with more
 * time on screen is the more complete record of that question.
 */
export function mergeActivity(a: ActivityMap, b: ActivityMap): ActivityMap {
  const out: ActivityMap = { ...a };
  for (const [qid, rec] of Object.entries(b)) {
    const cur = out[qid];
    if (!cur || rec.t > cur.t) out[qid] = rec;
  }
  return out;
}

function entry(map: ActivityMap, qid: string): QuestionActivity {
  return (map[qid] ??= { t: 0, v: 0, h: [] });
}

/** Record an answer the student settled on (empty = cleared, ignored). */
export function recordAnswer(map: ActivityMap, qid: string, answer: string | null | undefined) {
  const a = (answer ?? "").trim();
  if (!a) return;
  const rec = entry(map, qid);
  if (rec.h[rec.h.length - 1] === a) return;
  rec.h.push(a);
  if (rec.h.length > MAX_HISTORY) rec.h.splice(1, 1);
}

/** The student arrived at a question. countVisit=false for a page reload. */
export function recordArrive(map: ActivityMap, qid: string, countVisit: boolean) {
  const rec = entry(map, qid);
  if (countVisit || rec.v === 0) rec.v += 1;
}

/** The student left a question; `answer` is what it holds as they leave. */
export function recordLeave(map: ActivityMap, qid: string, answer: string | null | undefined) {
  const rec = entry(map, qid);
  recordAnswer(map, qid, answer);
  if (rec.s === undefined) rec.s = (answer ?? "").trim() ? 0 : 1;
}

export function addTime(map: ActivityMap, qid: string, ms: number) {
  if (!(ms > 0)) return;
  const rec = entry(map, qid);
  rec.t = Math.min(MAX_MS, Math.round(rec.t + ms));
}

/** Teacher-facing reading of one record (null when the question was never opened). */
export interface ActivitySummary {
  seconds: number;
  visits: number;
  /** Answers the student went through, oldest first. */
  history: string[];
  /** Times the answer changed after the first one. */
  changes: number;
  /** Left unanswered on the first pass, then came back to it. */
  skippedAndReturned: boolean;
  /** Left unanswered on the first pass and never came back. */
  skippedNeverReturned: boolean;
}

export function summarizeActivity(rec: QuestionActivity | undefined | null): ActivitySummary | null {
  if (!rec || rec.v === 0) return null;
  return {
    seconds: Math.round(rec.t / 1000),
    visits: rec.v,
    history: rec.h,
    changes: Math.max(0, rec.h.length - 1),
    skippedAndReturned: rec.s === 1 && rec.v > 1,
    skippedNeverReturned: rec.s === 1 && rec.v <= 1,
  };
}
