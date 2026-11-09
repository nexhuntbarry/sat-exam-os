// Plain data the review-queue page hands to its client components (no
// functions, no server imports).

export type GroupId =
  | "key_dispute"
  | "module_key"
  | "key_format"
  | "ai_key"
  | "stem"
  | "figure"
  | "render"
  | "explanation"
  | "live_fix"
  | "ready"
  | "note";

export type Decision = "key" | "key_format" | "stem" | "figure" | "render" | "explanation" | "approve";

export interface QueueChoice {
  label: string;
  text: string;
  image_url?: string | null;
}

export interface QueueProposal {
  parts: string[];
  diffs: string[];
  pages: string;
  stored: { choices?: QueueChoice[]; table?: string; imageUrls?: string[] };
  pdf: { choices?: QueueChoice[]; table?: string; imageUrls?: string[] };
  /** The PDF crop may show the ✓ answer mark ("Use PDF version" is off). */
  checkMarkLeak?: boolean;
  /** The row changed since the comparison ("Use PDF version" is off). */
  stale?: boolean;
}

export interface EvidenceChip {
  label: string;
  value: string;
  tone: "agree" | "differ" | "neutral";
}

/** One field before / after a live-test change. */
export interface LiveFixChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface QueueLiveFix {
  /** What the tool or person changed, in its own words. */
  what: string;
  /** Changed fields from the recorded earlier version (empty: none recorded). */
  changes: LiveFixChange[];
  /** An earlier version is recorded (Undo is possible). */
  canUndo: boolean;
  /** The key before the change, when the change touched the key. */
  keyBefore: string | null;
  snapshotAt: string | null;
}

export interface QueueItem {
  id: string;
  /** Plain one-line decision ("Key says B, solving gives C"). */
  headline: string;
  /** Plain evidence ("PDF ✓: none · Code: C · Second solve: C · Saved key: B"). */
  evidence: EvidenceChip[];
  /** The answer "Use X" sets; strong = two independent checks / the PDF key. */
  suggestion: { answer: string; why: string; strong: boolean } | null;
  /** The reasons in plain words (the raw notes are in `reasons`, behind Details). */
  plainReasons: string[];
  /** Real (non-QA) students who answered it. */
  studentsAnswered: number;
  /** In a published test that is assigned now. */
  live: boolean;
  /** Where the key came from (lib/key-source.ts). */
  keySource: { label: string; detail: string; kind: string };
  /** Set for the "Fixed in a live test" group. */
  liveFix: QueueLiveFix | null;
  status: string;
  number: number | null;
  moduleId: string | null;
  moduleName: string;
  section: string | null;
  questionType: string | null;
  key: string | null;
  official: string | null;
  /** The key differs from the official answer: "Keep key" clears official_answer. */
  keyOverrulesOfficial: boolean;
  /** The other answer the notes propose (AI / official / audit). */
  alternative: { answer: string; source: string; ref?: string | null } | null;
  primary: GroupId;
  /** Other groups this question also needs (after the primary). */
  also: GroupId[];
  reasons: string[];
  stem: string;
  choices: QueueChoice[];
  pageNumber: number | null;
  hasPdf: boolean;
  updatedAt: string | null;
  proposal: QueueProposal | null;
}

export interface GroupSummary {
  id: GroupId;
  label: string;
  ask: string;
  decision: Decision;
  waiting: number;
  autoFixed: number;
  /** Other reasons the waiting questions also have: label → count. */
  alsoBlocked: { label: string; count: number }[];
}
