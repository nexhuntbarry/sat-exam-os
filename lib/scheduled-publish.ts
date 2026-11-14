// lib/scheduled-publish.ts
//
// The scheduled publish (tests.publish_at, migration 0034; ticket b271dd38):
// run by /api/cron/scheduled-publish every few minutes. Each due Draft goes
// through the shared publish handler (lib/test-status-handlers publishTest:
// the same readiness check, status-filtered Draft → Published update and
// review-queue invalidation as the Publish button) with a system identity.
//
// A stale schedule can't fire: the 0034 trigger clears publish_at whenever a
// test leaves Draft (and moving back to Draft clears it too), so any
// publish_at on a Draft was set while it was a Draft.
//
// Outcomes per due test:
//   - published: its students (direct + classes) get one notice per run;
//   - not-ready (a refusal, e.g. questions not Approved): stays Draft, keeps
//     publish_at with an error note, the admin is notified; not retried until
//     an admin reschedules (writePublishAt clears the note);
//   - skipped: the test left Draft meanwhile (someone published / closed it):
//     nothing is written, nobody notified;
//   - retry-later: a 5xx, or the error note couldn't be written: no notice,
//     tried again on the next run.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isQaEmail, scopeUsers } from "./qa";
import { loadPublishCheck, blockersMessage } from "./test-readiness";
import { publishTest, systemTestAuth } from "./test-status-handlers";
import { assignedStudents, insertTestsAssignedNotices, isPublishAtColumnMissing, writePublishAtError } from "./test-assign";
import {
  SCHEDULED_PUBLISH_FAILED_TYPE,
  duePublishes,
  publishAtErrorNote,
  testsPerStudent,
  type ScheduledRow,
} from "./test-assign-shared";

type DueRow = ScheduledRow & { test_name: string; created_by: string | null };

export interface ScheduledPublishOutcome {
  testId: string;
  name: string;
  publishAt: string;
  result: "published" | "not-ready" | "skipped" | "retry-later" | "would-publish" | "would-fail";
  reason?: string;
}

export interface ScheduledPublishRun {
  columnsMissing: boolean;
  dryRun: boolean;
  due: number;
  outcomes: ScheduledPublishOutcome[];
  /** Students notified about tests published in this run. */
  studentsNotified: number;
}

/**
 * Publish every due Draft (or, with `dryRun`, only report what would
 * happen). `testIds` limits the run to those tests (manual / nightly checks).
 */
