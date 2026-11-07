import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { autoFixExplanations, explanationTargetReasons, loadAutoFixRows, summarize } from "@/lib/explanation-autofix";

export const maxDuration = 300;

// GET /api/cron/auto-fix-explanations  (Vercel Cron, daily; Authorization: Bearer <CRON_SECRET>)
//
// Bank-wide sweep for explanation-only problems (cut off, broken formatting,
// arguing a different choice than the official key) across Needs Review and
// Approved questions — lib/explanation-autofix.ts. Each run fixes at most
// `limit` rows (default 24, 4 at a time) and stops starting new ones after
// ~4 minutes, so it stays inside maxDuration; the next run takes the rest.
// ?dry=1 reports what it would do without writing.
const BUDGET_MS = 240_000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 24, 1), 60);
  const dry = url.searchParams.get("dry") === "1";
  const t0 = Date.now();
  const db = getServiceClient();
  const rows = await loadAutoFixRows(db);
  const targets = rows.filter((r) => explanationTargetReasons(r));
  // Shuffle so rows that keep failing (still cut off) don't starve the rest.
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  const batch = targets.slice(0, limit);
  const out = await autoFixExplanations(db, batch, {
    apply: !dry,
    concurrency: 4,
    deadline: t0 + BUDGET_MS,
    usageRoute: "cron-auto-fix-explanations",
  });
  const summary = summarize(out);
  console.log(`[cron/auto-fix-explanations] targets=${targets.length} processed=${out.length} dry=${dry} ${JSON.stringify(summary)}`);
  return NextResponse.json({
    ok: true,
    dry,
    targets: targets.length,
    processed: out.length,
    summary,
    elapsed_s: Math.round((Date.now() - t0) / 1000),
    rows: out.map((o) => ({ id: o.id, number: o.number, group: o.group, status_before: o.status_before, status_after: o.status_after, detail: o.detail, blockers: o.blockers })),
  });
}
