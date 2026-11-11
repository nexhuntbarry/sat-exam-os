"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { useAuth } from "@clerk/nextjs";
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  Calculator,
  BookOpen,
  X,
  Eye,
  EyeOff,
  MoreHorizontal,
  Grid3x3,
  Infinity as InfinityIcon,
} from "lucide-react";
import { clsx } from "clsx";
import TestTimer from "@/components/tests/TestTimer";
import QuestionRenderer from "@/components/tests/QuestionRenderer";
import QuestionErrorBoundary from "@/components/tests/QuestionErrorBoundary";
import QuestionNavigator from "@/components/tests/QuestionNavigator";
import SubmitModal from "@/components/tests/SubmitModal";
import ReportProblemButton from "@/components/tests/ReportProblemButton";
import {
  type ActivityMap,
  addTime,
  mergeActivity,
  parseActivity,
  recordAnswer,
  recordArrive,
  recordLeave,
} from "@/lib/question-activity";
import { KEEPALIVE_INTERVAL_MS } from "@/lib/live-progress-shared";

interface Question {
  id: string;
  module_id: string;
  original_question_number: number;
  question_text: string;
  choices: { label: string; text: string; image_url?: string | null }[];
  question_type: "Multiple Choice" | "Student Produced Response";
  has_image: boolean;
  has_table: boolean;
  source_pdf_url?: string | null;
  page_number?: number | null;
  section: string;
  image_urls?: string[] | null;
  image_alts?: string[] | null;
  /** Fill-in box length (5/6, more for a verified longer key). */
  spr_max_chars?: number | null;
}

interface Props {
  testId: string;
  submissionId: string;
  /** Server start time of this attempt; an admin reset sets a new one. */
  attemptStartedAt: string;
  initialAnswers: Record<string, string>;
  initialMetadata: Record<string, unknown>;
  test: {
    id: string;
    name: string;
    timeLimitMinutes: number;
    /** When true, no countdown is shown and the test never auto-submits. */
    isUntimed: boolean;
    dueDate: string | null;
    moduleLabel: string | null;
    desmosEnabled: boolean;
    formulaSheetUrl: string | null;
    /** When true, R&W highlight UX is enabled on the stem. */
    annotationsEnabled: boolean;
  };
  questions: Question[];
  timeRemainingSeconds: number;
  /** Admin setting: show the per-question "Report a problem" button. */
  reportsEnabled?: boolean;
  /**
   * Where to go after Module 1 is submitted (default: this test's take
   * page, which opens Module 2). The full-length SAT page passes its own URL.
   */
  continueUrl?: string;
  /** Where to go after the last module is submitted (default: the result page). */
  doneUrl?: string;
  /** Section name shown before the module pill (full-length SAT only). */
  sectionLabel?: string;
}

// Multiple-choice picks save immediately; SPR typing and flag / cross-out /
// navigation changes are debounced by this much.
const AUTO_SAVE_DEBOUNCE_MS = 800;
const SAVE_RETRY_MAX_MS = 30000;
const SUBMIT_TIMEOUT_MS = 20000;
const SUBMIT_MAX_ATTEMPTS = 3;
// While a submit is pending, ask the server every few seconds whether it
// already landed; after SUBMIT_STUCK_MS also show a "Continue" escape hatch.
const SUBMIT_POLL_MS = 5000;
const SUBMIT_STUCK_MS = 15000;
// Browsers cap the total body of in-flight keepalive requests at 64KB.
const KEEPALIVE_MAX_BYTES = 60000;

// "closed": the server won't take autosaves any more (time is up or the
// module was already finalized), so only Submit can still deliver answers.
type SaveStatus = "saved" | "saving" | "error" | "closed";

// Background submit retries after every immediate attempt failed: 5 s,
// 10 s, 20 s… capped here, until the submit lands or the page closes.
const SUBMIT_BACKGROUND_RETRY_MAX_MS = 60000;
// After this many background retries, stop and ask the student to contact
// their teacher (the answers stay on this device; the button still works).
const SUBMIT_BACKGROUND_RETRY_LIMIT = 10;

type SubmitPayload = {
  data?: { id?: string; nextSubmissionId?: string | null; handoffFailed?: boolean };
  // 400 "already submitted" (the cron or an earlier request graded it).
  alreadySubmitted?: boolean;
  error?: string;
  // "submission_gone": the exam row was deleted (e.g. by an admin).
  code?: string;
  nextSubmissionId?: string | null;
};

// Device-side mirror of the attempt, so a refresh / crash / expired session
// never loses work the server didn't receive.
interface LocalBackup {
  answers: Record<string, string>;
  /** Per-question time of the last local change (ms epoch). */
  answeredAt: Record<string, number>;
  flagged: string[];
  crossedOut: Record<string, string[]>;
  /** Highlights/notes per question; restored like flags when newer than the server copy. */
  annotations?: Record<string, Record<string, { start: number; end: number; note?: string }[]>>;
  currentIndex: number;
  metaChangedAt: number;
  /** Build time of the newest payload the server confirmed. Changes after it never reached the server. */
  syncedAt: number;
  /** Stable per-device id + last write order sent, so the server can drop out-of-order saves. */
  clientId?: string;
  lastClientSeq?: number;
  /** Per-question flag/cross-out/highlight state the server last confirmed (questionMetaSnapshot). */
  metaBase?: Record<string, string>;
  /** attemptStartedAt when this backup was written. A different value means the attempt was reset. */
  attemptStartedAt?: string;
  /** Per-question time / visits / answer history (lib/question-activity). */
  activity?: ActivityMap;
}

// Per-question flag / cross-out / highlight state, serialized so two
// copies compare with ===. Keys are sorted: Postgres jsonb reorders them.
type QuestionMeta = { flagged: boolean; crossed: string[]; annos: Record<string, unknown> | null };
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const EMPTY_QUESTION_META = stableJson({ flagged: false, crossed: [], annos: null });
function questionMetaSnapshot(
  flagged: Iterable<string>,
  crossed: Record<string, Iterable<string>>,
  annos: Record<string, unknown>,
): Record<string, string> {
  const flaggedSet = new Set(flagged);
  const ids = new Set([...flaggedSet, ...Object.keys(crossed), ...Object.keys(annos)]);
  const out: Record<string, string> = {};
  for (const qid of ids) {
    const a = annos[qid];
    const meta: QuestionMeta = {
      flagged: flaggedSet.has(qid),
      crossed: [...(crossed[qid] ?? [])].sort(),
      annos: a && typeof a === "object" && Object.keys(a).length ? (a as Record<string, unknown>) : null,
    };
    const json = stableJson(meta);
    if (json !== EMPTY_QUESTION_META) out[qid] = json;
  }
  return out;
}
function snapshotFromMetadata(meta: Record<string, unknown> | null | undefined): Record<string, string> {
  const m = meta ?? {};
  const crossed: Record<string, string[]> = {};
  if (m.crossed_out && typeof m.crossed_out === "object") {
    for (const [qid, labels] of Object.entries(m.crossed_out as Record<string, unknown>)) {
      if (Array.isArray(labels)) crossed[qid] = labels.filter((l): l is string => typeof l === "string");
    }
  }
  return questionMetaSnapshot(
    Array.isArray(m.flagged) ? (m.flagged as unknown[]).filter((x): x is string => typeof x === "string") : [],
    crossed,
    m.annotations && typeof m.annotations === "object" ? (m.annotations as Record<string, unknown>) : {},
  );
}

function newClientId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function backupKey(submissionId: string) {
  return `sat-exam:attempt:${submissionId}`;
}

function readBackup(submissionId: string): LocalBackup | null {
  try {
    const raw = localStorage.getItem(backupKey(submissionId));
    return raw ? (JSON.parse(raw) as LocalBackup) : null;
  } catch {
    return null;
  }
}

// A save/submit only counts when the API answered with JSON. A signed-out
// request used to come back as a 200 HTML page and was taken as success.
function isJsonOk(res: Response) {
  return res.ok && (res.headers.get("content-type") ?? "").includes("application/json");
}

