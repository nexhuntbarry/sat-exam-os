// "Report a problem": an admin describes something a student or teacher hit,
// with screenshots, and the dev (Claude, via the ops watcher) replies on the
// same thread. No new table: each request is one row in `notifications` with
// type SUPPORT_TYPE, user_id = the reporter, and the whole thread in payload.
// The bell API excludes this type; replies to the reporter go out as separate
// SUPPORT_REPLY_TYPE notifications so they ring the bell.
export const SUPPORT_TYPE = "support_request";
export const SUPPORT_REPLY_TYPE = "support_reply";

export type SupportStatus =
  | "new" // waiting for the dev to pick it up
  | "in_progress" // being fixed
  | "needs_approval" // new/removed feature: waits for Barry
  | "fixed"
  | "declined"; // Barry said no, or not a system problem

export interface SupportMessage {
  from: "reporter" | "dev";
  body: string;
  at: string;
  screenshots?: string[];
}

/** The question a report is about (question-page "Report to dev" reports). */
export interface SupportQuestionRef {
  id: string;
  module_name: string | null;
  number: number | null;
}

export interface SupportRequest {
  kind: "support_request";
  status: SupportStatus;
  reporter_name: string;
  reporter_email: string;
  messages: SupportMessage[];
  updated_at: string;
  question?: SupportQuestionRef;
  /** Where the thread came from when it wasn't opened on /admin/support (bug_reports row id). */
  source?: { kind: "bug_report"; id: string };
}

export function questionRefLabel(q: SupportQuestionRef): string {
  return `${q.module_name ?? "Question"} · Q${q.number ?? "?"}`;
}

export interface SupportRow {
  id: string;
  user_id: string;
  created_at: string;
  payload: SupportRequest;
}

export const STATUS_LABEL: Record<SupportStatus, string> = {
  new: "Received",
  in_progress: "Fixing",
  needs_approval: "Waiting for Barry's approval",
  fixed: "Fixed",
  declined: "Closed",
};
