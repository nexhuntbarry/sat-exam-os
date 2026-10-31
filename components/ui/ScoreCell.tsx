import type { ScoreDisplay } from "@/lib/score-display";
import { cn } from "@/components/ui/data-table/cn";

/** The one score display: SAT section score large, per-module correct counts
 *  small underneath; % correct and in-review notes in the hover title.
 *  `score` comes from `scoreDisplay()`; null renders "—". */
export function ScoreCell({ score, className }: { score: ScoreDisplay | null; className?: string }) {
  if (!score) return <span className="text-soft-mute">—</span>;
  const title = [score.pct != null ? `${score.pct.toFixed(1)}% correct` : null, ...score.notes]
    .filter(Boolean)
    .join("\n");
  return (
    <div title={title || undefined} className={cn("whitespace-nowrap", className)}>
      {score.sat != null && <div className="text-base font-bold leading-tight text-charcoal">{score.sat}</div>}
      <div className="text-xs text-mid-gray">
        {score.modules}
        {score.notes.length > 0 && <span className="text-status-warning"> *</span>}
      </div>
    </div>
  );
}
