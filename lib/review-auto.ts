// lib/review-auto.ts
//
// Let the system decide what it can (Premier 2026-11-07 "Review queue v2",
// retest 2026-11-08). Runs over Needs Review and Draft questions:
//
//   1. Key, no answer key in the PDF: when the code-checked solve and an
//      independent second solve agree with EACH OTHER on another answer than
//      the stored (single AI solve) key, that answer becomes the key —
//      lib/key-change.ts applyKeyCorrection writes and checks the explanation
//      in the same write and records "applied by the system …" (key source:
//      "Solved by AI · checked by code"). Uses the checks already stored in
//      the verify-ai-key note: no new AI solve. Never when:
//        - real (non-QA) students answered it: the person confirms the
//          rescore on the card's preview (it stays in "Answer key disputed"),
//        - the question is in a live test (applyKeyCorrection refuseLive),
//        - the question text looks broken (the solves may answer another
//          question, [Test #13] L Test 1 Math M2 Q21),
//        - lib/verify-ai-key.ts autoKeyDecision says no (module has a real
//          key, R&W, the solves disagree, the stored key's plug-back holds…).
//   2. Nothing left to decide (lib/review-queue.ts groupRow → "ready"): every
//      check passes, so it is approved — reviewed_by stays null (system),
//      with a "System-approved" history note. "Re-review before approve"
//      notes from automatic repairs are settled by the same checks.
//   3. Draft (no owner): approved when the checks pass, otherwise moved into
//      the Review Queue (Needs Review) with its reason.
// Never approves a question whose module is in a live test (that would add
// it to the test students are taking): it stays "ready" for a person.
// Auto-approval pauses while the spot-check error rate is too high
// (lib/spot-check.ts). Never touches a [live-fix] row (a person confirms it)
// and never lowers an Approved status.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isQaEmail } from "@/lib/qa";
import { clearReviewTags } from "@/lib/key-doubt";
import { LIVE_FIX_TAG, liveQuestionIds } from "@/lib/live-questions";
import { applyKeyCorrection, type ExplainFn } from "@/lib/key-change";
import { DECIDE_SELECT, decideBlockers } from "@/lib/review-decide";
import { dropSettledNotes, groupRow, noteSegments, STEM_BROKEN, SYSTEM_APPROVED_PREFIX } from "@/lib/review-queue";
import { autoKeyDecision, checksFromSummary, contentHash, moduleHasRealKey, noteStemHash, parseAiKeyDisagreeNote } from "@/lib/verify-ai-key";
import { spotCheckStats } from "@/lib/spot-check";
import type { AutoFixRow } from "@/lib/explanation-autofix";

export { SYSTEM_APPROVED_PREFIX };
export const MOVED_FROM_DRAFT_PREFIX = "Moved from Draft to the review queue";
export const SYSTEM_KEY_SOURCE = "the system (code solve + second solve agree, no answer key in the PDF)";

export function systemApprovedNote(why: string, date: string): string {
  return `${SYSTEM_APPROVED_PREFIX}: ${why} (${date})`;
}

type Row = AutoFixRow & { module_id: string | null };

export type SettlePlan =
  | { action: "approve"; notes: string | null; why: string }
  | { action: "set_key"; key: string; reason: string }
  | { action: "to_queue"; reason: string }
  | { action: "none"; reason: string };

/**
 * The checks stored in the row's LATEST verify-ai-key disagreement note
 * (null = none). `current` is false when the note has no content fingerprint
 * (older notes) or was computed for another version of the question text /
 * choices: such evidence is shown, never acted on automatically.
 */
export function storedKeyChecks(r: Pick<AutoFixRow, "parsing_notes" | "question_text" | "choices">) {
  const segs = noteSegments(r.parsing_notes);
  for (let i = segs.length - 1; i >= 0; i--) {
    const d = parseAiKeyDisagreeNote(segs[i]);
    if (!d?.detail) continue;
    const checks = checksFromSummary(d.detail);
    if (!checks) return null;
    const hash = noteStemHash(segs[i]);
    return { checks, disagreement: d, current: hash !== null && hash === contentHash(r) };
  }
  return null;
}

