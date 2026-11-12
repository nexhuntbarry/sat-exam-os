// Double-sided printing of several students in one job: each student starts
// on a front side (an odd page), so no sheet carries two students. A blank
// filler page goes after a student with an odd page count; it belongs to
// that student but isn't counted in their "Page x of y".

/**
 * Per printed page, whose it is (a student key, or null for a blank filler
 * page) → that page's "Page x of y" counting only that student's pages;
 * null for filler pages.
 */
export function studentPageLabels(owners: (string | null)[]): ({ n: number; of: number } | null)[] {
  const total = new Map<string, number>();
  for (const o of owners) if (o !== null) total.set(o, (total.get(o) ?? 0) + 1);
  const seen = new Map<string, number>();
  return owners.map((o) => {
    if (o === null) return null;
    const n = (seen.get(o) ?? 0) + 1;
    seen.set(o, n);
    return { n, of: total.get(o)! };
  });
}

/** Combined PDF: whether a blank page follows each student (odd count, not the last student). */
export function fillersAfter(pageCounts: number[]): boolean[] {
  return pageCounts.map((n, i) => i < pageCounts.length - 1 && n % 2 === 1);
}
