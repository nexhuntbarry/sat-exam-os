import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/questions/[id]/resolve-mismatch
//
// Body: { trust: "ai" | "official" }
//
// One-click resolver for the cross-check mismatch flow. After parse +
// solver runs, every question that disagreed with the answer key is
// flagged with mismatch_with_official=true and parsing_status="Needs
// Review". The admin reviews both answers + AI explanation, then picks
// which one to trust:
//   - "ai":       correct_answer ← the value parsed out of the
//                 "AI: X, official: Y" hint embedded in parsing_notes;
//                 mismatch_with_official cleared; status → Approved.
//   - "official": correct_answer is already official (parse-time
//                 reconciliation overwrote it); we just clear the
//                 mismatch flag and approve.
//
// Returns the updated question row so the client can refresh in place.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const reviewer = authResult;

  const { id } = await params;
  let body: { trust?: "ai" | "official" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.trust !== "ai" && body.trust !== "official") {
    return NextResponse.json(
      { error: "trust must be 'ai' or 'official'" },
      { status: 400 },
    );
  }

  const db = getServiceClient();
  const { data: q, error: fetchErr } = await db
    .from("questions")
    .select(
      "id, correct_answer, official_answer, parsing_notes, mismatch_with_official",
    )
    .eq("id", id)
    .single();

  if (fetchErr || !q) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  if (!q.mismatch_with_official) {
    return NextResponse.json(
      { error: "This question is not flagged as mismatched" },
      { status: 409 },
    );
  }

  const update: Record<string, unknown> = {
    mismatch_with_official: false,
    parsing_status: "Approved",
    reviewed_by: reviewer.userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Strip the trailing "; Mismatch: AI answered X, official Y" segment
  // from parsing_notes so the resolved hint doesn't clutter future
  // displays. Other notes (Low confidence, etc.) are preserved.
  if (typeof q.parsing_notes === "string") {
    const cleaned = q.parsing_notes
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !/^Mismatch:/i.test(s))
      .join("; ");
    update.parsing_notes = cleaned || null;
  }

  if (body.trust === "ai") {
    const aiAns = parseAiAnswerFromNotes(q.parsing_notes as string | null);
    if (!aiAns) {
      return NextResponse.json(
        { error: "Could not recover AI's answer from parsing_notes" },
        { status: 422 },
      );
    }
    update.correct_answer = aiAns;
    // We're overruling the answer key: drop official_answer so the
    // student-facing UI never shows the rejected official as a hint.
    update.official_answer = null;
  }
  // trust === "official": correct_answer is already the official value
  // from parse-time reconciliation. Nothing to change there.

  const { data: updated, error: updateErr } = await db
    .from("questions")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateErr || !updated) {
    console.error("[resolve-mismatch] update error:", updateErr);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ data: updated });
}

/**
 * Pull the AI's answer out of a "Mismatch: AI answered X, official Y"
 * snippet inside parsing_notes. Tolerant of multiple notes joined by
 * "; ". Returns null when no AI answer is recoverable.
 */
function parseAiAnswerFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const m = notes.match(/Mismatch:\s*AI answered\s+([^,;]+?)\s*,\s*official/i);
  return m ? m[1].trim() : null;
}
