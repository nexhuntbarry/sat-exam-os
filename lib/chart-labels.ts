// Pure label-placement helper for SVG score charts.
//
// Strategy: within each x column, the topmost dot's label goes ABOVE its dot;
// all other dots' labels go BELOW. This direction-split guarantees that an
// above-label and the first below-label can never collide (the above-label
// ends above the topmost dot; every below-label starts below its own dot,
// which is at or below the topmost dot). Within the below-group, stacked
// labels are nudged down until every adjacent pair is separated by at least
// textHeight + labelGap pixels (full bounding-box clearance, not just centre
// spacing).
//
// Label bounding box (SVG, y increases downward):
//   top    = labelY - textHeight   (the character cap-height above baseline)
//   bottom = labelY                (the text baseline)
//
// Dot occupies [dotY - dotRadius, dotY + dotRadius].
// Above label: labelY = dotY - dotRadius - gap  (bottom of text clears top of dot)
// Below label: labelY = dotY + dotRadius + gap + textHeight  (top of text clears bottom of dot)

export interface PlaceLabelConfig {
  /** Rendered height of a label in px (font-size + ascenders). Default 12. */
  textHeight?: number;
  /** Dot radius in px. Default 3.5. */
  dotRadius?: number;
  /** Minimum gap (px) between a dot's edge and the nearest label edge. Default 2. */
  gap?: number;
  /** Minimum gap (px) between two adjacent label bounding boxes. Default 2. */
  labelGap?: number;
}

/**
 * Compute a label Y (baseline) for every data point, with bounding-box-aware
 * collision avoidance.
 *
 * Returns Map<id, labelY>. Use as the SVG `text` element's `y` attribute.
 */
export function placeLabels(
  points: { id: string; x: number; dotY: number }[],
  config: PlaceLabelConfig = {},
): Map<string, number> {
  const textHeight = config.textHeight ?? 12;
  const dotRadius  = config.dotRadius  ?? 3.5;
  const gap        = config.gap        ?? 2;
  const labelGap   = config.labelGap   ?? 2;

  // Offsets from dotY to label baseline:
  const aboveOffset = -(dotRadius + gap);             // above: clearance between label bottom and dot top
  const belowOffset =   dotRadius + gap + textHeight; // below: clearance between label top and dot bottom

  // Minimum distance between two consecutive below-label baselines for
  // their bounding boxes to be fully non-overlapping (with labelGap clearance).
  const minStep = textHeight + labelGap;

  // Group by rounded x so points ≤0.5 px apart share a column.
  const byX = new Map<number, { id: string; dotY: number }[]>();
  for (const p of points) {
    const xKey = Math.round(p.x);
    const arr = byX.get(xKey) ?? [];
    arr.push({ id: p.id, dotY: p.dotY });
    byX.set(xKey, arr);
  }

  const result = new Map<string, number>();

  for (const group of byX.values()) {
    // Sort topmost (smallest y value = highest on screen) first.
    const sorted = [...group].sort((a, b) => a.dotY - b.dotY);

    // Assign initial positions.
    const positions: { id: string; dotY: number; labelY: number }[] = sorted.map((g, i) => ({
      id: g.id,
      dotY: g.dotY,
      labelY: g.dotY + (i === 0 ? aboveOffset : belowOffset),
    }));

    // Resolve overlaps within the below-group (positions[1..n-1]) by pushing
    // each label down until it clears the one before it.
    for (let i = 2; i < positions.length; i++) {
      const minY = positions[i - 1].labelY + minStep;
      if (positions[i].labelY < minY) positions[i].labelY = minY;
    }

    for (const p of positions) result.set(p.id, p.labelY);
  }

  return result;
}
