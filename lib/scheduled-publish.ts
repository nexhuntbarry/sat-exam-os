// lib/scheduled-publish.ts
//
// The scheduled publish (tests.publish_at, migration 0034; ticket b271dd38):
// run by /api/cron/scheduled-publish every few minutes. Each due Draft goes
// through the shared publish handler (lib/test-status-handlers publishTest:
// the same readiness check, status-filtered Draft → Published update and
// review-queue invalidation as the Publish button) with a system identity.
//
// A refusal (not ready, e.g. questions not Approved) leaves the test in
// Draft, keeps publish_at with an error note so it isn't retried every run,
// and notifies the admin; it is retried only when an admin reschedules
// (writePublishAt clears the note). A transient failure (500) is retried
// on the next run.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isQaEmail, scopeUsers } from "./qa";
import { loadPublishCheck, blockersMessage } from "./test-readiness";
import { publishTest, systemTestAuth } from "./test-status-handlers";
import { isPublishAtColumnMissing, writePublishAtError } from "./test-assign";
import {
  SCHEDULED_PUBLISH_FAILED_TYPE,
  duePublishes,
  publishAtErrorNote,
  type ScheduledRow,
} from "./test-assign-shared";

type DueRow = ScheduledRow & { test_name: string; created_by: string | null };

export interface ScheduledPublishOutcome {
  testId: string;
  name: string;
  publishAt: string;
  result: "published" | "not-ready" | "retry-later" | "would-publish" | "would-fail";
  reason?: string;
}

export interface ScheduledPublishRun {
  columnsMissing: boolean;
  dryRun: boolean;
  due: number;
  outcomes: ScheduledPublishOutcome[];
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
    if (isPublishAtColumnMissing(error)) return { columnsMissing: true, dryRun, due: 0, outcomes: [] };
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
      // Lookup / write error: try again on the next run.
      outcomes.push({ ...base, result: "retry-later", reason });
      continue;
    }
    // A refusal (409 not ready / no longer Draft, 404 gone): don't retry.
    try {
      await writePublishAtError(db, t.id, publishAtErrorNote(reason, now));
    } catch (e) {
      console.error("[cron/scheduled-publish] error note", t.id, e);
    }
    await notifyAdmins(db, t, reason);
    outcomes.push({ ...base, result: "not-ready", reason });
  }

  return { columnsMissing: false, dryRun, due: due.length, outcomes };
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
