import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { applyKeyCorrection } from "@/lib/key-change";

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
// [live-fix] note; any other question keeps its status. Notes about the old
// key are dropped (lib/key-change.ts).
export async function POST(req: Request) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const qaBlock = forbidQa(auth);
  if (qaBlock) return qaBlock;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const res = await applyKeyCorrection(getServiceClient(), {
    id,
    correct_answer: typeof body.correct_answer === "string" ? body.correct_answer : undefined,
    question_type: typeof body.question_type === "string" ? body.question_type : undefined,
    clear_choices: !!body.clear_choices,
    expectedKey: body.expected_key ?? null,
    rescore: body.rescore === true,
    userId: auth.userId,
    source: "an admin",
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  if (res.rescoreError) {
    return NextResponse.json({ ok: true, live: res.live, explanationUpdated: res.explanationUpdated, rescoreError: res.rescoreError });
  }
  return NextResponse.json({ ok: true, live: res.live, explanationUpdated: res.explanationUpdated, rescore: res.rescore });
}
