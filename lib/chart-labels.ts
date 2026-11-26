// Pure label-placement helper for SVG score charts.
//
// Algorithm:
//   1. Within each x column, sort dots top→bottom (smallest SVG y first).
//   2. Split into *clusters*: consecutive dots whose screen gap is less than
//      2 × textHeight are "close" and belong to the same cluster.  Dots
//      separated by a larger gap are independent clusters.
//   3. Within each cluster:
//        • 1 dot  → label ABOVE its dot.
//        • 2 dots → upper dot ABOVE, lower dot BELOW.
//        • 3+ dots → top dot ABOVE, all others BELOW (stacked downward with
//          full bounding-box clearance so boxes never touch).
//
//   This ensures that an isolated dot always gets its label above, while two
//   nearby dots (e.g. Math 510 and R&W 490) always split above/below
//   regardless of a third dot that sits far away (e.g. Total 1000).
//
// Label bounding box (SVG, y increases downward):
//   top    = labelY - textHeight
//   bottom = labelY  (the text baseline)
//
// Dot occupies [dotY − dotRadius, dotY + dotRadius].
// ABOVE: labelY = dotY − dotRadius − gap  (box bottom clears dot top by gap px)
// BELOW: labelY = dotY + dotRadius + gap + textHeight  (box top clears dot bottom by gap px)

export interface PlaceLabelConfig {
  /** Rendered height of a label (font-size + ascenders). Default 12. */
  textHeight?: number;
  /** Dot radius in px. Default 3.5. */
  dotRadius?: number;
  /** Gap between dot edge and nearest label edge. Default 2. */
  gap?: number;
  /** Gap between adjacent label bounding boxes in the same cluster. Default 2. */
  labelGap?: number;
}

/** A drawn line segment that labels should not sit on. */
export interface LabelSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Does the segment pass through the box [left, right] × [top, bottom]? */
function segmentHitsBox(s: LabelSegment, left: number, right: number, top: number, bottom: number): boolean {
  const lo = Math.max(left, Math.min(s.x1, s.x2));
  const hi = Math.min(right, Math.max(s.x1, s.x2));
  if (lo > hi) return false;
  const yAt = (x: number) => (s.x2 === s.x1 ? s.y1 : s.y1 + ((s.y2 - s.y1) * (x - s.x1)) / (s.x2 - s.x1));
  const ya = yAt(lo);
  const yb = yAt(hi);
  return Math.max(ya, yb) >= top && Math.min(ya, yb) <= bottom;
}

/**
 * Compute a label Y (baseline) for every data point.
 * Returns Map<id, labelY>.  Use as the SVG `text` element's `y` attribute.
 *
 * `avoid` (optional): the chart's line segments. A dot alone in its cluster
 * then gets its label BELOW instead when a line runs through the ABOVE spot
 * and not through the below one (e.g. a line climbing steeply from the dot).
 * The label is `width` px wide (default: 6.5 px a character of `text`).
 */
export function placeLabels(
  points: { id: string; x: number; dotY: number; text?: string; width?: number }[],
  config: PlaceLabelConfig = {},
  avoid?: { segments: LabelSegment[] },
): Map<string, number> {
  const textHeight = config.textHeight ?? 12;
  const dotRadius  = config.dotRadius  ?? 3.5;
  const gap        = config.gap        ?? 2;
  const labelGap   = config.labelGap   ?? 2;

  // Two consecutive dots (sorted) whose screen gap is below this form one cluster.
  const clusterGap = textHeight * 2; // e.g. 24 px for textHeight=12

  // Offset from dotY to label baseline:
  const aboveY = (dotY: number) => dotY - dotRadius - gap;
  const belowY = (dotY: number) => dotY + dotRadius + gap + textHeight;

  // Minimum baseline separation for two below-labels to be box-clear.
  const minStep = textHeight + labelGap;

  // Group by rounded x so dots ≤0.5 px apart share one column.
  const byX = new Map<number, { id: string; dotY: number }[]>();
  const byId = new Map(points.map((p) => [p.id, p]));
  for (const p of points) {
    const xKey = Math.round(p.x);
    const arr = byX.get(xKey) ?? [];
    arr.push({ id: p.id, dotY: p.dotY });
    byX.set(xKey, arr);
  }

  // A lone dot's label spot is blocked when a line segment runs through it.
  const blocked = (id: string, labelY: number): boolean => {
    const p = byId.get(id);
    if (!avoid || !p) return false;
    const half = (p.width ?? (p.text?.length ?? 3) * 6.5) / 2;
    return avoid.segments.some((s) => segmentHitsBox(s, p.x - half, p.x + half, labelY - textHeight, labelY));
  };

  const result = new Map<string, number>();

  for (const group of byX.values()) {
    // Sort topmost (smallest y) first.
    const sorted = [...group].sort((a, b) => a.dotY - b.dotY);

    // Build clusters.
    const clusters: { id: string; dotY: number }[][] = [];
    let cur: { id: string; dotY: number }[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].dotY - sorted[i - 1].dotY < clusterGap) {
        cur.push(sorted[i]);
      } else {
        clusters.push(cur);
        cur = [sorted[i]];
      }
    }
    clusters.push(cur);

    // Place labels per cluster.
    for (const cluster of clusters) {
      // Top dot goes ABOVE (a lone dot: BELOW when only that spot is clear of the lines).
      const top = cluster[0];
      const flip = cluster.length === 1 && blocked(top.id, aboveY(top.dotY)) && !blocked(top.id, belowY(top.dotY));
      result.set(top.id, flip ? belowY(top.dotY) : aboveY(top.dotY));

      if (cluster.length > 1) {
        // Remaining dots go BELOW, stacked down until every adjacent pair
        // has full bounding-box clearance.
        const belowItems = cluster.slice(1).map((g) => ({
          id: g.id,
          labelY: belowY(g.dotY),
        }));
        for (let i = 1; i < belowItems.length; i++) {
          const minY = belowItems[i - 1].labelY + minStep;
          if (belowItems[i].labelY < minY) belowItems[i].labelY = minY;
        }
        for (const item of belowItems) result.set(item.id, item.labelY);
      }
    }
  }

  return result;
}
