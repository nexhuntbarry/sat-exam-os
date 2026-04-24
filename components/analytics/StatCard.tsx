import { clsx } from "clsx";
import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  color?: "blue" | "lime" | "emerald" | "amber" | "rose" | "default";
  icon?: ReactNode;
}

const colorMap: Record<string, string> = {
  blue: "bg-electric-blue/10 border-electric-blue/20 text-electric-blue",
  lime: "bg-lime-green/10 border-lime-green/20 text-lime-green",
  emerald: "bg-emerald/10 border-emerald/20 text-emerald",
  amber: "bg-amber/10 border-amber/20 text-amber",
  rose: "bg-rose/10 border-rose/20 text-rose",
  default: "bg-white/3 border-white/8 text-white",
};

export function StatCard({ label, value, sub, color = "default", icon }: StatCardProps) {
  const cls = colorMap[color] ?? colorMap.default;
  return (
    <div className={clsx("border rounded-xl p-4 flex flex-col gap-1", cls)}>
      <div className="flex items-center gap-2">
        {icon && <span className="opacity-70">{icon}</span>}
        <span className="text-soft-gray/50 text-xs">{label}</span>
      </div>
      <div className={clsx("text-2xl font-bold", color !== "default" ? "" : "text-white")}>
        {value}
      </div>
      {sub && <div className="text-soft-gray/40 text-xs">{sub}</div>}
    </div>
  );
}