/** Pure: what the system does with this row. */
export function planSettle(r: Row, ctx: { moduleHasRealKey: boolean; paused: boolean; live?: boolean }): SettlePlan {
  if ((r.parsing_notes ?? "").startsWith(LIVE_FIX_TAG)) return { action: "none", reason: "live-test change: a person confirms it" };
  const g = groupRow(r);
  if (r.parsing_status === "Needs Review" && (g.primary === "key_dispute" || g.primary === "ai_key")) {
    const stored = storedKeyChecks(r);
    if (stored) {
      if (g.reasons.some((x) => STEM_BROKEN.test(x.text))) return { action: "none", reason: "the question text looks broken: fix it before the key" };
      if (!stored.current) return { action: "none", reason: "the solves were made on an older (or unrecorded) version of the question text — a person decides, or re-run the check" };
      if (ctx.paused) return { action: "none", reason: "automatic decisions paused: the spot-check error rate is too high" };
      const d = autoKeyDecision(r, stored.checks, { moduleHasRealKey: ctx.moduleHasRealKey, live: false });
      if (d.action === "set_key" && d.key) return { action: "set_key", key: d.key, reason: d.reason };
      return { action: "none", reason: d.reason };
    }
  }
  const settled = { ...r, parsing_notes: dropSettledNotes(r).notes } as Row;
  const blockers = decideBlockers(settled);
  if (blockers.length === 0) {
    if (ctx.paused) return { action: "none", reason: "auto-approval paused: the spot-check error rate is too high" };
    // Approving adds it to a test students are taking: a person decides (same rule as lib/verify-ai-key.ts).
    if (ctx.live) {
      const reason = "every check passes, but its module is in a live test — approving adds it to the running test, so a person decides";
      // A Draft has no owner: it goes into the queue (as "ready") instead of staying in Draft.
      return r.parsing_status === "Draft" ? { action: "to_queue", reason } : { action: "none", reason };
    }
    return { action: "approve", notes: settled.parsing_notes, why: r.parsing_status === "Draft" ? "was in Draft; every automatic check passed" : "every automatic check passed" };
  }
  if (r.parsing_status === "Draft") return { action: "to_queue", reason: blockers[0].replace(/^note: /, "") };
  return { action: "none", reason: blockers[0] };
}

/** Real (non-QA) students with a graded answer on each question. */
export async function realStudentsAnswered(db: SupabaseClient, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const bySub = new Map<string, Set<string>>();
  for (let i = 0; i < ids.length; i += 100) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("answer_records")
        .select("id, question_id, submission_id")
        .in("question_id", ids.slice(i, i + 100))
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) {
        const s = bySub.get(r.submission_id as string) ?? new Set<string>();
        s.add(r.question_id as string);
        bySub.set(r.submission_id as string, s);
      }
      if (!data || data.length < 1000) break;
    }
  }
  // Fail closed: a lookup error throws, and an attempt whose student can't
  // be resolved counts as a real student (never rescored silently).
  const subs = [...bySub.keys()];
  const studentOf = new Map<string, string | null>();
  for (let i = 0; i < subs.length; i += 100) {
    const { data, error } = await db.from("submissions").select("id, student_id").in("id", subs.slice(i, i + 100));
    if (error) throw new Error(`submissions lookup failed: ${error.message}`);
    for (const s of data ?? []) studentOf.set(s.id as string, (s.student_id as string | null) ?? null);
  }
  const studentIds = [...new Set([...studentOf.values()].filter((x): x is string => !!x))];
  const qa = new Set<string>();
  for (let i = 0; i < studentIds.length; i += 100) {
    const { data, error } = await db.from("users").select("id, email").in("id", studentIds.slice(i, i + 100));
    if (error) throw new Error(`users lookup failed: ${error.message}`);
    for (const u of data ?? []) if (isQaEmail(u.email as string | null)) qa.add(u.id as string);
  }
  const perQ = new Map<string, Set<string>>();
  for (const [sub, qs] of bySub) {
    const st = studentOf.get(sub) ?? null;
    if (st && qa.has(st)) continue;
    // Unknown submission / no student id: counted as its own real student.
    const who = st ?? `unknown:${sub}`;
    for (const q of qs) perQ.set(q, (perQ.get(q) ?? new Set()).add(who));
  }
  for (const [q, s] of perQ) out.set(q, s.size);
  return out;
}

export interface SettleOutcome {
  id: string;
  module_id: string | null;
  number: number | null;
  status_before: string | null;
  action: "approved" | "key_set" | "key_set_waiting" | "to_queue" | "needs_person" | "none" | "error";
  detail: string;
  /** Planned only (dry run). */
  planned?: boolean;
}

