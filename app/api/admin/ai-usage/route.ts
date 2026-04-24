import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/ai-usage?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const db = getServiceClient();

  let query = db
    .from("ai_usage_log")
    .select("id, route, tokens_input, tokens_output, model, cost_cents, created_at")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to + "T23:59:59Z");

  const { data, error } = await query;

  if (error) {
    console.error("[ai-usage] GET error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  const rows = data ?? [];

  // Aggregate stats
  const totalTokensIn = rows.reduce((s, r) => s + (r.tokens_input ?? 0), 0);
  const totalTokensOut = rows.reduce((s, r) => s + (r.tokens_output ?? 0), 0);
  const totalCostCents = rows.reduce((s, r) => s + (r.cost_cents ?? 0), 0);

  // Per-route breakdown
  const byRoute: Record<string, { calls: number; tokens_input: number; tokens_output: number; cost_cents: number }> = {};
  for (const r of rows) {
    if (!byRoute[r.route]) {
      byRoute[r.route] = { calls: 0, tokens_input: 0, tokens_output: 0, cost_cents: 0 };
    }
    byRoute[r.route].calls++;
    byRoute[r.route].tokens_input += r.tokens_input ?? 0;
    byRoute[r.route].tokens_output += r.tokens_output ?? 0;
    byRoute[r.route].cost_cents += r.cost_cents ?? 0;
  }

  // Daily trend (group by date)
  const byDay: Record<string, { date: string; tokens_input: number; tokens_output: number; cost_cents: number; calls: number }> = {};
  for (const r of rows) {
    const date = r.created_at.slice(0, 10);
    if (!byDay[date]) {
      byDay[date] = { date, tokens_input: 0, tokens_output: 0, cost_cents: 0, calls: 0 };
    }
    byDay[date].tokens_input += r.tokens_input ?? 0;
    byDay[date].tokens_output += r.tokens_output ?? 0;
    byDay[date].cost_cents += r.cost_cents ?? 0;
    byDay[date].calls++;
  }

  return NextResponse.json({
    summary: {
      totalCalls: rows.length,
      totalTokensIn,
      totalTokensOut,
      totalCostCents,
      totalCostDollars: (totalCostCents / 100).toFixed(2),
    },
    byRoute: Object.entries(byRoute).map(([route, stats]) => ({ route, ...stats })),
    dailyTrend: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
  });
}
