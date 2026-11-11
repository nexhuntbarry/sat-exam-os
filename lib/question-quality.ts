// lib/question-quality.ts
//
// Admin dashboard "Question quality" card (app/(admin)/admin/
// QuestionQualityCard.tsx): read-only counts.
// - Approved questions: questions.parsing_status.
// - Live fixes awaiting re-check: Approved questions changed in a live test
//   carry a leading "[live-fix]" note until a person confirms / undoes it
//   (lib/live-fix.ts). There is no edit history table, so "fixed in the
//   last N days" is not counted: updated_at also moves on approve / status
//   changes, and the note is rewritten on confirm.
// - Student reports: notifications rows of type student_report
//   (lib/student-reports-shared.ts); resolved = forwarded or dismissed,
//   timed by payload.handled_at.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportRow {
  created_at: string;
  status: string | null;
  handled_at: string | null;
}

export interface ReportStats {
  /** Reports created in the window. */
  received: number;
  /** Reports forwarded or dismissed in the window (whenever they came in). */
  resolved: number;
  /** Median created → handled time of the reports resolved in the window, ms. */
  medianResolveMs: number | null;
}

export function reportStats(rows: ReportRow[], now: number, days: number): ReportStats {
  const since = now - days * DAY_MS;
  let received = 0;
  const durations: number[] = [];
  for (const r of rows) {
    const created = Date.parse(r.created_at);
    if (Number.isFinite(created) && created >= since) received++;
    if (r.status !== "forwarded" && r.status !== "dismissed") continue;
    const handled = r.handled_at ? Date.parse(r.handled_at) : NaN;
    if (!Number.isFinite(handled) || handled < since || handled > now) continue;
    durations.push(Math.max(0, handled - (Number.isFinite(created) ? created : handled)));
  }
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const medianResolveMs = durations.length === 0
    ? null
    : durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
  return { received, resolved: durations.length, medianResolveMs };
}

/** "45 min", "6 h", "2.5 days". */
export function formatDuration(ms: number): string {
  const min = ms / 60000;
  if (min < 90) return `${Math.max(1, Math.round(min))} min`;
  const h = min / 60;
  if (h < 36) return `${Math.round(h)} h`;
  const d = h / 24;
  return `${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)} days`;
}