export interface SettleOptions {
  apply: boolean;
  /** Only these modules. */
  moduleIds?: string[];
  /** Key changes write an explanation (one AI call each): at most this many per run. */
  maxKeyChanges?: number;
  /** Stop starting new key changes after this time (ms epoch). */
  deadline?: number;
  explain?: ExplainFn;
}

async function loadRows(db: SupabaseClient, moduleIds?: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from("questions").select(DECIDE_SELECT).in("parsing_status", ["Needs Review", "Draft"]).order("id").range(from, from + 999);
    if (moduleIds?.length) q = q.in("module_id", moduleIds);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Which modules have a real (PDF) answer key. */
async function modulesWithRealKey(db: SupabaseClient, moduleIds: string[]): Promise<Set<string>> {
  const rows: { module_id: string; official_answer: string | null }[] = [];
  for (let i = 0; i < moduleIds.length; i += 50) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("questions")
        .select("id, module_id, official_answer")
        .in("module_id", moduleIds.slice(i, i + 50))
        .not("official_answer", "is", null)
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as typeof rows));
      if (!data || data.length < 1000) break;
    }
  }
  const out = new Set<string>();
  for (const id of moduleIds) if (moduleHasRealKey(rows.filter((r) => r.module_id === id))) out.add(id);
  return out;
}

