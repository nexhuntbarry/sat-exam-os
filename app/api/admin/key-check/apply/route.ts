import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { KEY_FORM_NOTE_PREFIX, keyTypeProblem } from "@/lib/answer-key";
import { LIVE_FIX_TAG, liveQuestionIds, stripLiveFixNote } from "@/lib/live-questions";
import { explainOneAnswer } from "@/lib/ai/solve-question";
import { rescoreQuestion } from "@/lib/rescore";

// The explanation is regenerated for a new key (one AI call).
export const maxDuration = 120;

// POST /api/admin/key-check/apply
// Body: { id, correct_answer?, question_type?, clear_choices?, expected_key, rescore }
//
// Applies one answer-key / type correction from the key-check page AFTER the
// admin saw the preview. `expected_key` is the key the preview was made for
// (409 if it changed since). Rescoring runs only when `rescore` is true — the
// admin's explicit confirm on the preview. The status is never lowered: a
// question in a live test (Published + assigned) stays Approved and gets a
// [live-fix] note; any other question keeps its status.
export async function POST(req: Request) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const qaBlock = forbidQa(auth);
  if (qaBlock) return qaBlock;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const db = getServiceClient();
  const { data: q } = await db
    .from("questions")
    .select("id, question_text, choices, question_type, correct_answer, parsing_status, parsing_notes")
    .eq("id", id)
    .maybeSingle();
  if (!q) return NextResponse.json({ error: "Question not found" }, { status: 404 });
  if ((q.correct_answer ?? null) !== (body.expected_key ?? null)) {
    return NextResponse.json(
      { error: "The key changed since the preview. Reload the page and preview again." },
      { status: 409 },
    );
  }

  const oldKey = (q.correct_answer as string | null) ?? null;
  const nextType = typeof body.question_type === "string" ? body.question_type : (q.question_type as string | null);
  const nextKey = typeof body.correct_answer === "string" ? body.correct_answer.trim() : oldKey;
  const nextChoices = body.clear_choices || nextType === "Student Produced Response" ? [] : q.choices;
  const problem = keyTypeProblem({ question_type: nextType, correct_answer: nextKey, question_text: q.question_text as string | null, choices: nextChoices });
  if (problem) {
    return NextResponse.json({ error: `This correction still doesn't fit: ${problem.reason}.` }, { status: 400 });
  }
  const keyChanged = (oldKey ?? "") !== (nextKey ?? "");
  if (keyChanged && body.rescore !== true) {
    return NextResponse.json(
      { error: "Changing the key needs the rescoring confirm from the preview." },
      { status: 400 },
    );
  }

  const live = q.parsing_status === "Approved" ? (await liveQuestionIds(db, [id])).has(id) : false;
  const changes = [
    nextType !== q.question_type ? `type ${q.question_type ?? "∅"} → ${nextType}` : null,
    keyChanged ? `key ${oldKey ?? "∅"} → ${nextKey}` : null,
    Array.isArray(q.choices) && q.choices.length > 0 && (nextChoices as unknown[]).length === 0 ? "choices removed" : null,
  ].filter(Boolean);
  const kept = stripLiveFixNote((q.parsing_notes as string | null) ?? "")
    ?.split(/;\s*/)
    .filter((s) => s && !s.startsWith(KEY_FORM_NOTE_PREFIX))
    .join("; ");
  const fixNote = `Answer key check: ${changes.join(", ")} (applied by an admin)`;
  // Notes are "; "-separated; the [live-fix] sentence leads (the format
  // stripLiveFixNote expects). An identical fix note isn't added twice.
  const noteBody = [...(kept ? kept.split(/;\s*/) : []), fixNote]
    .filter((s, i, all) => s && all.indexOf(s) === i)
    .join("; ");
  const notes = live
    ? `${LIVE_FIX_TAG} Key/type corrected while this question is in a live test; kept Approved — please re-check. ${noteBody}`
    : noteBody;

  const { error } = await db
    .from("questions")
    .update({
      question_type: nextType,
      correct_answer: nextKey,
      choices: nextChoices,
      parsing_notes: notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error("[key-check/apply] update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  // The old explanation argued the old key: write one for the new key.
  let explanationUpdated = false;
  if (keyChanged && nextKey) {
    try {
      explanationUpdated = !!(await explainOneAnswer(id, nextKey, db, auth.userId));
    } catch (e) {
      console.error("[key-check/apply] explanation regen failed:", e);
    }
  }

  let rescore = null;
  if (keyChanged) {
    try {
      rescore = await rescoreQuestion(db, id);
    } catch (e) {
      console.error("[key-check/apply] rescore failed:", e);
      return NextResponse.json({ ok: true, live, explanationUpdated, rescoreError: "Rescoring failed — run it again from the question page." });
    }
  }
  return NextResponse.json({ ok: true, live, explanationUpdated, rescore });
}
