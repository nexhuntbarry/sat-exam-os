// Pure label-placement helper for SVG score charts.
// Groups points by x column and spaces their labels vertically so they never
// overlap. The topmost dot in each column keeps its natural position (10 px
// above the dot); lower dots have their labels nudged downward until every
// adjacent pair is at least minSpacing pixels apart.

/**
 * Compute a label Y for every point, with collision avoidance within each
 * x column.
 *
 * @param points  One entry per data point: id (unique), screen x, dot's screen y.
 * @param minSpacing  Minimum vertical gap (px) between label baselines. Default 14.
 * @returns  Map from point id → label y coordinate.
 */
export function placeLabels(
  points: { id: string; x: number; dotY: number }[],
  minSpacing = 14,
): Map<string, number> {
  // Group by rounded x (points ≤0.5 px apart share a column).
  const byX = new Map<number, { id: string; dotY: number }[]>();
  for (const p of points) {
    const xKey = Math.round(p.x);
    const arr = byX.get(xKey) ?? [];
    arr.push({ id: p.id, dotY: p.dotY });
    byX.set(xKey, arr);
  }

  const result = new Map<string, number>();

  for (const group of byX.values()) {
    // Sort topmost (smallest y) first; topmost dot gets the privileged above-dot position.
    const sorted = [...group].sort((a, b) => a.dotY - b.dotY);
    const positions = sorted.map((g) => ({ id: g.id, y: g.dotY - 10 }));

    // Push each label down until it clears the one above it.
    for (let i = 1; i < positions.length; i++) {
      if (positions[i].y < positions[i - 1].y + minSpacing) {
        positions[i].y = positions[i - 1].y + minSpacing;
      }
    }

    for (const p of positions) result.set(p.id, p.y);
  }

  return result;
}