async function approveRow(db: SupabaseClient, r: Row, notes: string | null, why: string, recheckLive = false): Promise<boolean | "live"> {
  // Re-checked right before the write: a test may have gone live since the plan.
  if (recheckLive) {
    const nowLive = await liveQuestionIds(db, [r.id]).catch(() => new Set([r.id]));
    if (nowLive.has(r.id)) return "live";
  }
  const date = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from("questions")
    .update({
      parsing_status: "Approved",
      parsing_notes: [clearReviewTags(notes), systemApprovedNote(why, date)].filter(Boolean).join("; "),
      reviewed_by: null,
      reviewed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", r.id)
    .eq("updated_at", r.updated_at as string)
    .in("parsing_status", ["Needs Review", "Draft"])
    .select("id");
  return !error && !!data?.length;
}

/** Run the system's decisions (dry run unless opts.apply). */
export async function settleQueue(db: SupabaseClient, opts: SettleOptions): Promise<{ outcomes: SettleOutcome[]; paused: boolean }> {
  const rows = await loadRows(db, opts.moduleIds);
  const stats = await spotCheckStats(db);
  const modules = [...new Set(rows.map((r) => r.module_id).filter((x): x is string => !!x))];
  const realKey = await modulesWithRealKey(db, modules);
  // A failed lookup counts every row as live (nothing is approved).
  const live = await liveQuestionIds(db, rows.map((r) => r.id)).catch(() => new Set(rows.map((r) => r.id)));
  const plans = rows.map((r) => ({ r, plan: planSettle(r, { moduleHasRealKey: realKey.has(r.module_id ?? ""), paused: stats.paused, live: live.has(r.id) }) }));
  const keyIds = plans.filter((p) => p.plan.action === "set_key").map((p) => p.r.id);
  // Fail closed: if who answered can't be checked, no key is changed automatically.
  let students: Map<string, number> | null = new Map();
  if (keyIds.length) students = await realStudentsAnswered(db, keyIds).catch(() => null);
  const outcomes: SettleOutcome[] = [];
  let keyChanges = 0;
  // Live re-check right before approving, batched: one lookup for the next
  // 25 approvals, refreshed at least every 30 s. A failed lookup = live.
  const approveIds = plans.filter((p) => p.plan.action === "approve").map((p) => p.r.id);
  let liveNow = new Set<string>();
  let liveFor = new Set<string>();
  let liveAt = 0;
  const isLiveNow = async (id: string): Promise<boolean> => {
    if (!liveFor.has(id) || Date.now() - liveAt > 30_000) {
      const i = approveIds.indexOf(id);
      const batch = approveIds.slice(Math.max(0, i), Math.max(0, i) + 25);
      if (!batch.includes(id)) batch.push(id);
      liveNow = await liveQuestionIds(db, batch).catch(() => new Set(batch));
      liveFor = new Set(batch);
      liveAt = Date.now();
    }
    return liveNow.has(id);
  };
  for (const { r, plan } of plans) {
    const base = { id: r.id, module_id: r.module_id, number: r.original_question_number, status_before: r.parsing_status ?? null };
    try {
      if (plan.action === "none") {
        outcomes.push({ ...base, action: "none", detail: plan.reason });
        continue;
      }
      if (plan.action === "approve") {
        if (!opts.apply) outcomes.push({ ...base, action: "approved", detail: plan.why, planned: true });
        else if (opts.deadline && Date.now() > opts.deadline) {
          outcomes.push({ ...base, action: "none", detail: "left for the next run (time limit)" });
        } else {
          const res = (await isLiveNow(r.id)) ? "live" : await approveRow(db, r, plan.notes, plan.why);
          outcomes.push(res === "live" ? { ...base, action: "none", detail: "its module went live since the check — a person decides" } : { ...base, action: res ? "approved" : "error", detail: plan.why });
        }
        continue;
      }
      if (plan.action === "to_queue") {
        if (opts.apply) {
          const notes = [r.parsing_notes, `${MOVED_FROM_DRAFT_PREFIX} (${new Date().toISOString().slice(0, 10)})`].filter(Boolean).join("; ");
          const { data } = await db
            .from("questions")
            .update({ parsing_status: "Needs Review", parsing_notes: notes, updated_at: new Date().toISOString() })
            .eq("id", r.id)
            .eq("parsing_status", "Draft")
            .eq("updated_at", r.updated_at as string)
            .select("id");
          outcomes.push({ ...base, action: data?.length ? "to_queue" : "error", detail: plan.reason });
        } else outcomes.push({ ...base, action: "to_queue", detail: plan.reason, planned: true });
        continue;
      }
      // set_key
      if (students === null) {
        outcomes.push({ ...base, action: "needs_person", detail: `${r.correct_answer} → ${plan.key}: couldn't check who answered it — a person decides` });
        continue;
      }
      const n = students.get(r.id) ?? 0;
      if (n > 0) {
        outcomes.push({ ...base, action: "needs_person", detail: `${r.correct_answer} → ${plan.key}: ${plan.reason}, but ${n} student${n === 1 ? "" : "s"} answered it — a person confirms the rescore` });
        continue;
      }
      // The cap applies to the preview too, so it shows what a run really does.
      if ((opts.maxKeyChanges !== undefined && keyChanges >= opts.maxKeyChanges) || (opts.deadline && Date.now() > opts.deadline)) {
        outcomes.push({ ...base, action: "none", detail: `${r.correct_answer} → ${plan.key}: left for the next run (limit)` });
        continue;
      }
      keyChanges++;
      if (!opts.apply) {
        outcomes.push({ ...base, action: "key_set", detail: `${r.correct_answer} → ${plan.key}: ${plan.reason}`, planned: true });
        continue;
      }
      const res = await applyKeyCorrection(db, {
        id: r.id,
        correct_answer: plan.key,
        expectedKey: r.correct_answer ?? null,
        expectedUpdatedAt: r.updated_at ?? null,
        // Nobody real answered it (checked above): only QA attempts, if any, are rescored.
        rescore: true,
        source: SYSTEM_KEY_SOURCE,
        refuseLive: true,
        explain: opts.explain,
      });
      if (!res.ok) {
        outcomes.push({ ...base, action: "error", detail: res.error });
        continue;
      }
      const detail = `${r.correct_answer} → ${plan.key}: ${plan.reason}; explanation ${res.explanation?.outcome ?? "?"}${res.explanation?.reason ? ` (${res.explanation.reason})` : ""}`;
      if (!res.explanationOk) {
        outcomes.push({ ...base, action: "key_set_waiting", detail: `${detail} — the explanation needs a person` });
        continue;
      }
      // Approve when nothing else blocks.
      const { data: fresh } = await db.from("questions").select(DECIDE_SELECT).eq("id", r.id).maybeSingle();
      const f = fresh as unknown as Row | null;
      if (f && f.parsing_status !== "Approved") {
        const after = planSettle(f, { moduleHasRealKey: false, paused: stats.paused, live: live.has(f.id) });
        if (after.action === "approve" && (await approveRow(db, f, after.notes, "key set by the system (two solves agree); every automatic check passed", true)) === true) {
          outcomes.push({ ...base, action: "key_set", detail: `${detail}; approved` });
          continue;
        }
        outcomes.push({ ...base, action: "key_set_waiting", detail: `${detail}; still waiting: ${after.action === "approve" ? "approve failed" : after.reason}` });
        continue;
      }
      outcomes.push({ ...base, action: "key_set", detail });
    } catch (e) {
      outcomes.push({ ...base, action: "error", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return { outcomes, paused: stats.paused };
}
