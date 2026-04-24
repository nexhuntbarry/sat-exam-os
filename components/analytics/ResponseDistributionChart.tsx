"use client";

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";

interface ResponseSlice {
  label: string;
  count: number;
  isCorrect: boolean;
}

interface ResponseDistributionChartProps {
  data: ResponseSlice[];
  totalStudents: number;
}

const CHOICE_COLORS: Record<string, string> = {
  A: "#2563EB",
  B: "#84CC16",
  C: "#F59E0B",
  D: "#10B981",
  blank: "#6B7280",
};

export function ResponseDistributionChart({ data, totalStudents }: ResponseDistributionChartProps) {
  const pieData = data.map((d) => ({
    name: d.label === "blank" ? "Blank" : `Choice ${d.label}`,
    value: d.count,
    pct: totalStudents > 0 ? ((d.count / totalStudents) * 100).toFixed(1) : "0",
    color: CHOICE_COLORS[d.label] ?? "#6B7280",
    isCorrect: d.isCorrect,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={pieData}
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={80}
          dataKey="value"
          paddingAngle={2}
        >
          {pieData.map((entry) => (
            <Cell key={entry.name} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value, name, props) => [
            `${value} students (${(props.payload as { pct: string }).pct}%)`,
            name,
          ]}
          contentStyle={{
            backgroundColor: "#0F1C3F",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            color: "#E6E9EE",
            fontSize: 12,
          }}
        />
        <Legend
          iconType="circle"
          iconSize={8}
          formatter={(value) => (
            <span style={{ color: "#9CA3AF", fontSize: 12 }}>{value}</span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
