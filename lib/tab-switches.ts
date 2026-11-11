// lib/tab-switches.ts
//
// "Left tab" count shown to teachers / admins: how often the student hid
// the exam tab, saved by the take page as submissions.metadata.tab_switches
// (one count per module row). Select it without the whole metadata blob:
// `tab_switches:metadata->tab_switches`.

/** At or above this many, the count is highlighted. */
export const TAB_SWITCH_WARN_AT = 3;

export const TAB_SWITCH_HELP =
  "Times the student switched away from the exam tab. Can be innocent (notifications), so use it as a prompt to ask, not proof.";

/** Sum of the rows' counts (an attempt's modules / sections); null when no row recorded one. */
export function tabSwitchTotal(rows: { tab_switches?: unknown }[]): number | null {
  let total: number | null = null;
  for (const r of rows) {
    const n = Number(r.tab_switches);
    if (r.tab_switches != null && Number.isFinite(n) && n >= 0) total = (total ?? 0) + Math.floor(n);
  }
  return total;
}
