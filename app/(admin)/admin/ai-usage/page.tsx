import { getServiceClient } from "@/lib/supabase";
import AiUsageCharts from "./AiUsageCharts";

async function getUsageData() {
  const db = getServiceClient();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data } = await db
    .from("ai_usage_log")
    .select("route, tokens_input, tokens_output, model, cost_cents, created_at")
    .gte("created_at", startOfMonth)
    .order("created_at", { ascending: true });

  const rows = data ?? [];

  const totalTokensIn = rows.reduce((s, r) => s + (r.tokens_input ?? 0), 0);
  const totalTokensOut = rows.reduce((s, r) => s + (r.tokens_output ?? 0), 0);
  const totalCostCents = rows.reduce((s, r) => s + (r.cost_cents ?? 0), 0);

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

  const byDay: Record<string, { date: string; cost_cents: number; calls: number }> = {};
  for (const r of rows) {
    const date = r.created_at.slice(0, 10);
    if (!byDay[date]) byDay[date] = { date, cost_cents: 0, calls: 0 };
    byDay[date].cost_cents += r.cost_cents ?? 0;
    byDay[date].calls++;
  }

  return {
    totalCalls: rows.length,
    totalTokensIn,
    totalTokensOut,
    totalCostCents,
    byRoute: Object.entries(byRoute).map(([route, s]) => ({ route, ...s })),
    dailyTrend: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export default async function AiUsagePage() {
  const usage = await getUsageData();

  const stats = [
    { label: "Total Calls", value: String(usage.totalCalls) },
    { label: "Input Tokens", value: usage.totalTokensIn.toLocaleString() },
    { label: "Output Tokens", value: usage.totalTokensOut.toLocaleString() },
    { label: "Est. Cost (month)", value: `$${(usage.totalCostCents / 100).toFixed(2)}` },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-charcoal">AI Usage</h1>
      <p className="text-soft-mute text-sm -mt-4">This month · Claude Sonnet 4.6 · $3/M input, $15/M output</p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map(({ label, value }) => (
          <div key={label} className="bg-surface border border-divider rounded-2xl p-5">
            <p className="text-soft-mute text-xs mb-1">{label}</p>
            <p className="text-charcoal text-xl font-bold">{value}</p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <AiUsageCharts dailyTrend={usage.dailyTrend} />

      {/* Per-route table */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-divider">
          <h2 className="text-sm font-semibold text-charcoal">Calls per Route</h2>
        </div>
        {usage.byRoute.length === 0 ? (
          <p className="text-soft-mute text-sm text-center py-10">No usage data yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Route</th>
                  <th className="text-right px-5 py-3 font-medium">Calls</th>
                  <th className="text-right px-5 py-3 font-medium">Input Tokens</th>
                  <th className="text-right px-5 py-3 font-medium">Output Tokens</th>
                  <th className="text-right px-5 py-3 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.byRoute.map((r) => (
                  <tr key={r.route} className="border-b border-divider last:border-0 hover:bg-light-bg/60">
                    <td className="px-5 py-3 text-charcoal font-medium">{r.route}</td>
                    <td className="px-5 py-3 text-right text-mid-gray">{r.calls}</td>
                    <td className="px-5 py-3 text-right text-mid-gray">{r.tokens_input.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-mid-gray">{r.tokens_output.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-mid-gray">${(r.cost_cents / 100).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
