import { cn } from "@/components/ui/data-table/cn";
import { SUBJECT_COLORS, subjectKind } from "@/lib/subject-colors";

// One vocabulary and one colour per status, everywhere (docs/table-standard.md
// rule 6). Red is reserved for errors and destructive actions, so no status
// here uses it.

type Tone = "neutral" | "active" | "success" | "warning" | "dark";

const TONE: Record<Tone, string> = {
  neutral: "bg-light-bg text-mid-gray border-divider",
  active: "bg-status-info/10 text-status-info border-status-info/20",
  success: "bg-status-success/10 text-status-success border-status-success/20",
  warning: "bg-status-warning/10 text-status-warning border-status-warning/25",
  dark: "bg-charcoal/[0.07] text-charcoal border-charcoal/15",
};

/** Incomplete = Module 2 closed without being opened (lib/module2-not-taken). */
export type AttemptStatus = "Not started" | "In progress" | "Submitted" | "Late" | "Incomplete";
export type TestStatus = "Draft" | "Published" | "Closed";
export type ModuleStatus = "Draft" | "In review" | "Ready";
export type StudentStatus = "Pending" | "Active" | "Suspended";
/** questions.parsing_status ("Needs Review" is shown as "Needs review"). */
export type QuestionStatus = "Draft" | "Needs Review" | "Approved" | "Rejected";
/** Bug reports (Open / Resolved) and Report a Problem requests. */
export type ReportStatus = "Open" | "Resolved" | "Received" | "Fixing" | "Needs approval" | "Fixed" | "Closed";

const ATTEMPT: Record<AttemptStatus, Tone> = {
  "Not started": "neutral",
  "In progress": "active",
  Submitted: "success",
  Late: "warning",
  Incomplete: "warning",
};
const TEST: Record<TestStatus, Tone> = { Draft: "neutral", Published: "success", Closed: "dark" };
const MODULE: Record<ModuleStatus, Tone> = { Draft: "neutral", "In review": "warning", Ready: "success" };
const STUDENT: Record<StudentStatus, Tone> = { Pending: "warning", Active: "success", Suspended: "dark" };
const QUESTION: Record<QuestionStatus, Tone> = {
  Draft: "neutral",
  "Needs Review": "warning",
  Approved: "success",
  Rejected: "dark",
};
const REPORT: Record<ReportStatus, Tone> = {
  Open: "warning",
  Resolved: "success",
  Received: "neutral",
  Fixing: "active",
  "Needs approval": "warning",
  Fixed: "success",
  Closed: "dark",
};

/** users.account_status → the label admins see. */
export function studentStatusLabel(accountStatus: string): StudentStatus {
  if (accountStatus === "approved") return "Active";
  if (accountStatus === "suspended") return "Suspended";
  return "Pending";
}

/** submissions.status / progress status → attempt label. */
export function attemptStatusLabel(status: string): AttemptStatus {
  if (status === "In Progress" || status === "In progress") return "In progress";
  if (status === "Late") return "Late";
  if (status === "Not started") return "Not started";
  if (status === "Incomplete") return "Incomplete";
  return "Submitted";
}

type Props = { className?: string; title?: string; label?: string } & (
  | { kind: "attempt"; status: AttemptStatus; module?: { n: number; of: number } | null }
  | { kind: "test"; status: TestStatus }
  | { kind: "module"; status: ModuleStatus; count?: number }
  | { kind: "student"; status: StudentStatus }
  | { kind: "question"; status: QuestionStatus }
  | { kind: "report"; status: ReportStatus }
);

/** Status pill. `label` overrides the text (e.g. a translation) but never
 *  the colour, which always comes from the status. */
export function StatusBadge(props: Props) {
  let tone: Tone;
  let text: string;
  switch (props.kind) {
    case "attempt":
      tone = ATTEMPT[props.status];
      text =
        props.status === "In progress" && props.module && props.module.of > 1
          ? `In progress (Module ${props.module.n} of ${props.module.of})`
          : props.status === "Incomplete"
            ? "Incomplete · Module 2 not taken"
            : props.status;
      break;
    case "test":
      tone = TEST[props.status] ?? "neutral";
      text = props.status;
      break;
    case "module":
      tone = MODULE[props.status];
      text = props.status === "In review" && props.count ? `In review (${props.count})` : props.status;
      break;
    case "student":
      tone = STUDENT[props.status];
      text = props.status;
      break;
    case "question":
      tone = QUESTION[props.status] ?? "neutral";
      text = props.status === "Needs Review" ? "Needs review" : props.status;
      break;
    case "report":
      tone = REPORT[props.status] ?? "neutral";
      text = props.status;
      break;
  }
  return (
    <span
      title={props.title}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-4",
        TONE[tone],
        props.className,
      )}
    >
      {props.label ?? text}
    </span>
  );
}

/**
 * Subject as a small filled tag, one colour per subject (lib/subject-colors.ts):
 * "Math" (blue), "R&W" (gold), "Full-length" (navy). `section` takes the DB
 * value ("Math" / "Reading & Writing") or a short form; pass `fullLength` for
 * a full-length SAT. `label` overrides the text (e.g. a translated name).
 * Unknown sections fall back to a neutral chip with the raw text.
 */
export function SubjectTag({
  section,
  fullLength,
  label,
  className,
}: {
  section?: string | null;
  fullLength?: boolean;
  label?: string;
  className?: string;
}) {
  const kind = subjectKind(section, fullLength);
  if (!kind && !section) return null;
  const text = label ?? (kind === "math" ? "Math" : kind === "rw" ? "R&W" : kind === "full" ? "Full-length" : section);
  const c = kind ? SUBJECT_COLORS[kind] : null;
  return (
    <span
      title={kind === "rw" ? "Reading & Writing" : kind === "full" ? (label ?? "Full-length SAT") : (section ?? undefined)}
      style={{
        ...(c ? { backgroundColor: c.bg, color: c.text, borderColor: c.border } : {}),
        // Keep the fill when printed (browsers drop backgrounds by default).
        printColorAdjust: "exact",
        WebkitPrintColorAdjust: "exact",
      }}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border px-2 text-xs font-semibold leading-5",
        !c && "border-divider bg-surface text-mid-gray",
        className,
      )}
    >
      {text}
    </span>
  );
}
