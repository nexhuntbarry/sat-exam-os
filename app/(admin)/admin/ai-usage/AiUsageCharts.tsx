"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface DayEntry {
  date: string;
  cost_cents: number;
  calls: number;
}

interface AiUsageChartsProps {
  dailyTrend: DayEntry[];
}

export default function AiUsageCharts({ dailyTrend }: AiUsageChartsProps) {
  if (dailyTrend.length === 0) {
    return (
      <div className="bg-white/3 border border-white/8 rounded-2xl p-10 text-center text-soft-gray/30 text-sm">
        No daily data yet.
      </div>
    );
  }

  const data = dailyTrend.map((d) => ({
    date: d.date.slice(5), // MM-DD
    cost: +(d.cost_cents / 100).toFixed(4),
    calls: d.calls,
  }));

  return (
    <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
      <h2 className="text-sm font-semibold text-soft-gray mb-4">Daily Cost Trend (this month)</h2>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="date"
            tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v}`}
          />
          <Tooltip
            contentStyle={{
              background: "#0f172a",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              color: "#e2e8f0",
              fontSize: 12,
            }}
            formatter={(value) => [`$${value}`, "Cost"]}
          />
          <Line
            type="monotone"
            dataKey="cost"
            stroke="#2563EB"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#2563EB" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
