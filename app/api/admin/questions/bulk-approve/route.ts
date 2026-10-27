import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { findParsePlaceholder, placeholderNote } from "@/lib/parse-guards";

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

  // Drop rows whose stem/choices still carry parser placeholder text: they
  // stay in (or move to) Needs Review with a note instead of being approved.
  async function excludePlaceholders(
    rows: { id: string; question_text: string | null; choices: unknown; parsing_notes: string | null }[],
  ): Promise<{ clean: string[]; blocked: number }> {
    const clean: string[] = [];
    let blocked = 0;
    for (const r of rows) {
      const placeholder = findParsePlaceholder(r.question_text, r.choices);
      if (!placeholder) {
        clean.push(r.id);
        continue;
      }
      blocked++;
      const base = (r.parsing_notes || "").trim();
      const note = placeholderNote(placeholder);
      await db
        .from("questions")
        .update({
          parsing_status: "Needs Review",
          parsing_notes: base && !base.includes("parser placeholder text") ? `${base}; ${note}` : note,
          updated_at: now,
        })
        .eq("id", r.id);
    }
    return { clean, blocked };
  }

  if (body.question_ids && Array.isArray(body.question_ids)) {
    const ids: string[] = body.question_ids;
    if (ids.length === 0) {
      return NextResponse.json({ error: "No question_ids provided" }, { status: 400 });
    }
    const { data: rows, error: selErr } = await db
      .from("questions")
      .select("id, question_text, choices, parsing_notes")
      .in("id", ids);
    if (selErr) {
      console.error("[bulk-approve] select error:", selErr);
      return NextResponse.json({ error: "Bulk approve failed" }, { status: 500 });
    }
    const { clean, blocked } = await excludePlaceholders(rows ?? []);
    if (clean.length === 0) {
      return NextResponse.json(
        { error: `None approved: ${blocked} question(s) contain parser placeholder text and were kept in Needs Review.`, blocked },
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

    return NextResponse.json({ approved: count ?? clean.length, blocked });
  }

  if (body.filter) {
    const { moduleId, minConfidence } = body.filter as {
      moduleId?: string;
      minConfidence?: number;
    };

    let query = db.from("questions").select("id, question_text, choices, parsing_notes");

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

    return NextResponse.json({ approved, blocked });
  }

  return NextResponse.json(
    { error: "Provide question_ids or filter" },
    { status: 400 }
  );
}
