import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { runScheduledPublish } from "@/lib/scheduled-publish";

export const maxDuration = 60;

/**
 * Vercel Cron entry point (every 5 minutes, vercel.json): publishes Drafts
 * whose scheduled time (tests.publish_at, migration 0034) has come, through
 * the shared publish handler — same readiness check, status-filtered update
 * and review-queue invalidation as the Publish button (lib/scheduled-publish).
 * A test that fails the check stays Draft with an error note and its admin
 * is notified; it isn't retried until rescheduled.
 *
 * Query: ?dryRun=1 reports what would happen without writing;
 * ?testId=<id> (repeatable) limits the run to those tests.
 * Before migration 0034 it does nothing ({ columnsMissing: true }).
 *
 * Auth: Vercel injects `Authorization: Bearer <CRON_SECRET>` on scheduled
 * invocations; manual calls pass the same header (same as the other crons).
 */
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  const provided = req.headers.get("authorization") ?? "";
  if (expected && provided !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const testIds = url.searchParams.getAll("testId").filter(Boolean);

  try {
    const run = await runScheduledPublish(getServiceClient(), { dryRun, testIds });
    if (run.outcomes.length > 0) {
      console.info(
        `[cron/scheduled-publish]${dryRun ? " (dry run)" : ""}`,
        run.outcomes.map((o) => `${o.testId} "${o.name}": ${o.result}${o.reason ? ` — ${o.reason}` : ""}`).join("; "),
      );
    }
    return NextResponse.json({
      ok: true,
      ...run,
      published: run.outcomes.filter((o) => o.result === "published").length,
      failed: run.outcomes.filter((o) => o.result === "not-ready").length,
    });
  } catch (e) {
    console.error("[cron/scheduled-publish]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Scheduled publish failed" }, { status: 500 });
  }
}
