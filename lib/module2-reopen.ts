// lib/module2-reopen.ts
//
// Admin "Reopen Module 2…" (ticket 969e0414). Puts a graded Module 2 back
// into exactly the state of a fresh, unopened Module 2 handoff
// (lib/module2-handoff ensureModule2): In Progress, no answers, no
// metadata.module_2_started_at (its timer starts when the student presses
// Start), score cleared. Module 1 is not touched, so its answers and
// score are kept.
//
// Safety:
// - Same row, same module_id / adaptive_track: an adaptive attempt keeps
//   its easy / hard track (the handoff is not re-run).
// - started_at = now is the new handoff time, which is what the cron's
//   unopened-Module-2 rule measures from (lib/finalize-stale): with a due
//   date that has passed, the student gets the full past-due window from
//   now; with no due date it stays open. It is never closed on the next
//   tick.
// - Only the student's latest attempt (an older one would jump ahead of a
//   newer attempt in every "latest attempt" view), only while Module 1 is
//   graded, never a full-length SAT row (its break / Math section / attempt
//   close don't fit a reopened module: use Manage submissions there).
// - The status flip is conditional (still the graded status we read), so a
//   double click or two admins can't both reopen it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { bumpAnswersVersion } from "@/lib/grade-submission";
import { isModule2Track, resetSubmissionMetadata } from "@/lib/student-exam";
import { isFullLengthRow } from "@/lib/full-length-attempt";

export const REOPEN_SUBMISSION_COLUMNS =
  "id, test_id, student_id, status, session_id, adaptive_track, module_id, metadata, attempt_number, " +
  "answers, submitted_at, score, correct_count, total_questions, percentage, scaled_score, scaled_section, time_spent_seconds, started_at";

/** The graded columns the reopen overwrites (restored if it can't finish). */
const GRADED_COLUMNS = [
  "status", "answers", "metadata", "submitted_at", "score", "correct_count", "total_questions",
  "percentage", "scaled_score", "scaled_section", "time_spent_seconds", "started_at",
] as const;

export interface ReopenRow {
  id: string;
  test_id: string;
  student_id: string;
  status: string;
  session_id: string | null;
  adaptive_track: string | null;
  module_id: string | null;
  metadata: unknown;
  attempt_number: number | null;
}

export type ReopenRefusal =
  | "not_found"
  | "not_module_2"
  | "not_graded"
  | "full_length"
  | "module_1_not_graded"
  | "newer_attempt"
  | "changed"
  | "records_failed";

export type ReopenResult =
  | { ok: true; submissionId: string; track: string }
  | { ok: false; reason: ReopenRefusal; error: string; status: number };

const REFUSAL: Record<ReopenRefusal, { error: string; status: number }> = {
  not_found: { error: "Submission not found", status: 404 },
  not_module_2: { error: "Only a Module 2 can be reopened", status: 400 },
  not_graded: { error: "This Module 2 is not submitted, so there is nothing to reopen", status: 409 },
  full_length: {
    error: "Full-length SAT modules can't be reopened here. Use Manage submissions to reset the module.",
    status: 400,
  },
  module_1_not_graded: { error: "Module 1 of this attempt isn't submitted", status: 409 },
  newer_attempt: { error: "The student has a newer attempt on this test; only the latest attempt can be reopened", status: 409 },
  changed: { error: "This submission changed in the meantime. Refresh and try again.", status: 409 },
  records_failed: { error: "Couldn't clear the old Module 2 answers, so nothing was changed. Try again.", status: 500 },
};

function refuse(reason: ReopenRefusal): ReopenResult {
  return { ok: false, reason, ...REFUSAL[reason] };
}

/**
 * Metadata of the reopened row: what an admin reset keeps (extended time,
 * full-length keys) plus the device, with answers_version bumped so an
 * autosave / keepalive that read the graded row can't land on the new one.
 * Everything else (auto_closed_unopened, module_2_started_at, flags,
 * highlights, activity, created_after_due) is dropped, as on a fresh handoff.
 */
export function reopenModule2Metadata(old: unknown, nowIso: string): Record<string, unknown> {
  const meta = (old && typeof old === "object" ? old : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...resetSubmissionMetadata(meta) };
  if (meta.device !== undefined) out.device = meta.device;
  const versioned = bumpAnswersVersion({ ...out, answers_version: meta.answers_version });
  return { ...versioned, module_2_reopened_at: nowIso };
}

