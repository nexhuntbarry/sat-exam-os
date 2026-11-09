import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { settleQueue } from "@/lib/review-auto";

export const maxDuration = 300;

// GET /api/cron/review-auto-settle  (Vercel Cron, hourly; Authorization: Bearer <CRON_SECRET>)
//
// New uploads land in Needs Review / Draft: the system settles what it can
// (lib/review-auto.ts) so only real decisions wait for a person. At most 6
// key changes per run (one explanation AI call each); ?dry=1 only counts.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  try {
    const { outcomes, paused } = await settleQueue(getServiceClient(), { apply: !dry, maxKeyChanges: 6, deadline: Date.now() + 200_000 });
    const counts: Record<string, number> = {};
    for (const o of outcomes) counts[o.action] = (counts[o.action] ?? 0) + 1;
    console.log(`[cron/review-auto-settle] dry=${dry} paused=${paused} ${JSON.stringify(counts)}`);
    return NextResponse.json({ ok: true, dry, paused, counts, rows: outcomes.filter((o) => o.action !== "none") });
  } catch (e) {
    console.error("[cron/review-auto-settle] error:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
