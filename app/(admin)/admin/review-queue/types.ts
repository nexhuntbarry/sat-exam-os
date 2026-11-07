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
  | "other";

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
}

export interface QueueItem {
  id: string;
  number: number | null;
  moduleId: string | null;
  moduleName: string;
  section: string | null;
  questionType: string | null;
  key: string | null;
  official: string | null;
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