/** Why this row can't be reopened (pure part of the checks), or null. */
export function reopenRowRefusal(row: ReopenRow | null): ReopenRefusal | null {
  if (!row) return "not_found";
  if (!isModule2Track(row.adaptive_track)) return "not_module_2";
  if (row.status !== "Submitted" && row.status !== "Late") return "not_graded";
  if (isFullLengthRow(row)) return "full_length";
  return null;
}

export async function reopenModule2(
  db: SupabaseClient,
  submissionId: string,
  now = new Date(),
): Promise<ReopenResult> {
  const { data, error } = await db
    .from("submissions")
    .select(REOPEN_SUBMISSION_COLUMNS)
    .eq("id", submissionId)
    .maybeSingle();
  if (error) throw new Error(`load submission: ${error.message}`);
  const row = (data as ReopenRow | null) ?? null;
  const pre = reopenRowRefusal(row);
  if (pre || !row) return refuse(pre ?? "not_found");

  // Module 1 of the same session must be graded.
  if (!row.session_id) return refuse("module_1_not_graded");
  const { data: session, error: sErr } = await db
    .from("submissions")
    .select("id, status, adaptive_track")
    .eq("session_id", row.session_id)
    .eq("student_id", row.student_id);
  if (sErr) throw new Error(`load session: ${sErr.message}`);
  const m1 = ((session ?? []) as { id: string; status: string; adaptive_track: string | null }[]).find(
    (r) => r.adaptive_track === "module_1",
  );
  if (!m1 || (m1.status !== "Submitted" && m1.status !== "Late")) return refuse("module_1_not_graded");

  // Only the latest attempt.
  const attempt = row.attempt_number ?? 1;
  const { data: newer, error: nErr } = await db
    .from("submissions")
    .select("attempt_number")
    .eq("test_id", row.test_id)
    .eq("student_id", row.student_id);
  if (nErr) throw new Error(`load attempts: ${nErr.message}`);
  const hasNewer = ((newer ?? []) as { attempt_number: number | null }[]).some((r) => (r.attempt_number ?? 1) > attempt);
  if (hasNewer) return refuse("newer_attempt");

  const nowIso = now.toISOString();
  const { data: claimed, error: upErr } = await db
    .from("submissions")
    .update({
      status: "In Progress",
      answers: {},
      metadata: reopenModule2Metadata(row.metadata, nowIso),
      submitted_at: null,
      // NOT NULL columns (defaults 0), as in the admin reset.
      score: 0,
      correct_count: 0,
      total_questions: 0,
      percentage: 0,
      scaled_score: null,
      scaled_section: null,
      time_spent_seconds: 0,
      // The new handoff time (cron rule for an unopened Module 2).
      started_at: nowIso,
    })
    .eq("id", row.id)
    .eq("status", row.status)
    .select("id");
  if (upErr) throw new Error(`reopen: ${upErr.message}`);
  if (!claimed || claimed.length === 0) return refuse("changed");

  // The graded records of the old result go too (an In Progress row must
  // not keep answer_records). One retry; if they still can't be deleted the
  // row is put back exactly as it was (only while nobody touched it since:
  // still In Progress with our started_at), so the result stays consistent.
  let arErr: { message: string } | null = null;
  for (let i = 0; i < 2; i++) {
    ({ error: arErr } = await db.from("answer_records").delete().eq("submission_id", row.id));
    if (!arErr) break;
  }
  if (arErr) {
    console.error("[module2-reopen] answer_records", row.id, arErr.message);
    const restore: Record<string, unknown> = {};
    const orig = row as unknown as Record<string, unknown>;
    for (const c of GRADED_COLUMNS) if (c in orig) restore[c] = orig[c];
    const { error: rbErr } = await db
      .from("submissions")
      .update(restore)
      .eq("id", row.id)
      .eq("status", "In Progress")
      .eq("started_at", nowIso);
    if (rbErr) console.error("[module2-reopen] rollback", row.id, rbErr.message);
    return refuse("records_failed");
  }

  return { ok: true, submissionId: row.id, track: row.adaptive_track as string };
}
