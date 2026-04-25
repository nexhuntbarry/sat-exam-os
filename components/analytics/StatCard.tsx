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
  blue: "bg-warm-coral/10 border-warm-coral/20 text-warm-coral",
  lime: "bg-warm-amber/10 border-warm-amber/20 text-warm-amber",
  emerald: "bg-status-success/10 border-status-success/20 text-status-success",
  amber: "bg-status-warning/10 border-status-warning/20 text-status-warning",
  rose: "bg-status-error/10 border-status-error/20 text-status-error",
  default: "bg-surface border-divider text-charcoal",
};

export function StatCard({ label, value, sub, color = "default", icon }: StatCardProps) {
  const cls = colorMap[color] ?? colorMap.default;
  return (
    <div className={clsx("border rounded-xl p-4 flex flex-col gap-1", cls)}>
      <div className="flex items-center gap-2">
        {icon && <span className="opacity-70">{icon}</span>}
        <span className="text-soft-mute text-xs">{label}</span>
      </div>
      <div className={clsx("text-2xl font-bold", color !== "default" ? "" : "text-charcoal")}>
        {value}
      </div>
      {sub && <div className="text-soft-mute text-xs">{sub}</div>}
    </div>
  );
}
