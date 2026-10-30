import { getServiceClient } from "@/lib/supabase";
import AiUsageCharts from "./AiUsageCharts";
import PageIntro from "@/components/shared/PageIntro";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  EmptyRow,
  TruncatedText,
} from "@/components/ui/data-table";

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
    <div className="space-y-6">
      <PageIntro tKey="admin.aiUsage" />
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
      <div>
        <h2 className="text-sm font-semibold text-charcoal mb-3">Calls per Route</h2>
        {usage.byRoute.length === 0 ? (
          <p className="text-soft-mute text-sm text-center py-10">No usage data yet.</p>
        ) : (
          <DataTable>
            <thead>
              <HeadRow>
                <Th kind="main" sticky="left">Route</Th>
                <Th>Calls</Th>
                <Th priority="md">Input Tokens</Th>
                <Th priority="md">Output Tokens</Th>
                <Th>Cost</Th>
              </HeadRow>
            </thead>
            <tbody>
              {usage.byRoute.map((r) => (
                <DataRow key={r.route}>
                  <Td kind="main" sticky="left">
                    <TruncatedText>{r.route}</TruncatedText>
                  </Td>
                  <Td className="text-mid-gray">{r.calls}</Td>
                  <Td priority="md" className="text-mid-gray">{r.tokens_input.toLocaleString()}</Td>
                  <Td priority="md" className="text-mid-gray">{r.tokens_output.toLocaleString()}</Td>
                  <Td className="text-mid-gray">${(r.cost_cents / 100).toFixed(4)}</Td>
                </DataRow>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  );
}
