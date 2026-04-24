import { clsx } from "clsx";

interface ConfidenceBadgeProps {
  score: number | null;
  className?: string;
}

export default function ConfidenceBadge({ score, className }: ConfidenceBadgeProps) {
  if (score === null || score === undefined) {
    return (
      <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium bg-white/8 text-soft-gray/40", className)}>
        —
      </span>
    );
  }

  const pct = Math.round(score * 100);

  const color =
    score >= 0.85
      ? "bg-lime-green/15 text-lime-green"
      : score >= 0.7
      ? "bg-amber/15 text-amber"
      : "bg-rose/15 text-rose";

  return (
    <span
      className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", color, className)}
      title={`AI confidence: ${pct}%`}
    >
      {pct}%
    </span>
  );
}
