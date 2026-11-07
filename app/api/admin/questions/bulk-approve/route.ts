import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { findApproveBlocker } from "@/lib/parse-guards";
import { clearReviewTags, hasReviewTags } from "@/lib/key-doubt";

// POST /api/admin/questions/bulk-approve
// Body: { question_ids: string[] } OR { filter: { moduleId?, minConfidence? } }
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

  // Drop rows whose stem/choices still carry parser placeholder text or look
  // cut off: they stay in (or move to) Needs Review with a note instead of
  // being approved.
  async function excludePlaceholders(
    rows: { id: string; question_text: string | null; choices: unknown; question_type: string | null; correct_answer: string | null; parsing_notes: string | null }[],
  ): Promise<{ clean: string[]; blocked: number }> {
    const clean: string[] = [];
    let blocked = 0;
    for (const r of rows) {
      const blocker = findApproveBlocker(r.question_text, r.choices, r.question_type, r.correct_answer);
      if (!blocker) {
        clean.push(r.id);
        continue;
      }
      blocked++;
      const base = (r.parsing_notes || "").trim();
      await db
        .from("questions")
        .update({
          parsing_status: "Needs Review",
          parsing_notes: base && !base.includes(blocker.note) ? `${base}; ${blocker.note}` : blocker.note,
          updated_at: now,
        })
        .eq("id", r.id);
    }
    return { clean, blocked };
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
      .select("id, question_text, choices, question_type, correct_answer, parsing_notes")
      .in("id", ids);
    if (selErr) {
      console.error("[bulk-approve] select error:", selErr);
      return NextResponse.json({ error: "Bulk approve failed" }, { status: 500 });
    }
    const { clean, blocked } = await excludePlaceholders(rows ?? []);
    if (clean.length === 0) {
      return NextResponse.json(
        { error: `None approved: ${blocked} question(s) contain parser placeholder text, look cut off, or have an answer key that does not fit the question type, and were kept in Needs Review.`, blocked },
        { status: 400 },
      );
    }
    const { error, count } = await db
      .from("questions")
      .update(patch)
      .in("id", clean);

    if (error) {
      console.error("[bulk-approve] error:", error);
      return NextResponse.json({ error: "Bulk approve failed" }, { status: 500 });
    }
    await clearLiveFixTags(rows ?? [], clean);

    return NextResponse.json({ approved: count ?? clean.length, blocked });
  }

  if (body.filter) {
    const { moduleId, minConfidence } = body.filter as {
      moduleId?: string;
      minConfidence?: number;
    };

    let query = db.from("questions").select("id, question_text, choices, question_type, correct_answer, parsing_notes");

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
      const { error } = await db.from("questions").update(patch).in("id", chunk);
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
