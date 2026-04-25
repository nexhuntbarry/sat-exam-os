import { clsx } from "clsx";

interface ConfidenceBadgeProps {
  score: number | null;
  className?: string;
}

export default function ConfidenceBadge({ score, className }: ConfidenceBadgeProps) {
  if (score === null || score === undefined) {
    return (
      <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium bg-surface text-soft-mute", className)}>
        —
      </span>
    );
  }

  const pct = Math.round(score * 100);

  const color =
    score >= 0.85
      ? "bg-warm-amber/15 text-warm-amber"
      : score >= 0.7
      ? "bg-status-warning/15 text-status-warning"
      : "bg-status-error/15 text-status-error";

  return (
    <span
      className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", color, className)}
      title={`AI confidence: ${pct}%`}
    >
      {pct}%
    </span>
  );
}
