// Per-question outcome of comparing a question with its module's source PDF
// after an admin replaced that PDF ("Replace source PDF", module page).
// Stored as a tagged parsing_notes segment, like "[live-fix]" and the key
// doubt. Kept free of server imports: the question table (client) reads it.
//
//   [pdf-pending]  replaced, not compared yet
//   [pdf-match]    matches the new PDF — review UI shows a "Matches PDF" badge
//   [pdf-diff]     differs — starts "Needs review:" so no automatic path
//                  approves it; a person approving clears it

export const PDF_PENDING_TAG = "[pdf-pending]";
export const PDF_MATCH_TAG = "[pdf-match]";
export const PDF_DIFF_TAG = "[pdf-diff]";

const ANY_PDF_TAG = /\s*;?\s*\[pdf-(?:pending|match|diff)\][^;]*/g;
const tidy = (s: string) => s.replace(/^[\s;]+|[\s;]+$/g, "").replace(/;\s*;/g, ";");

export function pdfPendingNote(): string {
  return `${PDF_PENDING_TAG} Not yet compared with the replaced source PDF.`;
}

export function pdfMatchNote(date = new Date()): string {
  return `${PDF_MATCH_TAG} Matches the source PDF (checked ${date.toISOString().slice(0, 10)}).`;
}

/** `what` lists the differences; ";" is the notes separator so it is replaced. */
export function pdfDiffNote(what: string): string {
  const clean = what.replace(/;/g, ",").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return `${PDF_DIFF_TAG} Needs review: differs from the replaced source PDF — ${clean}.`;
}

/** Remove every pdf-check segment (any of the three tags). */
export function stripPdfTags(notes: string | null | undefined): string {
  return tidy((notes ?? "").replace(ANY_PDF_TAG, ""));
}

/** Replace any existing pdf-check segment with `note` (appended last). */
export function withPdfNote(notes: string | null | undefined, note: string): string {
  const base = stripPdfTags(notes);
  return base ? `${base}; ${note}` : note;
}

export type PdfCheckState = "pending" | "match" | "diff" | null;

export function pdfCheckState(notes: string | null | undefined): PdfCheckState {
  const n = notes ?? "";
  if (n.includes(PDF_DIFF_TAG)) return "diff";
  if (n.includes(PDF_PENDING_TAG)) return "pending";
  if (n.includes(PDF_MATCH_TAG)) return "match";
  return null;
}

/** A person approved the row: drop "differs" / "pending", keep "matches". */
export function stripPdfReviewTags(notes: string | null | undefined): string {
  return tidy((notes ?? "").replace(/\s*;?\s*\[pdf-(?:pending|diff)\][^;]*/g, ""));
}

export function hasPdfReviewTags(notes: string | null | undefined): boolean {
  const n = notes ?? "";
  return n.includes(PDF_DIFF_TAG) || n.includes(PDF_PENDING_TAG);
}
