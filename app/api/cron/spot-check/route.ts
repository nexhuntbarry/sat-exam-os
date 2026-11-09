import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { cronMaxParam, runSpotCheckBatch } from "@/lib/spot-check-run";

export const maxDuration = 300;

// GET /api/cron/spot-check  (Vercel Cron, daily; Authorization: Bearer <CRON_SECRET>)
//
// The weekly random spot-check of system-approved questions (lib/spot-check.ts,
// Barry approved 2026-11-09, about $2 a week): each run re-solves at most
// SPOT_CHECK_CRON_MAX (13) questions — about 3 AI calls each, so at most ~39
// calls per run — 4 at a time, and starts none after ~200 s. It stops once
// this week's quota (5% of system-approved, at least 20) is reached, so 7 daily
// runs cover the week. A live question is never demoted (lib/spot-check-run.ts).
// ?max=N lowers the cap for a run (never raises it).
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Vercel Cron sends no query string: missing ?max means the full cap.
  const max = cronMaxParam(new URL(req.url).searchParams.get("max"));
  try {
    const res = await runSpotCheckBatch(getServiceClient(), { max, deadline: Date.now() + 200_000, concurrency: 4 });
    const tally: Record<string, number> = {};
    for (const l of res.lines) tally[l.outcome] = (tally[l.outcome] ?? 0) + 1;
    console.log(`[cron/spot-check] ${JSON.stringify(tally)} week ${res.doneThisWeek}/${res.weeklyTarget} stopped=${res.stoppedBy}`);
    return NextResponse.json({ ok: true, tally, weeklyTarget: res.weeklyTarget, doneThisWeek: res.doneThisWeek, stoppedBy: res.stoppedBy, lines: res.lines });
  } catch (e) {
    console.error("[cron/spot-check] error:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
