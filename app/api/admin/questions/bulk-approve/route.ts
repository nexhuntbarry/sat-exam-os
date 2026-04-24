import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/questions/bulk-approve
// Body: { question_ids: string[] } OR { filter: { moduleId?, minConfidence? } }
export async function POST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const body = await req.json().catch(() => ({}));
  const db = getServiceClient();

  const now = new Date().toISOString();
  const patch = {
    parsing_status: "Approved",
    reviewed_by: authResult.userId,
    reviewed_at: now,
    updated_at: now,
  };

  if (body.question_ids && Array.isArray(body.question_ids)) {
    const ids: string[] = body.question_ids;
    if (ids.length === 0) {
      return NextResponse.json({ error: "No question_ids provided" }, { status: 400 });
    }
    const { error, count } = await db
      .from("questions")
      .update(patch)
      .in("id", ids);

    if (error) {
      console.error("[bulk-approve] error:", error);
      return NextResponse.json({ error: "Bulk approve failed" }, { status: 500 });
    }

    return NextResponse.json({ approved: count ?? ids.length });
  }

  if (body.filter) {
    const { moduleId, minConfidence } = body.filter as {
      moduleId?: string;
      minConfidence?: number;
    };

    let query = db.from("questions").update(patch);

    if (moduleId) query = query.eq("module_id", moduleId);
    if (minConfidence !== undefined) {
      query = query.gte("ai_confidence_score", minConfidence);
    }
    // Only approve non-rejected drafts and needs-review items
    query = query.in("parsing_status", ["Draft", "Needs Review"]);

    const { error, count } = await query;

    if (error) {
      console.error("[bulk-approve] filter error:", error);
      return NextResponse.json({ error: "Bulk approve failed" }, { status: 500 });
    }

    return NextResponse.json({ approved: count ?? 0 });
  }

  return NextResponse.json(
    { error: "Provide question_ids or filter" },
    { status: 400 }
  );
}
