// Students are only served Approved questions, so a test module is
// usable only once every non-rejected question in it is Approved.
// Keep in sync with moduleApprovalError in app/api/admin/_shared.ts.
export interface ApprovalCounts {
  approved: number;
  /** Non-rejected questions (what grading would count). */
  total: number;
}

export function approvalCounts(questions: { parsing_status: string }[] | null): ApprovalCounts {
  const live = (questions ?? []).filter((q) => q.parsing_status !== "Rejected");
  return {
    approved: live.filter((q) => q.parsing_status === "Approved").length,
    total: live.length,
  };
}

export function isFullyApproved(c: ApprovalCounts): boolean {
  return c.approved > 0 && c.approved === c.total;
}
