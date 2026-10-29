// Dev log shown on /admin/reports during the QA / fix stage: nightly QA runs,
// a changelog of fixes and features, question bank / score changes, and items
// still waiting on a decision. No new table: each entry is one `notifications`
// row with type DEVLOG_TYPE (user_id = the super admin, read_at set) and the
// entry in payload. The bell APIs exclude this type. Rows are written by the
// dev CLI (.omc/devlog/log.mjs) and the nightly report job, never by the app.
import { getServiceClient } from "@/lib/supabase";

export const DEVLOG_TYPE = "dev_log";

export type ChangeType = "bug" | "feature" | "data" | "bank";
export type SourceKind = "qa" | "ticket" | "bug_report" | "barry" | "other";
export type Role = "student" | "teacher" | "admin";

export interface QaCheck {
  id: string;
  title?: string;
  result: string; // PASS | FAIL | ERROR
  details?: string;
  /** What was done about a failure (filled in by the dev). */
  action?: string;
}

export interface QaRunEntry {
  kind: "qa_run";
  date: string; // YYYY-MM-DD (New York)
  passed: number;
  total: number;
  failed: QaCheck[];
  /** Every check of the run, so the page can show the full report. */
  checks?: QaCheck[];
  report_url?: string | null;
  notes?: string | null;
}

export interface ChangeEntry {
  kind: "change";
  date: string; // date it went live
  type: ChangeType;
  title: string;
  body: string;
  source: string;
  source_kind: SourceKind;
  ticket_id?: string | null;
  commit?: string | null;
  roles: Role[];
  /** Check ids that verify it; empty = code change only. */
  verified: string[];
}

export interface BankChangeEntry {
  kind: "bank_change";
  date: string;
  title: string;
  body: string;
  /** How many attempts had their score change (0 / absent = no rescoring). */
  rescored?: number | null;
  ticket_id?: string | null;
}

export interface OpenItemEntry {
  kind: "open_item";
  date: string;
  title: string;
  body: string;
  waiting: "barry" | "admin";
  ticket_id?: string | null;
  resolved_at?: string | null;
}

export type DevLogEntry = QaRunEntry | ChangeEntry | BankChangeEntry | OpenItemEntry;

export interface DevLogRow<T extends DevLogEntry = DevLogEntry> {
  id: string;
  created_at: string;
  payload: T;
}

export const CHANGE_TYPE_LABEL: Record<ChangeType, string> = {
  bug: "Bug fix",
  feature: "Feature",
  data: "Data fix",
  bank: "Question bank fix",
};

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  qa: "QA finding",
  ticket: "Report a Problem",
  bug_report: "Bug Report",
  barry: "Barry's request",
  other: "Other",
};

export async function listDevLog(): Promise<DevLogRow[]> {
  const { data, error } = await getServiceClient()
    .from("notifications")
    .select("id, created_at, payload")
    .eq("type", DEVLOG_TYPE)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  return (data ?? []).filter((r) => r.payload?.kind) as DevLogRow[];
}
