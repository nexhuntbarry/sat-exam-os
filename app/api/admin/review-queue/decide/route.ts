import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { decide, type DecideAction } from "@/lib/review-decide";

// One AI explanation call (with a retry), plus rescoring on a key change.
export const maxDuration = 300;

// POST /api/admin/review-queue/decide
// Body: { id, action, updated_at?, key?, expected_key?, rescore?, question_text? }
//
// Applies the one decision the review queue asked for (lib/review-decide.ts):
//   keep_key | set_key (after the rescore preview) | use_pdf | keep_figure |
//   use_pdf_text | regen_explanation | approve
// then regenerates the explanation when needed, clears the settled notes and
// approves the question when nothing else blocks. Never lowers a status.
export async function POST(req: Request) {
  const auth = await requireQuestionReviewer();
  if (auth instanceof NextResponse) return auth;
  const qaBlock = forbidQa(auth);
  if (qaBlock) return qaBlock;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let act: DecideAction;
  switch (body.action) {
    case "keep_key":
    case "use_pdf":
    case "keep_figure":
    case "regen_explanation":
    case "approve":
      act = { action: body.action };
      break;
    case "set_key": {
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key) return NextResponse.json({ error: "Enter the new key." }, { status: 400 });
      act = { action: "set_key", key, expectedKey: body.expected_key ?? null, rescore: body.rescore === true };
      break;
    }
    case "use_pdf_text": {
      const text = typeof body.question_text === "string" ? body.question_text : "";
      act = { action: "use_pdf_text", questionText: text };
      break;
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  try {
    const res = await decide(getServiceClient(), id, act, {
      userId: auth.userId,
      expectedUpdatedAt: typeof body.updated_at === "string" ? body.updated_at : null,
    });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 });
    return NextResponse.json(res);
  } catch (e) {
    console.error("[review-queue/decide] error:", e);
    return NextResponse.json({ error: "Something went wrong. Try again or open the question." }, { status: 500 });
  }
}
