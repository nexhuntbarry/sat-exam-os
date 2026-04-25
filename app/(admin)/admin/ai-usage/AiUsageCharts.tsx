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
      <div className="bg-surface border border-divider rounded-2xl p-10 text-center text-soft-mute text-sm">
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
    <div className="bg-surface border border-divider rounded-2xl p-5">
      <h2 className="text-sm font-semibold text-charcoal mb-4">Daily Cost Trend (this month)</h2>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(31,31,31,0.06)" />
          <XAxis
            dataKey="date"
            tick={{ fill: "rgba(31,31,31,0.55)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "rgba(31,31,31,0.55)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v}`}
          />
          <Tooltip
            contentStyle={{
              background: "#FFFFFF",
              border: "1px solid #E4E4E4",
              borderRadius: 8,
              color: "#1F1F1F",
              fontSize: 12,
            }}
            formatter={(value) => [`$${value}`, "Cost"]}
          />
          <Line
            type="monotone"
            dataKey="cost"
            stroke="#F0523D"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#F0523D" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