export default function TestTakingClient({
  testId,
  submissionId,
  attemptStartedAt,
  initialAnswers,
  initialMetadata,
  test,
  questions,
  timeRemainingSeconds,
  reportsEnabled = false,
  continueUrl,
  doneUrl,
  sectionLabel,
}: Props) {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  // Flags, crossed-out choices and position are restored from the
  // autosaved metadata so a refresh doesn't send the student back to Q1.
  const [currentIndex, setCurrentIndex] = useState(() => {
    const i = initialMetadata.current_index;
    return typeof i === "number" && i >= 0 && i < questions.length ? i : 0;
  });
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers);
  const [flagged, setFlagged] = useState<Set<string>>(
    () => new Set(Array.isArray(initialMetadata.flagged) ? (initialMetadata.flagged as string[]) : []),
  );
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tabSwitchCount, setTabSwitchCount] = useState(
    typeof initialMetadata.tab_switches === "number" ? initialMetadata.tab_switches : 0
  );
  const [tabSwitchBannerVisible, setTabSwitchBannerVisible] = useState(false);
  const [activeAid, setActiveAid] = useState<"desmos" | "formula" | null>(null);
  const hasAids = test.desmosEnabled || !!test.formulaSheetUrl;
  // Bluebook-style controls: toggleable timer, navigator overlay, per-
  // question crossed-out choices ("eliminate" tool).
  const [timerHidden, setTimerHidden] = useState(false);
  const [showNavigator, setShowNavigator] = useState(false);
  // "Report a problem" dialog open: exam shortcuts are paused meanwhile.
  const [reportOpen, setReportOpen] = useState(false);
  const [crossedOut, setCrossedOut] = useState<Record<string, Set<string>>>(() => {
    const raw = initialMetadata.crossed_out;
    const restored: Record<string, Set<string>> = {};
    if (raw && typeof raw === "object") {
      for (const [qid, labels] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(labels)) restored[qid] = new Set(labels as string[]);
      }
    }
    return restored;
  });
  const toggleCrossOut = useCallback((questionId: string, label: string) => {
    setCrossedOut((prev) => {
      const next = { ...prev };
      const set = new Set(next[questionId] ?? []);
      if (set.has(label)) set.delete(label);
      else set.add(label);
      next[questionId] = set;
      return next;
    });
  }, []);

  // Per-question highlight annotations, keyed by question id.
  // Restored from initialMetadata.annotations on resume; persisted via
  // the same auto-save channel as answers/tab_switches.
  type QuestionAnnos = Record<string, Record<string, { start: number; end: number; note?: string }[]>>;
  const initialAnnotations: QuestionAnnos =
    (initialMetadata.annotations as QuestionAnnos | undefined) ?? {};
  const [annotations, setAnnotations] = useState<QuestionAnnos>(initialAnnotations);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [sessionExpired, setSessionExpired] = useState(false);
  // The server says this exam no longer exists (an admin deleted it):
  // saving stops for good and a banner links back to the test page, where
  // a fresh exam can be started (D-20261111-1).
  const [examGone, setExamGone] = useState(false);
  const examGoneRef = useRef(false);
  function markExamGone() {
    examGoneRef.current = true;
    setExamGone(true);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
  }

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const tabSwitchRef = useRef(tabSwitchCount);
  tabSwitchRef.current = tabSwitchCount;
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const flaggedRef = useRef(flagged);
  flaggedRef.current = flagged;
  const crossedOutRef = useRef(crossedOut);
  crossedOutRef.current = crossedOut;
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;

  // Every local change bumps changeSeq; a confirmed save records the seq
  // it carried. There is unsaved work while changeSeq > savedSeq.
  const changeSeqRef = useRef(0);
  const savedSeqRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const saveRetryCountRef = useRef(0);
  const submittedRef = useRef(false);
  const answeredAtRef = useRef<Record<string, number>>({});
  const metaChangedAtRef = useRef(0);
  const syncedAtRef = useRef(0);
  const lastStampRef = useRef(0);
  // Flag / cross-out / highlight state the server holds as far as this
  // device knows; saves send only questions that differ from it.
  const metaBaseRef = useRef<Record<string, string> | null>(null);
  if (metaBaseRef.current === null) metaBaseRef.current = snapshotFromMetadata(initialMetadata);
  const [serverRemaining, setServerRemaining] = useState<{ seconds: number } | null>(null);
  const lastFlushedSeqRef = useRef(-1);
  // A keepalive flush can run alongside a save already in flight, and the
  // older request may reach the server last. Each request carries a
  // per-device, strictly increasing clientSeq; the server ignores one
  // older than the newest it has applied for this clientId.
  const clientIdRef = useRef<string | null>(null);
  const lastClientSeqRef = useRef(0);

  // Per-question activity for teacher analytics (lib/question-activity):
  // time on screen, visits, answers gone through. Refs only, so it never
  // re-renders the exam; it rides the saves that happen anyway.
  const activityRef = useRef<ActivityMap | null>(null);
  if (activityRef.current === null) {
    activityRef.current = parseActivity(
      initialMetadata.question_activity,
      new Set(questions.map((q) => q.id)),
    );
  }
  // The question on screen and when its current visible stretch began.
  const viewRef = useRef<{ qid: string; since: number | null } | null>(null);

  function closeActivitySpan() {
    const v = viewRef.current;
    if (v?.since == null) return;
    addTime(activityRef.current!, v.qid, performance.now() - v.since);
    v.since = null;
  }
  function openActivitySpan() {
    const v = viewRef.current;
    if (v && v.since == null && document.visibilityState === "visible") v.since = performance.now();
  }
  // What saves carry: the record so far plus the open stretch and the answer
  // now on screen (an SPR answer is otherwise only taken when leaving).
  function activitySnapshot(): ActivityMap {
    const snap = JSON.parse(JSON.stringify(activityRef.current ?? {})) as ActivityMap;
    const v = viewRef.current;
    if (v) {
      if (v.since != null) addTime(snap, v.qid, performance.now() - v.since);
      recordAnswer(snap, v.qid, answersRef.current[v.qid]);
    }
    return snap;
  }

  const saveUrl = `/api/student/submissions/${submissionId}`;

  // The save helpers below read state only through refs, so a closure
  // from any render behaves the same (event listeners registered once
  // and the keyboard handler's stale handleAnswer stay correct).
  function hasUnsavedChanges() {
    return changeSeqRef.current > savedSeqRef.current;
  }

  function buildMetadata(): Record<string, unknown> {
    const crossed: Record<string, string[]> = {};
    for (const [qid, labels] of Object.entries(crossedOutRef.current)) {
      if (labels.size > 0) crossed[qid] = [...labels];
    }
    // The PATCH route merges metadata, so only our own keys are sent.
    return {
      tab_switches: tabSwitchRef.current,
      annotations: annotationsRef.current,
      flagged: [...flaggedRef.current],
      crossed_out: crossed,
      current_index: currentIndexRef.current,
    };
  }

  // What saves send as metadata: flags / cross-outs / highlights go per
  // question in questionMetaDelta() instead (D-20261104-1).
  function serverMetadata(): Record<string, unknown> {
    return {
      tab_switches: tabSwitchRef.current,
      current_index: currentIndexRef.current,
      question_activity: activitySnapshot(),
    };
  }

  function currentQuestionMeta() {
    return questionMetaSnapshot(flaggedRef.current, crossedOutRef.current, annotationsRef.current);
  }

  function questionMetaDelta(): { delta: Record<string, QuestionMeta>; built: Record<string, string> } {
    const built = currentQuestionMeta();
    const base = metaBaseRef.current ?? {};
    const delta: Record<string, QuestionMeta> = {};
    for (const qid of new Set([...Object.keys(built), ...Object.keys(base)])) {
      const now = built[qid] ?? EMPTY_QUESTION_META;
      if (now !== (base[qid] ?? EMPTY_QUESTION_META)) delta[qid] = JSON.parse(now) as QuestionMeta;
    }
    return { delta, built };
  }

  // After a save: take the server's flags / cross-outs / highlights for
  // every question not changed here since the save was built, so this
  // device shows what the student did on another device.
  function adoptServerQuestionMeta(server: unknown, built: Record<string, string>) {
    if (!server || typeof server !== "object") {
      metaBaseRef.current = built;
      persistLocal();
      return;
    }
    const serverSnap = snapshotFromMetadata({
      flagged: (server as Record<string, unknown>).flagged,
      crossed_out: (server as Record<string, unknown>).crossed_out,
      annotations: (server as Record<string, unknown>).annotations,
    });
    metaBaseRef.current = serverSnap;
    const current = currentQuestionMeta();
    const validIds = new Set(questions.map((q) => q.id));
    const adopt: string[] = [];
    for (const qid of new Set([...Object.keys(current), ...Object.keys(serverSnap)])) {
      if (!validIds.has(qid)) continue;
      const now = current[qid] ?? EMPTY_QUESTION_META;
      if (now !== (built[qid] ?? EMPTY_QUESTION_META)) continue; // changed here since
      if (now !== (serverSnap[qid] ?? EMPTY_QUESTION_META)) adopt.push(qid);
    }
    if (adopt.length) applyQuestionMetaLocally(adopt, serverSnap);
    persistLocal();
  }

  function applyQuestionMetaLocally(qids: string[], source: Record<string, string>) {
    const nextFlagged = new Set(flaggedRef.current);
    const nextCrossed: Record<string, Set<string>> = { ...crossedOutRef.current };
    const nextAnnos: QuestionAnnos = { ...annotationsRef.current };
    for (const qid of qids) {
      const m = JSON.parse(source[qid] ?? EMPTY_QUESTION_META) as QuestionMeta;
      if (m.flagged) nextFlagged.add(qid);
      else nextFlagged.delete(qid);
      if (m.crossed.length) nextCrossed[qid] = new Set(m.crossed);
      else delete nextCrossed[qid];
      if (m.annos) nextAnnos[qid] = m.annos as QuestionAnnos[string];
      else delete nextAnnos[qid];
    }
    flaggedRef.current = nextFlagged;
    crossedOutRef.current = nextCrossed;
    annotationsRef.current = nextAnnos;
    setFlagged(nextFlagged);
    setCrossedOut(nextCrossed);
    setAnnotations(nextAnnos);
  }

  function persistLocal() {
    if (submittedRef.current) return;
    const meta = buildMetadata();
    const backup: LocalBackup = {
      answers: answersRef.current,
      answeredAt: answeredAtRef.current,
      flagged: meta.flagged as string[],
      crossedOut: meta.crossed_out as Record<string, string[]>,
      annotations: annotationsRef.current,
      currentIndex: currentIndexRef.current,
      metaChangedAt: metaChangedAtRef.current,
      syncedAt: syncedAtRef.current,
      clientId: clientIdRef.current ?? undefined,
      lastClientSeq: lastClientSeqRef.current,
      metaBase: metaBaseRef.current ?? undefined,
      attemptStartedAt,
      activity: activitySnapshot(),
    };
    try {
      localStorage.setItem(backupKey(submissionId), JSON.stringify(backup));
    } catch {
      // Storage full / disabled — the server copy is still the primary.
    }
  }

  // Change/save timestamps compared against syncedAt. Never goes
  // backwards: when the computer's clock is corrected back (NTP sync),
  // a raw Date.now() put new answers "before" the last save, so they
  // were left out of every save and markSynced refused the acks — a
  // save loop that lost the answers (D-20261103-1).
  function stamp() {
    lastStampRef.current = Math.max(Date.now(), lastStampRef.current + 1);
    return lastStampRef.current;
  }

  // Acks can arrive out of order (keepalive flush vs. a save in flight);
  // an older one must never move the synced markers backwards.
  function markSynced(seq: number, builtAt: number) {
    if (seq < savedSeqRef.current || builtAt < syncedAtRef.current) return false;
    savedSeqRef.current = seq;
    syncedAtRef.current = builtAt;
    persistLocal();
    return true;
  }

  // Only the answers changed on this device since the last confirmed save.
  // Sending the whole map let a device that had been offline (or left
  // open) write its old answers back over ones the student changed on
  // another device in the meantime (D-20261102-1).
  function answerDelta(): Record<string, string | null> {
    const since = syncedAtRef.current;
    const out: Record<string, string | null> = {};
    for (const [qid, at] of Object.entries(answeredAtRef.current)) {
      if (at >= since) out[qid] = answersRef.current[qid] ?? null;
    }
    return out;
  }

  // After a save, take the server's copy for every question not changed
  // here since that save was built, so this device shows answers the
  // student picked on another device instead of its own older ones.
  function adoptServerAnswers(server: unknown, builtAt: number) {
    if (!server || typeof server !== "object") return;
    const serverAnswers = server as Record<string, string>;
    const validIds = new Set(questions.map((q) => q.id));
    const next = { ...answersRef.current };
    let changed = false;
    for (const qid of new Set([...Object.keys(next), ...Object.keys(serverAnswers)])) {
      if (!validIds.has(qid) || (answeredAtRef.current[qid] ?? 0) >= builtAt) continue;
      const value = serverAnswers[qid];
      if (typeof value === "string" && value !== next[qid]) {
        next[qid] = value;
        changed = true;
      } else if (value === undefined && qid in next) {
        delete next[qid];
        changed = true;
      }
    }
    if (!changed) return;
    answersRef.current = next;
    setAnswers(next);
    persistLocal();
  }

  // Clock-based so it keeps increasing across reloads on this device;
  // the +1 covers a clock that stepped backwards. Persisted right away.
  function nextSaveOrder() {
    if (!clientIdRef.current) clientIdRef.current = newClientId();
    lastClientSeqRef.current = Math.max(Date.now(), lastClientSeqRef.current + 1);
    persistLocal();
    return { clientId: clientIdRef.current, clientSeq: lastClientSeqRef.current };
  }

  // On 401, ask Clerk for a fresh session token (the short-lived JWT may
  // just not have been refreshed — laptop sleep, background tab, clock
  // skew) and retry once with it.
  async function fetchWithAuthRetry(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    if (res.status !== 401) return res;
    let token: string | null = null;
    try {
      token = await getTokenRef.current({ skipCache: true });
    } catch {
      token = null;
    }
    if (!token) return res;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  }

  async function saveNow() {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    // An in-flight save re-checks for newer changes when it finishes; a
    // submit in flight carries the answers itself (failure reschedules).
    if (submittedRef.current || examGoneRef.current || saveInFlightRef.current || submitInFlightRef.current) return;
    if (!hasUnsavedChanges()) {
      setSaveStatus("saved");
      return;
    }
    const seq = changeSeqRef.current;
    const builtAt = stamp();
    saveInFlightRef.current = true;
    setSaveStatus("saving");
    let ok = false;
    let retryable = true;
    let gone = false;
    let serverAnswers: unknown = undefined;
    let serverQuestionMeta: unknown = undefined;
    let remainingSeconds: unknown = undefined;
    const { delta: questionMeta, built: metaBuilt } = questionMetaDelta();
    try {
      const res = await fetchWithAuthRetry(saveUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Only changed answers; answersMode "merge" overlays them on the
        // server's copy.
        body: JSON.stringify({
          answers: answerDelta(),
          answersMode: "merge",
          metadata: serverMetadata(),
          questionMeta,
          ...nextSaveOrder(),
        }),
      });
      ok = isJsonOk(res);
      if (ok) {
        const body = await res.json().catch(() => null);
        serverAnswers = body?.answers;
        serverQuestionMeta = body?.questionMeta;
        remainingSeconds = body?.remainingSeconds;
      }
      if (res.status === 401) setSessionExpired(true);
      // 409 time_up (past the deadline grace) and 400 "not in progress"
      // never succeed on retry; 409 save_conflict is transient and does.
      if (res.status === 400 || res.status === 409) {
        const err = await res.json().catch(() => null);
        if (res.status === 400 || err?.error === "time_up") retryable = false;
      }
      if (res.status === 404) {
        const err = await res.json().catch(() => null);
        if (err?.code === "submission_gone") gone = true;
      }
    } catch {
      // Network failure — retried below.
    }
    saveInFlightRef.current = false;
    if (submittedRef.current) return;
    if (gone) {
      markExamGone();
      return;
    }
    if (ok) {
      if (markSynced(seq, builtAt)) {
        adoptServerAnswers(serverAnswers, builtAt);
        adoptServerQuestionMeta(serverQuestionMeta, metaBuilt);
      }
      if (typeof remainingSeconds === "number") setServerRemaining({ seconds: remainingSeconds });
      saveRetryCountRef.current = 0;
      setSessionExpired(false);
      if (hasUnsavedChanges()) scheduleSave(0);
      else setSaveStatus("saved");
      return;
    }
    if (!retryable) {
      setSaveStatus("closed");
      return;
    }
    setSaveStatus("error");
    const delay = Math.min(SAVE_RETRY_MAX_MS, 1000 * 2 ** saveRetryCountRef.current);
    saveRetryCountRef.current += 1;
    scheduleSave(delay);
  }

  function scheduleSave(delay: number = AUTO_SAVE_DEBOUNCE_MS) {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      void saveNow();
    }, delay);
  }

  function markChanged(delay: number) {
    changeSeqRef.current += 1;
    persistLocal();
    scheduleSave(delay);
  }

  // Fire-and-forget save that survives the page going away (refresh,
  // close, tab hidden, unmount). keepalive lets the request outlive the
  // document; the local backup covers the case where it still fails.
  function flushWithKeepalive() {
    if (submittedRef.current || examGoneRef.current) return;
    const order = nextSaveOrder();
    const seq = changeSeqRef.current;
    lastFlushedSeqRef.current = seq;
    const builtAt = stamp();
    const metadata = serverMetadata();
    const answers = answerDelta();
    const { delta: questionMeta, built: metaBuilt } = questionMetaDelta();
    let metaSent = true;
    let body = JSON.stringify({ answers, answersMode: "merge", metadata, questionMeta, ...order });
    if (new TextEncoder().encode(body).length > KEEPALIVE_MAX_BYTES) {
      // Highlights are the only unbounded field; drop the per-question
      // changes rather than the answers. The regular save sends them when
      // the page survives, and the device backup keeps them otherwise.
      metaSent = false;
      body = JSON.stringify({ answers, answersMode: "merge", metadata, ...order });
      // Still unsaved after this flush's ack, so the next save sends them.
      changeSeqRef.current += 1;
    }
    try {
      fetch(saveUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      })
        .then((res) => {
          if (!isJsonOk(res) || submittedRef.current) return;
          if (markSynced(seq, builtAt) && metaSent) adoptServerQuestionMeta(null, metaBuilt);
          if (!hasUnsavedChanges() && !saveInFlightRef.current) setSaveStatus("saved");
        })
        .catch(() => {});
    } catch {
      // keepalive rejected (body too large) — local backup still holds it.
    }
  }

  // Restore from the device backup on resume: union of server + local
  // answers, with local winning for questions changed after the last
  // confirmed save (those never reached the server).
  useEffect(() => {
    let local = readBackup(submissionId);
    // An admin reset keeps the submission id but starts the attempt over.
    // The device copy belongs to the old attempt: restoring it brought the
    // wiped answers, flags and position back and re-saved them (D-20261106-2).
    if (local?.attemptStartedAt && local.attemptStartedAt !== attemptStartedAt) {
      try {
        localStorage.removeItem(backupKey(submissionId));
      } catch {}
      local = null;
    }
    // Keep this device's save-order identity across reloads, so a keepalive
    // from the page we just left can't overwrite this page's newer saves.
    clientIdRef.current = local?.clientId ?? newClientId();
    lastClientSeqRef.current = local?.lastClientSeq ?? 0;
    if (!local) return;
    const validIds = new Set(questions.map((q) => q.id));
    if (local.activity) {
      activityRef.current = mergeActivity(activityRef.current ?? {}, parseActivity(local.activity, validIds));
    }
    const syncedAt = typeof local.syncedAt === "number" ? local.syncedAt : 0;
    syncedAtRef.current = syncedAt;
    const localAnswers = local.answers ?? {};
    const answeredAt = local.answeredAt ?? {};
    answeredAtRef.current = { ...answeredAt };
    lastStampRef.current = Math.max(
      syncedAt,
      local.metaChangedAt ?? 0,
      ...Object.values(answeredAt).filter((v): v is number => typeof v === "number"),
    );
    const merged = { ...answersRef.current };
    let recovered = false;
    for (const [qid, value] of Object.entries(localAnswers)) {
      if (!validIds.has(qid) || typeof value !== "string") continue;
      // Only answers that never reached the server. A saved answer the
      // server no longer has was erased on another device; putting the
      // device copy back resurrected it (D-20261103-2).
      const unsynced = (answeredAt[qid] ?? 0) > syncedAt;
      if (unsynced && merged[qid] !== value) {
        merged[qid] = value;
        recovered = true;
      }
    }
    // Erased here but the erase never reached the server.
    for (const [qid, at] of Object.entries(answeredAt)) {
      if (validIds.has(qid) && at > syncedAt && !(qid in localAnswers) && qid in merged) {
        delete merged[qid];
        recovered = true;
      }
    }
    if (recovered) {
      answersRef.current = merged;
      setAnswers(merged);
    }
    if (local.metaBase && typeof local.metaBase === "object") {
      // Only questions whose flag / cross-out / highlight changed on this
      // device and never reached the server go back on top of the server
      // copy; the rest of the device copy may be stale (D-20261104-1).
      const localSnap = snapshotFromMetadata({
        flagged: local.flagged,
        crossed_out: local.crossedOut,
        annotations: local.annotations,
      });
      const pending = [...new Set([...Object.keys(localSnap), ...Object.keys(local.metaBase)])].filter(
        (qid) =>
          validIds.has(qid) &&
          (localSnap[qid] ?? EMPTY_QUESTION_META) !== (local.metaBase![qid] ?? EMPTY_QUESTION_META),
      );
      if (pending.length) {
        metaChangedAtRef.current = stamp();
        applyQuestionMetaLocally(pending, localSnap);
      }
    }
    if ((local.metaChangedAt ?? 0) > syncedAt) {
      metaChangedAtRef.current = local.metaChangedAt;
      if (
        typeof local.currentIndex === "number" &&
        local.currentIndex >= 0 &&
        local.currentIndex < questions.length
      ) {
        setCurrentIndex(local.currentIndex);
      }
    }
    if (!local.metaBase && (local.metaChangedAt ?? 0) > syncedAt) {
      if (Array.isArray(local.flagged)) {
        setFlagged(new Set(local.flagged.filter((id) => validIds.has(id))));
      }
      if (local.crossedOut && typeof local.crossedOut === "object") {
        const restored: Record<string, Set<string>> = {};
        for (const [qid, labels] of Object.entries(local.crossedOut)) {
          if (validIds.has(qid) && Array.isArray(labels)) restored[qid] = new Set(labels);
        }
        setCrossedOut(restored);
      }
      // A highlight made just before a refresh may only have reached the
      // server via the old page's keepalive, after this page was rendered
      // from the older copy. The device copy is newer, so it wins.
      if (local.annotations && typeof local.annotations === "object") {
        const restoredAnnos: QuestionAnnos = {};
        for (const [qid, a] of Object.entries(local.annotations)) {
          if (validIds.has(qid) && a && typeof a === "object") restoredAnnos[qid] = a as QuestionAnnos[string];
        }
        annotationsRef.current = restoredAnnos;
        setAnnotations(restoredAnnos);
      }
    }
    if (recovered) markChanged(0);
    // Mount-only: restores once per submission (the page keys by id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flag / cross-out / position / annotation / tab-switch changes ride the
  // same autosave. Skips the initial render (nothing changed yet).
  const metaMountedRef = useRef(false);
  useEffect(() => {
    if (!metaMountedRef.current) {
      metaMountedRef.current = true;
      return;
    }
    metaChangedAtRef.current = stamp();
    markChanged(AUTO_SAVE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagged, crossedOut, currentIndex, annotations, tabSwitchCount]);

  // Activity: arriving at a question counts a visit (the first one after
  // load doesn't, unless it's new: that's a reload); leaving it records the
  // answer it holds and whether the first pass left it blank.
  useEffect(() => {
    const qid = questions[currentIndex]?.id;
    if (!qid) return;
    const prev = viewRef.current;
    if (prev?.qid === qid) return;
    if (prev) {
      closeActivitySpan();
      recordLeave(activityRef.current!, prev.qid, answersRef.current[prev.qid]);
    }
    recordArrive(activityRef.current!, qid, prev !== null);
    viewRef.current = { qid, since: null };
    openActivitySpan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex]);

  // Time only counts while the page is visible.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "hidden") closeActivitySpan();
      else openActivitySpan();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab visibility tracking. Hiding the tab is also the last reliable
  // moment on mobile (the page may be killed without pagehide), so flush.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        tabSwitchRef.current += 1;
        setTabSwitchCount(tabSwitchRef.current);
        setTabSwitchBannerVisible(true);
        changeSeqRef.current += 1;
        flushWithKeepalive();
      }
    }
    function handlePageHide() {
      // visibilitychange usually already flushed this exact state; a second
      // copy would eat into the shared 64KB keepalive budget.
      if (hasUnsavedChanges() && lastFlushedSeqRef.current !== changeSeqRef.current) {
        flushWithKeepalive();
      }
    }
    // Back online / back on the page (e.g. after signing in again in
    // another tab): retry right away instead of waiting out the backoff.
    function handleRetryNow() {
      if (!hasUnsavedChanges()) return;
      saveRetryCountRef.current = 0;
      void saveNow();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("online", handleRetryNow);
    window.addEventListener("focus", handleRetryNow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("online", handleRetryNow);
      window.removeEventListener("focus", handleRetryNow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live progress keepalive: while the page is open and nothing needs
  // saving, tell the server the student is still here, so teachers can
  // tell "reading a long passage" from "laptop died". Fire-and-forget: it
  // touches no exam state, is skipped while a save or submit is in flight
  // or work is unsaved (that save stamps the same thing), and stops for
  // good once the attempt is submitted, gone or closed.
  const keepaliveStoppedRef = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        if (
          keepaliveStoppedRef.current ||
          submittedRef.current ||
          examGoneRef.current ||
          submitInFlightRef.current ||
          saveInFlightRef.current ||
          hasUnsavedChanges()
        ) {
          return;
        }
        fetchWithAuthRetry(saveUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keepalive: true }),
        })
          .then((res) => {
            // Submitted / deleted / time up: nothing left to keep alive.
            if (res.status === 400 || res.status === 404 || res.status === 409) keepaliveStoppedRef.current = true;
          })
          .catch(() => {});
      } catch {
        // Never let the keepalive disturb the exam.
      }
    }, KEEPALIVE_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss tab-switch banner after 6 seconds.
  useEffect(() => {
    if (!tabSwitchBannerVisible) return;
    const t = setTimeout(() => setTabSwitchBannerVisible(false), 6000);
    return () => clearTimeout(t);
  }, [tabSwitchBannerVisible]);

  // Flush pending work on unmount instead of dropping it.
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (hasUnsavedChanges()) flushWithKeepalive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts — Bluebook-style: A/B/C/D selects the choice,
  // N/Right/Enter advances, P/Left goes back, F toggles flag, Esc
  // closes the navigator. We ignore key events when the focus is
  // inside an input/textarea (so SPR typing isn't intercepted), and
  // every shortcut while an overlay is open (the submit dialog handles
  // its own keys) so nothing changes behind it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (showSubmitModal) return;
      if (reportOpen || target?.closest("[data-report-dialog]")) return;
      if (showNavigator) {
        if (e.key === "Escape") setShowNavigator(false);
        return;
      }
      // Enter / Space on a focused control (a choice, Submit, Next…)
      // must activate that control, not advance the question.
      if (
        (e.key === "Enter" || e.key === " ") &&
        target?.closest("button, a[href], [role='button'], [role='radio']")
      ) {
        return;
      }
      const q = questions[currentIndex];
      if (!q) return;
      const isMcq = q.question_type === "Multiple Choice";

      if (isMcq && /^[a-dA-D]$/.test(e.key)) {
        const label = e.key.toUpperCase();
        if (q.choices.some((c) => c.label === label)) {
          handleAnswer(q.id, label);
          e.preventDefault();
        }
        return;
      }
      if (e.key === "n" || e.key === "N" || e.key === "ArrowRight" || e.key === "Enter") {
        if (currentIndex < questions.length - 1) {
          setCurrentIndex((i) => Math.min(questions.length - 1, i + 1));
          e.preventDefault();
        }
        return;
      }
      if (e.key === "p" || e.key === "P" || e.key === "ArrowLeft") {
        if (currentIndex > 0) {
          setCurrentIndex((i) => Math.max(0, i - 1));
          e.preventDefault();
        }
        return;
      }
      if (e.key === "f" || e.key === "F") {
        toggleFlag(q.id);
        e.preventDefault();
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // handleAnswer is defined later in the component but reading the
    // latest closure value through state is sufficient for shortcut
    // intent — the answer is committed via setAnswers anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, questions, showNavigator, showSubmitModal, reportOpen]);

  function handleAnswer(questionId: string, answer: string) {
    const next = { ...answersRef.current, [questionId]: answer };
    answersRef.current = next;
    answeredAtRef.current = { ...answeredAtRef.current, [questionId]: stamp() };
    setAnswers(next);
    // A choice click saves right away; SPR typing is debounced.
    const isMcq = questions.find((q) => q.id === questionId)?.question_type === "Multiple Choice";
    // Each choice click is an answer the student went through; typed SPR
    // answers are taken when the student leaves the question.
    if (isMcq) recordAnswer(activityRef.current!, questionId, answer);
    markChanged(isMcq ? 0 : AUTO_SAVE_DEBOUNCE_MS);
  }

  function toggleFlag(questionId: string) {
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  }

  const submitInFlightRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // One submit attempt with a hard timeout. A fetch with no timeout can
  // hang forever on a flaky connection, leaving the student staring at
  // "Submitting…" with no way forward. The body is read inside the same
  // timeout: a connection that stalls after the headers used to hang
  // res.json() for minutes although the submit had already landed.
  const submitControllerRef = useRef<AbortController | null>(null);
  async function postSubmit(): Promise<{ res: Response; payload: SubmitPayload | null }> {
    const controller = new AbortController();
    submitControllerRef.current = controller;
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    try {
      const res = await fetchWithAuthRetry(`/api/student/submissions/${submissionId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: answerDelta(),
          answersMode: "merge",
          metadata: serverMetadata(),
          questionMeta: questionMetaDelta().delta,
        }),
        signal: controller.signal,
      });
      const payload =
        isJsonOk(res) || (res.status >= 400 && res.status < 500)
          ? await res.json().catch((e) => {
              if (controller.signal.aborted) throw e; // stalled → retry
              return null;
            })
          : null;
      return { res, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  // Every automatic page change goes through here. The Desmos panel is the
  // full desmos.com app in an iframe: once a graph has expressions it asks
  // "leave this graph? unsaved work will be lost" on unload, so the browser
  // showed "Leave site?" and blocked the move to Module 2 / the result page
  // after a submit that had already landed (support b1cf70bf). Unmount the
  // iframe first so nothing can hold the navigation.
  function navigateAway(url: string) {
    flushSync(() => setActiveAid(null));
    document.querySelectorAll("iframe").forEach((f) => f.remove());
    window.location.assign(url);
  }

  // Where to go once this module is submitted: Module 1 → the take page
  // (it opens Module 2), otherwise the result page.
  function leaveAfterSubmit() {
    navigateAway(
      test.moduleLabel === "Module 1"
        ? continueUrl ?? `/student/tests/${testId}/take`
        : doneUrl ?? `/student/tests/${testId}/result?submission=${submissionId}`,
    );
  }

  // Did the submit land server-side (and, for Module 1, is Module 2 ready)?
  // null = couldn't tell (offline / signed out).
  async function checkSubmitLanded(): Promise<boolean | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchWithAuthRetry(`${saveUrl}?status=1`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isJsonOk(res)) return null;
      const body = (await res.json()) as { data?: { ready?: boolean } };
      return Boolean(body?.data?.ready);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Submit watchdog. Whatever stalls — a lost response, a navigation that
  // never starts — once the server has the submit, the student moves on.
  // isSubmitting stays true after a successful submit (the page is
  // navigating away), so this also retries a navigation that didn't happen.
  const [submitStuck, setSubmitStuck] = useState(false);
  const [stuckNote, setStuckNote] = useState<string | null>(null);
  useEffect(() => {
    if (!isSubmitting) {
      setSubmitStuck(false);
      setStuckNote(null);
      return;
    }
    const startedAt = performance.now();
    let stopped = false;
    let checking = false;
    const tick = async () => {
      if (stopped || checking) return;
      if (performance.now() - startedAt >= SUBMIT_STUCK_MS) setSubmitStuck(true);
      checking = true;
      const landed = await checkSubmitLanded();
      checking = false;
      if (!stopped && landed) {
        submittedRef.current = true;
        leaveAfterSubmit();
      }
    };
    const id = setInterval(tick, SUBMIT_POLL_MS);
    // Back online: check right away instead of waiting for the next tick.
    window.addEventListener("online", tick);
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener("online", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitting]);

  // "Continue" on the stuck banner: go on if the submit landed; if the
  // server says it didn't, cut the hung attempt short so a retry goes out.
  async function handleStuckContinue() {
    setStuckNote("Checking…");
    const landed = await checkSubmitLanded();
    if (landed) {
      submittedRef.current = true;
      leaveAfterSubmit();
      return;
    }
    if (landed === null) {
      setStuckNote("Can't reach the server — check your Wi-Fi. Your answers are kept on this device.");
      return;
    }
    setStuckNote("Not submitted yet — trying again…");
    submitControllerRef.current?.abort();
  }

  // Submit failed at the network / server level after every immediate
  // retry: keep trying in the background (answers stay on this device and
  // ride along with each attempt) with a visible status and a manual
  // "Try submitting again" button. Coming back online retries at once.
  const submitRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submitRetryCountRef = useRef(0);
  const [submitRetrying, setSubmitRetrying] = useState(false);
  const handleSubmitRef = useRef<() => void>(() => {});
  function clearSubmitRetry() {
    if (submitRetryTimerRef.current) clearTimeout(submitRetryTimerRef.current);
    submitRetryTimerRef.current = null;
    setSubmitRetrying(false);
  }
  function scheduleSubmitRetry() {
    if (submittedRef.current) return;
    if (submitRetryTimerRef.current) clearTimeout(submitRetryTimerRef.current);
    if (submitRetryCountRef.current >= SUBMIT_BACKGROUND_RETRY_LIMIT) {
      setSubmitRetrying(false);
      setSubmitError(
        "We still can't submit your test. Your answers are kept on this device — don't close this page, and contact your teacher.",
      );
      return;
    }
    const delay = Math.min(SUBMIT_BACKGROUND_RETRY_MAX_MS, 5000 * 2 ** submitRetryCountRef.current);
    submitRetryCountRef.current += 1;
    setSubmitRetrying(true);
    submitRetryTimerRef.current = setTimeout(() => {
      submitRetryTimerRef.current = null;
      handleSubmitRef.current();
    }, delay);
  }
  function retrySubmitNow() {
    clearSubmitRetry();
    handleSubmitRef.current();
  }
  useEffect(() => {
    const onOnline = () => {
      if (submitRetryTimerRef.current) retrySubmitNow();
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      if (submitRetryTimerRef.current) clearTimeout(submitRetryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit() {
    // Timer expiry + a manual click (or a double click) used to fire two
    // submits; the loser got 400 "already submitted" and silently reset
    // the UI while the winner's navigation could be lost.
    if (submitInFlightRef.current) return;
    clearSubmitRetry();
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    // Inline-save the latest answers + metadata into the submit
    // request itself instead of doing a separate PATCH first. One
    // round trip instead of two — was the dominant cause of the
    // ~1-minute submit lag students reported.
    try {
      let res: Response | null = null;
      let payload: SubmitPayload | null = null;
      for (let attempt = 0; attempt < SUBMIT_MAX_ATTEMPTS; attempt++) {
        try {
          ({ res, payload } = await postSubmit());
          if (res.ok || res.status < 500) break;
        } catch {
          res = null; // network error / timeout → retry
          payload = null;
        }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      if (!res) {
        // Every attempt failed at the network level. Don't auto-reload —
        // with an expired timer that would loop (load → expire → submit →
        // fail → reload). Leave the Submit button live; once the connection
        // is back, a retry either succeeds or gets the 400 below.
        throw new Error("network");
      }
      if (res.status === 401) {
        // Never navigate away here: a reload would bounce to sign-in and
        // drop anything not yet on the server. Stay, keep the local copy.
        submitInFlightRef.current = false;
        setIsSubmitting(false);
        setAutoSubmitting(false);
        setShowSubmitModal(false);
        setSessionExpired(true);
        // Submit cleared the pending autosave timer; resume retrying.
        if (hasUnsavedChanges()) scheduleSave(0);
        setSubmitError("Your test has not been submitted yet. Sign in again, then press Submit.");
        return;
      }
      if (res.status === 400 && payload) {
        // "Submission already submitted" — an earlier request of ours
        // landed but its response never reached us, or the time-up cron
        // graded this module first. Either way the module is done: carry
        // on like a successful submit. Module 1 → the take page, which
        // opens Module 2 (the server already created it, or the take page
        // creates it); Module 2 → the result page.
        submittedRef.current = true;
        clearSubmitRetry();
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        leaveAfterSubmit();
        return;
      }
      if (isJsonOk(res) && payload?.data?.id) {
        submittedRef.current = true;
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        try {
          localStorage.removeItem(backupKey(submissionId));
        } catch {
          // ignore
        }
        // Adaptive flow: the submit endpoint creates the Module 2 row
        // and returns its id. We use a HARD browser navigation
        // (window.location.assign) instead of router.push because
        // router.push to the same URL doesn't reliably remount the
        // take client — Module 1's answer state was leaking into
        // Module 2 (DB showed Module 2 rows with 44 answers = 22+22).
        // A real navigation guarantees a fresh React tree, fresh
        // state, fresh server fetch, and a fresh timer.
        // Module 1 always continues on the take page, even when the
        // server couldn't create Module 2 (handoffFailed / no next id):
        // the take page retries the handoff, and falls back to the test
        // page's "Continue to Module 2". Never the Module 1 result page —
        // that was a dead end mid-test.
        clearSubmitRetry();
        leaveAfterSubmit();
      } else {
        submitInFlightRef.current = false;
        setIsSubmitting(false);
        setAutoSubmitting(false);
        setShowSubmitModal(false);
        if (hasUnsavedChanges()) scheduleSave(0);
        // Server error / unexpected reply: retry in the background.
        // Other 4xx (e.g. 404) won't fix themselves.
        const transient = res.status >= 500 || (res.ok && !isJsonOk(res));
        if (res.status === 404 && payload?.code === "submission_gone") {
          markExamGone();
          setSubmitError(
            "Couldn't submit — this exam was removed by your teacher or an admin, so there's nothing left to submit. Go back to the test page to start it again.",
          );
        } else if (transient) {
          setSubmitError(`Not submitted yet — the server had a problem. Retrying automatically… ${savedNote()}`);
          scheduleSubmitRetry();
        } else {
          // Permanent (404 / 422 …): retrying won't help.
          setSubmitError(
            `Couldn't submit${payload?.error ? ` (${payload.error})` : ""}. Please contact your teacher. ${savedNote()}`,
          );
        }
      }
    } catch {
      // Network failure after all retries.
      submitInFlightRef.current = false;
      setIsSubmitting(false);
      setAutoSubmitting(false);
      setShowSubmitModal(false);
      setSubmitError(`Not submitted yet — can't reach the server. Retrying automatically; check your Wi-Fi. ${savedNote()}`);
      if (hasUnsavedChanges()) scheduleSave(0);
      scheduleSubmitRetry();
    }
  }
  handleSubmitRef.current = () => void handleSubmit();

  // Only claim "saved" when the last autosave actually covered every change.
  function savedNote() {
    return hasUnsavedChanges()
      ? "Your latest answers are kept on this device — don't close this page."
      : "Your answers are saved.";
  }

  const [autoSubmitting, setAutoSubmitting] = useState(false);

  // Before auto-submitting at 0:00, ask the server how much time is left:
  // an admin may have added time while this page was open, and submitting
  // on the old clock took it away from the student (D-20261104-3). If the
  // check fails, submit as before (the server deadline still applies).
  async function fetchServerRemaining(): Promise<number | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${saveUrl}?status=1`, { cache: "no-store", signal: controller.signal });
      clearTimeout(timer);
      if (!isJsonOk(res)) return null;
      const body = await res.json().catch(() => null);
      return typeof body?.data?.remainingSeconds === "number" ? body.data.remainingSeconds : null;
    } catch {
      return null;
    }
  }

  const expiryCheckRef = useRef(false);
  async function handleTimerExpire() {
    if (expiryCheckRef.current || submittedRef.current) return;
    expiryCheckRef.current = true;
    const remaining = await fetchServerRemaining();
    expiryCheckRef.current = false;
    if (remaining != null && remaining > 2) {
      setServerRemaining({ seconds: remaining });
      if (remaining > 90) setTimeWarningVisible(false);
      return;
    }
    setAutoSubmitting(true);
    handleSubmit();
  }

  // Until React hydrates, the server-rendered page looks interactive but
  // ignores clicks (seconds on a slow connection) — cover it meanwhile.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // 5- and 1-minute warnings: visible banner + screen-reader announcement
  // (the live region stays mounted so the text change is announced).
  const [timeWarning, setTimeWarning] = useState<string | null>(null);
  const [timeWarningVisible, setTimeWarningVisible] = useState(false);
  function handleTimerWarning(minutesLeft: 5 | 1) {
    // Pick up time an admin added, even if the student isn't answering.
    void fetchServerRemaining().then((seconds) => {
      if (seconds == null) return;
      setServerRemaining({ seconds });
      if (seconds > minutesLeft * 60 + 30) setTimeWarningVisible(false);
    });
    setTimeWarning(minutesLeft === 1 ? "1 minute remaining in this module." : "5 minutes remaining in this module.");
    setTimeWarningVisible(true);
  }

  const currentQuestion = questions[currentIndex];
  const answeredCount = questions.filter((q) => answers[q.id] && answers[q.id].trim() !== "").length;
  const questionIds = questions.map((q) => q.id);

  return (
    // fixed inset-0 makes the test UI a full-viewport overlay that covers
    // the student dashboard chrome (nav + sidebar + padding). Rendered in
    // normal flow it sat inside <main overflow-y-auto p-6>, so its full-
    // height column overflowed the main area and pushed the Back/Next
    // footer below the fold — students had to scroll to reach it. As a
    // fixed overlay it owns the whole screen: top bar and footer pin to the
    // real viewport edges and only the question body scrolls. Bonus: a
    // distraction-free, Bluebook-style test mode.
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-cream">
      {submitError && (
        <div
          role="alert"
          className="shrink-0 bg-status-error text-white text-sm px-4 py-2 flex flex-wrap items-center justify-center gap-3 text-center font-medium"
        >
          <span>{submitError}</span>
          {!isSubmitting && !examGone && (
            <button
              type="button"
              onClick={retrySubmitNow}
              className="whitespace-nowrap rounded-md bg-white text-status-error px-3 py-1 font-semibold hover:bg-white/90"
            >
              {submitRetrying ? "Retry now" : "Try submitting again"}
            </button>
          )}
        </div>
      )}
      {examGone && (
        <div
          role="alert"
          className="shrink-0 bg-status-error text-white text-sm px-4 py-3 flex flex-wrap items-center justify-center gap-3 text-center font-medium"
        >
          <span>
            This exam was removed by your teacher or an admin, so your answers here are no longer being saved.
          </span>
          <a
            href={`/student/tests/${testId}`}
            className="whitespace-nowrap rounded-md bg-white text-status-error px-3 py-1 font-semibold hover:bg-white/90"
          >
            Back to the test page
          </a>
        </div>
      )}
      {sessionExpired && (
        <div
          role="alert"
          className="shrink-0 bg-status-error text-white text-sm px-4 py-2 text-center font-medium"
        >
          Your session expired — sign in again; your answers are kept on this device.{" "}
          {/* New tab so this page (and its unsaved answers) stays open.
              Saving resumes automatically once signed in. */}
          <a href="/sign-in" target="_blank" rel="noopener" className="underline">
            Sign in (opens a new tab)
          </a>
        </div>
      )}
      {autoSubmitting && (
        <div
          role="alert"
          aria-live="assertive"
          className="shrink-0 bg-status-warning text-white text-sm px-4 py-2 text-center font-medium"
        >
          ⏱ Time&rsquo;s up — submitting your test automatically. Please wait…
        </div>
      )}
      {isSubmitting && submitStuck && (
        // Above the submit modal (z-[80]) so it's reachable while the
        // modal's "Submitting…" button is showing.
        <div
          role="alert"
          className="fixed inset-x-0 top-0 z-[80] bg-warm-coral-dark text-white text-sm px-4 py-3 flex flex-wrap items-center justify-center gap-3 shadow-lg"
        >
          <span>{stuckNote ?? "Still submitting — this is taking longer than usual."}</span>
          <button
            type="button"
            onClick={handleStuckContinue}
            className="whitespace-nowrap rounded-md bg-white text-warm-coral-dark px-3 py-1.5 font-semibold hover:bg-white/90"
          >
            {test.moduleLabel === "Module 1" ? "Continue to Module 2" : "Continue"}
          </button>
        </div>
      )}
      {tabSwitchBannerVisible && (
        <div
          role="status"
          aria-live="polite"
          className="shrink-0 bg-warm-amber/15 border-b border-warm-amber/30 text-warm-amber-dark text-sm px-4 py-2 text-center"
        >
          Tab switch recorded ({tabSwitchCount}). Stay on this tab during the test.
        </div>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {timeWarning ?? ""}
      </div>
      {timeWarning && timeWarningVisible && (
        <div className="shrink-0 bg-status-warning/15 border-b border-status-warning/30 text-status-warning text-sm px-4 py-2 flex items-center justify-center gap-3 font-medium">
          <span>{timeWarning}</span>
          <button
            onClick={() => setTimeWarningVisible(false)}
            className="p-1 rounded hover:bg-status-warning/15"
            aria-label="Dismiss time warning"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {/* Bluebook-style top bar: title + module on the left, timer
          centered (with hide toggle), tool buttons + Submit on the
          right. Mirrors College Board's digital SAT chrome so students
          who've used the real Bluebook app feel at home. */}
      {/* Below md the bar is two rows (title on top, timer + tools
          below) so nothing overlaps the timer on a phone. */}
      <div className="shrink-0 border-b border-divider px-4 sm:px-6 py-2.5 grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 bg-cream">
        {/* Left: title + module pill */}
        <div className="col-span-2 md:col-span-1 flex items-center gap-2 min-w-0">
          <div className="font-semibold text-charcoal truncate text-sm md:text-base">{test.name}</div>
          {sectionLabel && (
            <span className="shrink-0 px-2 py-0.5 rounded-full bg-charcoal/5 text-charcoal text-xs font-medium">
              {sectionLabel}
            </span>
          )}
          {test.moduleLabel && (
            <span className="shrink-0 px-2 py-0.5 rounded-full bg-warm-coral/10 text-warm-coral-text text-xs font-medium">
              {test.moduleLabel}
            </span>
          )}
          <span
            role="status"
            aria-live="polite"
            className={clsx(
              "shrink-0 text-xs",
              examGone || saveStatus === "error" || saveStatus === "closed" ? "text-status-error font-medium" : "text-soft-mute",
            )}
          >
            {examGone
              ? "Not saved — exam removed"
              : saveStatus === "saving"
                ? "Saving…"
                : saveStatus === "error"
                  ? sessionExpired
                    ? "Not saved — sign in again"
                    : "Not saved — retrying"
                  : saveStatus === "closed"
                    ? "Not saved — press Submit"
                    : "Saved"}
          </span>
        </div>

        {/* Center: timer w/ hide toggle. Bluebook shows the timer big
            in the middle and gives students a single click to obscure
            it for the "I don't want to look at the clock right now"
            case — useful for anxious test-takers. */}
        <div className="flex items-center justify-start md:justify-center gap-2 min-w-0">
          {test.isUntimed ? (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-light-bg text-mid-gray font-medium text-sm whitespace-nowrap"
              title="This test has no time limit"
            >
              <InfinityIcon size={14} /> No time limit
            </div>
          ) : (
            // Keep TestTimer mounted at all times and toggle visibility
            // with CSS. Unmounting it on hide (the old behaviour) threw
            // away its internal countdown state, so unhiding remounted it
            // from the stale page-load prop and the clock jumped back to
            // the full limit. The interval keeps running while hidden, so
            // time still elapses correctly.
            <>
              <div className={clsx("flex items-center gap-2", timerHidden && "hidden")}>
                <TestTimer
                  initialSeconds={timeRemainingSeconds}
                  onExpire={handleTimerExpire}
                  onWarning={handleTimerWarning}
                  serverRemaining={serverRemaining}
                />
                <button
                  onClick={() => setTimerHidden(true)}
                  className="text-soft-mute hover:text-charcoal min-w-8 min-h-8 inline-flex items-center justify-center rounded-md"
                  aria-label="Hide timer"
                  title="Hide timer"
                >
                  <EyeOff size={14} />
                </button>
              </div>
              {timerHidden && (
                <button
                  onClick={() => setTimerHidden(false)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-light-bg text-mid-gray hover:text-charcoal text-sm font-medium whitespace-nowrap"
                >
                  <Eye size={14} /> Show Timer
                </button>
              )}
            </>
          )}
        </div>

        {/* Right: tool buttons + Submit */}
        <div className="flex items-center justify-end gap-2 shrink-0">
          {test.desmosEnabled && (
            <button
              onClick={() => setActiveAid((a) => (a === "desmos" ? null : "desmos"))}
              className={clsx(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors",
                activeAid === "desmos"
                  ? "bg-warm-coral text-white"
                  : "bg-warm-coral/10 text-warm-coral-text hover:bg-warm-coral/15",
              )}
              title="Desmos calculator"
              aria-label="Calculator"
              aria-pressed={activeAid === "desmos"}
            >
              <Calculator size={15} aria-hidden="true" /> <span className="hidden lg:inline">Calculator</span>
            </button>
          )}
          {test.formulaSheetUrl && (
            <button
              onClick={() => setActiveAid((a) => (a === "formula" ? null : "formula"))}
              className={clsx(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors",
                activeAid === "formula"
                  ? "bg-warm-coral text-white"
                  : "bg-warm-coral/10 text-warm-coral-text hover:bg-warm-coral/15",
              )}
              title="Formula reference sheet"
              aria-label="Reference"
              aria-pressed={activeAid === "formula"}
            >
              <BookOpen size={15} aria-hidden="true" /> <span className="hidden lg:inline">Reference</span>
            </button>
          )}
          <button
            onClick={() => setShowSubmitModal(true)}
            className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors whitespace-nowrap"
          >
            Submit
          </button>
        </div>
      </div>

      {/* Main + optional Math aids side panel.
          The aid panel is a true split (not a modal) so the student can
          work the calculator and read the question side-by-side, like
          the digital SAT. We size it 40% on wide screens; on narrow ones
          it is a bottom sheet (~55% height) under the still-visible question. */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="max-w-5xl mx-auto p-4 sm:p-6">
          {currentQuestion ? (
            <div className="space-y-6">
              {/* Question header: number on the left, "Mark for Review"
                  on the right (Bluebook places the flag toggle inline
                  with the question header, not below the choices). */}
              <div className="flex items-center justify-between border-b border-divider pb-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-charcoal text-cream text-sm font-bold">
                    {currentIndex + 1}
                  </span>
                  <span className="text-soft-mute text-sm">of {questions.length}</span>
                </div>
                <div className="flex items-center gap-1">
                {reportsEnabled && (
                  <ReportProblemButton
                    key={currentQuestion.id}
                    testId={testId}
                    submissionId={submissionId}
                    questionId={currentQuestion.id}
                    displayNumber={currentIndex + 1}
                    context="taking"
                    onOpenChange={setReportOpen}
                  />
                )}
                <button
                  onClick={() => toggleFlag(currentQuestion.id)}
                  className={clsx(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
                    flagged.has(currentQuestion.id)
                      ? "bg-status-warning/15 text-status-warning hover:bg-status-warning/25"
                      : "text-mid-gray hover:text-warm-coral-text hover:bg-warm-coral/10",
                  )}
                  aria-pressed={flagged.has(currentQuestion.id)}
                >
                  <Flag
                    size={15}
                    className={flagged.has(currentQuestion.id) ? "fill-status-warning/40" : ""}
                  />
                  {flagged.has(currentQuestion.id) ? "Marked for Review" : "Mark for Review"}
                </button>
                </div>
              </div>

              <QuestionErrorBoundary
                key={currentQuestion.id}
                questionNumber={currentIndex + 1}
              >
                <QuestionRenderer
                  question={currentQuestion}
                  selectedAnswer={answers[currentQuestion.id] ?? ""}
                  onAnswer={(ans) => handleAnswer(currentQuestion.id, ans)}
                  questionIndex={currentIndex}
                  totalQuestions={questions.length}
                  sprDirections
                  annotationsEnabled={test.annotationsEnabled}
                  annotations={annotations[currentQuestion.id] ?? {}}
                  crossedOut={crossedOut[currentQuestion.id] ?? new Set()}
                  onToggleCrossOut={(label) => toggleCrossOut(currentQuestion.id, label)}
                  onAnnotationsChange={(next) => {
                    setAnnotations((prev) => {
                      const merged = { ...prev };
                      if (Object.keys(next).length === 0) {
                        delete merged[currentQuestion.id];
                      } else {
                        merged[currentQuestion.id] = next;
                      }
                      annotationsRef.current = merged;
                      scheduleSave();
                      return merged;
                    });
                  }}
                />
              </QuestionErrorBoundary>
            </div>
          ) : (
            <div className="py-16 text-center text-soft-mute">No questions found.</div>
          )}
        </div>
        </div>

        {activeAid && hasAids && (
          <div className="flex flex-col shrink-0 h-[55%] md:h-auto w-full md:w-[42%] lg:w-[40%] border-t md:border-t-0 md:border-l border-divider bg-surface min-h-0 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] md:shadow-none">
            <div className="shrink-0 flex items-center justify-between border-b border-divider px-3 py-2">
              <div className="flex items-center gap-1.5 text-charcoal text-sm font-semibold">
                {activeAid === "desmos" ? (
                  <><Calculator size={14} className="text-warm-coral-text" /> Desmos calculator</>
                ) : (
                  <><BookOpen size={14} className="text-warm-coral-text" /> Formula reference</>
                )}
              </div>
              <button
                onClick={() => setActiveAid(null)}
                className="text-soft-mute hover:text-charcoal p-1"
                aria-label="Close panel"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto bg-light-bg">
              {activeAid === "desmos" ? (
                <iframe
                  src="https://www.desmos.com/calculator"
                  title="Desmos calculator"
                  className="w-full h-full border-0"
                  allow="clipboard-read; clipboard-write"
                />
              ) : test.formulaSheetUrl ? (
                <img
                  src={
                    // Vercel Blob URLs are private by default and require an
                    // auth header to fetch. Route them through the existing
                    // /api/blob-image proxy so <img> works without exposing
                    // the read-token to the client.
                    test.formulaSheetUrl.includes(".blob.vercel-storage.com")
                      ? `/api/blob-image?u=${encodeURIComponent(test.formulaSheetUrl)}`
                      : test.formulaSheetUrl
                  }
                  alt="Formula reference sheet"
                  className="w-full h-auto"
                />
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* Bluebook bottom bar: Back / center pill that opens the
          navigator overlay / Next. Centered "Question N of M" mirrors
          the official app and gives students an obvious tap target to
          jump anywhere in the section. */}
      <div className="shrink-0 border-t border-divider px-6 py-3 grid grid-cols-3 items-center gap-3 bg-cream">
        <div className="flex justify-start">
          <button
            onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-charcoal text-cream hover:bg-charcoal/90 transition-colors text-sm font-semibold disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} /> Back
          </button>
        </div>

        <div className="flex justify-center">
          <button
            onClick={() => setShowNavigator((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-charcoal/20 bg-surface text-charcoal hover:border-charcoal/40 text-sm font-semibold"
            aria-expanded={showNavigator}
          >
            <Grid3x3 size={14} />
            Question {currentIndex + 1} of {questions.length}
            <span className="text-soft-mute text-xs ml-1">({answeredCount} done)</span>
          </button>
        </div>

        <div className="flex justify-end">
          {currentIndex === questions.length - 1 ? (
            <button
              onClick={() => setShowSubmitModal(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-warm-coral text-white hover:bg-warm-coral-dark transition-colors text-sm font-semibold"
            >
              Review &amp; Submit <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-charcoal text-cream hover:bg-charcoal/90 transition-colors text-sm font-semibold"
            >
              Next <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Question navigator overlay — toggled from the bottom-bar pill.
          Bluebook shows this as a small popover above the pill; we use
          a centered modal-style sheet for clearer focus. */}
      {showNavigator && (
        <div
          className="fixed inset-0 z-40 bg-black/30 flex items-end sm:items-center justify-center"
          onClick={() => setShowNavigator(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Question Navigator"
            className="bg-cream rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl shadow-2xl max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-divider">
              <h2 className="text-charcoal font-semibold">Question Navigator</h2>
              <button
                onClick={() => setShowNavigator(false)}
                className="text-soft-mute hover:text-charcoal p-1"
                aria-label="Close navigator"
              >
                <X size={16} />
              </button>
            </div>
            <QuestionNavigator
              totalQuestions={questions.length}
              currentIndex={currentIndex}
              answers={answers}
              questionIds={questionIds}
              flagged={flagged}
              onNavigate={(i) => {
                setCurrentIndex(i);
                setShowNavigator(false);
              }}
              onToggleFlag={toggleFlag}
            />
            <div className="px-5 py-3 border-t border-divider flex justify-end">
              <button
                onClick={() => {
                  setShowNavigator(false);
                  setShowSubmitModal(true);
                }}
                className="px-4 py-2 rounded-xl bg-warm-coral text-white text-sm font-semibold hover:bg-warm-coral-dark"
              >
                Go to Review Page
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit modal — Bluebook-style "Check Your Work" review page
          when grid data is supplied (default for in-test submit). */}
      {showSubmitModal && (
        <SubmitModal
          totalQuestions={questions.length}
          answeredCount={answeredCount}
          isSubmitting={isSubmitting}
          onConfirm={handleSubmit}
          onCancel={() => setShowSubmitModal(false)}
          questionIds={questionIds}
          answers={answers}
          flagged={flagged}
          onJumpTo={(i) => {
            setCurrentIndex(i);
            setShowSubmitModal(false);
          }}
        />
      )}

      {!hydrated && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-cream/60"
          role="status"
          aria-live="polite"
        >
          <span className="px-4 py-2 rounded-full bg-surface border border-divider shadow-sm text-sm font-medium text-charcoal">
            Loading…
          </span>
        </div>
      )}
    </div>
  );
}
