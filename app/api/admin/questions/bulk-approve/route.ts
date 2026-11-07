import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { BULK_APPROVE_STATUSES, planBulkApprove, type BulkApproveRow } from "@/lib/bulk-approve";
import { liveQuestionIds } from "@/lib/live-questions";
import { clearReviewTags, hasReviewTags } from "@/lib/key-doubt";

// POST /api/admin/questions/bulk-approve
// Body: { question_ids: string[] } OR { filter: { moduleId?, minConfidence? } }
// Only Draft / Needs Review rows are approved; anything else is left alone.
export async function POST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;

  const body = await req.json().catch(() => ({}));
  const db = getServiceClient();

  const now = new Date().toISOString();
  const patch = {
    parsing_status: "Approved",
    reviewed_by: authResult.userId,
    reviewed_at: now,
    updated_at: now,
  };

  // Draft / Needs Review rows with a blocker stay in (or move to) Needs
  // Review with a note instead of being approved (lib/bulk-approve.ts).
  // Already-Approved rows are never touched, and any hold goes through the
  // live-test guard so a question in a running exam is never demoted.
  async function excludePlaceholders(rows: BulkApproveRow[]): Promise<{ clean: string[]; blocked: number; skipped: number }> {
    const live = await liveQuestionIds(db, rows.map((r) => r.id));
    const plan = planBulkApprove(rows, live, now);
    for (const h of plan.holds) {
      await db
        .from("questions")
        .update(h.update)
        .eq("id", h.id)
        .in("parsing_status", [...BULK_APPROVE_STATUSES]);
    }
    return { clean: plan.clean, blocked: plan.holds.length, skipped: plan.skipped.length };
  }

  // Approving clears the live-test re-check tag and key doubts on the approved rows.
  async function clearLiveFixTags(
    rows: { id: string; parsing_notes: string | null }[],
    approvedIds: string[],
  ) {
    const approved = new Set(approvedIds);
    for (const r of rows) {
      if (!approved.has(r.id) || !hasReviewTags(r.parsing_notes)) continue;
      await db.from("questions").update({ parsing_notes: clearReviewTags(r.parsing_notes) }).eq("id", r.id);
    }
  }

  if (body.question_ids && Array.isArray(body.question_ids)) {
    const ids: string[] = body.question_ids;
    if (ids.length === 0) {
      return NextResponse.json({ error: "No question_ids provided" }, { status: 400 });
    }
    const { data: rows, error: selErr } = await db
      .from("questions")
      .select("id, question_text, choices, question_type, correct_answer, official_answer, explanation, parsing_status, parsing_notes")
      .in("id", ids)
      .in("parsing_status", [...BULK_APPROVE_STATUSES]);
    if (selErr) {
      console.error("[bulk-approve] select error:", selErr);
      return NextResponse.json({ error: "Bulk approve failed" }, { status: 500 });
    }
    const { clean, blocked } = await excludePlaceholders(rows ?? []);
    // Selected rows that aren't Draft / Needs Review (already Approved,
    // Rejected) are skipped untouched.
    const skipped = ids.length - (rows ?? []).length;
    if (clean.length === 0) {
      const error = blocked > 0
        ? `None approved: ${blocked} question(s) contain parser placeholder text, look cut off, or have an answer key that does not fit the question type, and were kept in Needs Review.`
        : "None approved: the selected questions are not Draft or Needs Review.";
      return NextResponse.json({ error, blocked, skipped }, { status: 400 });
    }
    const { error, count } = await db
      .from("questions")
      .update(patch, { count: "exact" })
      .in("id", clean)
      .in("parsing_status", [...BULK_APPROVE_STATUSES]);

    if (error) {
      console.error("[bulk-approve] error:", error);
      return NextResponse.json({ error: "Bulk approve failed" }, { status: 500 });
    }
    await clearLiveFixTags(rows ?? [], clean);

    return NextResponse.json({ approved: count ?? clean.length, blocked, skipped });
  }

  if (body.filter) {
    const { moduleId, minConfidence } = body.filter as {
      moduleId?: string;
      minConfidence?: number;
    };

    let query = db.from("questions").select("id, question_text, choices, question_type, correct_answer, official_answer, explanation, parsing_status, parsing_notes");

    if (moduleId) query = query.eq("module_id", moduleId);
    if (minConfidence !== undefined) {
      query = query.gte("ai_confidence_score", minConfidence);
    }
    // Only approve non-rejected drafts and needs-review items
    query = query.in("parsing_status", ["Draft", "Needs Review"]);

    const { data: rows, error: selErr } = await query;
    if (selErr) {
      console.error("[bulk-approve] filter select error:", selErr);
      return NextResponse.json({ error: "Bulk approve failed" }, { status: 500 });
    }
    const { clean, blocked } = await excludePlaceholders(rows ?? []);

    let approved = 0;
    const CHUNK = 100;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const chunk = clean.slice(i, i + CHUNK);
      const { error } = await db.from("questions").update(patch).in("id", chunk).in("parsing_status", [...BULK_APPROVE_STATUSES]);
      if (error) {
        console.error("[bulk-approve] filter error:", error);
        return NextResponse.json({ error: "Bulk approve failed", approved, blocked }, { status: 500 });
      }
      approved += chunk.length;
    }
    await clearLiveFixTags(rows ?? [], clean);

    return NextResponse.json({ approved, blocked });
  }

  return NextResponse.json(
    { error: "Provide question_ids or filter" },
    { status: 400 }
  );
}