export async function runScheduledPublish(
  db: SupabaseClient,
  opts: { now?: Date; dryRun?: boolean; testIds?: string[] } = {},
): Promise<ScheduledPublishRun> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  let q = db
    .from("tests")
    .select("id, test_name, status, publish_at, publish_at_error, parent_test_id, test_kind, created_by")
    .eq("status", "Draft")
    .not("publish_at", "is", null)
    .is("publish_at_error", null)
    .lte("publish_at", now.toISOString())
    .order("publish_at", { ascending: true })
    .limit(50);
  if (opts.testIds && opts.testIds.length > 0) q = q.in("id", opts.testIds);
  const { data, error } = await q;
  if (error) {
    if (isPublishAtColumnMissing(error)) return { columnsMissing: true, dryRun, due: 0, outcomes: [], studentsNotified: 0 };
    throw new Error(`scheduled publish lookup failed: ${error.message}`);
  }
  const due = duePublishes((data ?? []) as DueRow[], now);
  const outcomes: ScheduledPublishOutcome[] = [];

  for (const t of due) {
    const base = { testId: t.id, name: t.test_name, publishAt: t.publish_at! };
    if (dryRun) {
      const check = await loadPublishCheck(db, t.id);
      outcomes.push(
        check?.canPublish
          ? { ...base, result: "would-publish" }
          : { ...base, result: "would-fail", reason: check ? blockersMessage(check.blockers) : "Test not found" },
      );
      continue;
    }

    const res = await publishTest(t.id, systemTestAuth, "publish", "cron/scheduled-publish");
    if (res.ok) {
      outcomes.push({ ...base, result: "published" });
      continue;
    }
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    const reason = j.error ?? `HTTP ${res.status}`;
    if (res.status >= 500) {
      outcomes.push({ ...base, result: "retry-later", reason });
      continue;
    }
    // A refusal. If the test isn't a Draft any more, someone else moved it
    // (published / closed it, or it was deleted) — not a failure to report.
    const { data: now2, error: reErr } = await db.from("tests").select("status").eq("id", t.id).maybeSingle();
    if (reErr) {
      outcomes.push({ ...base, result: "retry-later", reason: "Could not re-check the test" });
      continue;
    }
    if (!now2 || now2.status !== "Draft") {
      outcomes.push({ ...base, result: "skipped", reason: now2 ? `now ${now2.status}` : "deleted" });
      continue;
    }
    let marked: boolean;
    try {
      marked = await writePublishAtError(db, t.id, publishAtErrorNote(reason, now));
    } catch {
      outcomes.push({ ...base, result: "retry-later", reason: "Could not record the failure" });
      continue;
    }
    if (!marked) {
      // Left Draft or unscheduled between the re-read and the write.
      outcomes.push({ ...base, result: "skipped", reason: "no longer scheduled" });
      continue;
    }
    await notifyAdmins(db, t, reason);
    outcomes.push({ ...base, result: "not-ready", reason });
  }

  const studentsNotified = dryRun ? 0 : await notifyPublished(db, due, outcomes, now);
  return { columnsMissing: false, dryRun, due: due.length, outcomes, studentsNotified };
}

/** One notice per student for every test published in this run. Never throws. */
async function notifyPublished(db: SupabaseClient, due: DueRow[], outcomes: ScheduledPublishOutcome[], now: Date): Promise<number> {
  const published = outcomes.filter((o) => o.result === "published").map((o) => o.testId);
  if (published.length === 0) return 0;
  try {
    const reached = await assignedStudents(db, published);
    const names = new Map(due.map((t) => [t.id, t.test_name]));
    return (await insertTestsAssignedNotices(db, testsPerStudent(reached), names, now)).length;
  } catch (e) {
    console.error("[cron/scheduled-publish] student notices failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/**
 * Tell the admin a scheduled publish didn't happen: the test's creator when
 * they're an admin, otherwise every admin on the test's side (QA / real).
 * Never throws.
 */
async function notifyAdmins(db: SupabaseClient, t: DueRow, reason: string): Promise<void> {
  try {
    let recipients: string[] = [];
    let creatorIsQa = false;
    if (t.created_by) {
      const { data: creator } = await db.from("users").select("id, role, email").eq("id", t.created_by).maybeSingle();
      if (creator?.role === "admin") recipients = [creator.id as string];
      creatorIsQa = isQaEmail(creator?.email as string | undefined);
    }
    if (recipients.length === 0) {
      const { data: admins } = await scopeUsers(db.from("users").select("id").eq("role", "admin"), creatorIsQa);
      recipients = (admins ?? []).map((a) => a.id as string);
    }
    if (recipients.length === 0) return;
    const message = `"${t.test_name}" was scheduled to publish but is still a Draft: ${reason} Fix it, then set a new publish time (or publish it by hand).`;
    const { error } = await db.from("notifications").insert(
      recipients.map((user_id) => ({
        user_id,
        type: SCHEDULED_PUBLISH_FAILED_TYPE,
        payload: { kind: SCHEDULED_PUBLISH_FAILED_TYPE, test_id: t.id, test_name: t.test_name, publish_at: t.publish_at, message },
      })),
    );
    if (error) console.error("[cron/scheduled-publish] notify failed:", error.message);
  } catch (e) {
    console.error("[cron/scheduled-publish] notify threw:", e instanceof Error ? e.message : e);
  }
}
