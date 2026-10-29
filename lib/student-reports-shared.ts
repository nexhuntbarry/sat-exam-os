// Student "Report a problem": a student flags a question while taking a
// test or reviewing results. No new table: each report is one row in
// `notifications` with type STUDENT_REPORT_TYPE and user_id = the student.
// Reports land in the admin queue (/admin/student-reports) only; an admin
// decides whether to forward one to the dev pipeline, which then becomes a
// normal SUPPORT_TYPE request created by that admin. Student rows never
// reach the dev watcher directly. The bell APIs exclude this type.
export const STUDENT_REPORT_TYPE = "student_report";
/** app_settings key; value {enabled: boolean}. Missing row = off. */
export const STUDENT_REPORTS_SETTING_KEY = "student_reports_enabled";
export const STUDENT_REPORT_NOTE_MAX = 500;

export const STUDENT_REPORT_KINDS = ["answer", "display", "technical", "other"] as const;
export type StudentReportKind = (typeof STUDENT_REPORT_KINDS)[number];

export const STUDENT_REPORT_KIND_LABEL: Record<StudentReportKind, string> = {
  answer: "Wrong answer or answer choices",
  display: "Figure or text display issue",
  technical: "Technical problem (saving, timer, etc.)",
  other: "Other",
};

/** Where the student was when they reported. */
export type StudentReportContext = "taking" | "results" | "review";

export const STUDENT_REPORT_CONTEXT_LABEL: Record<StudentReportContext, string> = {
  taking: "During the test",
  results: "Results page",
  review: "Class review page",
};

export type StudentReportStatus = "new" | "forwarded" | "dismissed";

export interface StudentReport {
  kind: StudentReportKind;
  status: StudentReportStatus;
  test_id: string;
  submission_id: string | null;
  module_id: string;
  question_id: string;
  /** The question's number in its module (original_question_number). */
  question_number: number | null;
  /** Position shown to the student on the take page (1-based), if any. */
  display_number: number | null;
  context: StudentReportContext;
  note: string;
  /** Reporter is a hidden QA account (lib/qa.ts). */
  qa: boolean;
  forwarded_request_id?: string;
  handled_by?: string;
  handled_by_name?: string;
  handled_at?: string;
}

export interface StudentReportRow {
  id: string;
  user_id: string;
  created_at: string;
  payload: StudentReport;
}
