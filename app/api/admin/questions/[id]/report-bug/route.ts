import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/questions/[id]/report-bug
//
// Reviewer-triggered "this question is broken — please fix" report.
// Inserts a row into bug_reports and fires a best-effort Telegram
// ping to the dev chat. Both side effects are isolated so a failed
// Telegram ping doesn't block the DB row.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  let body: { note?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* no body is fine */
  }

  const db = getServiceClient();
  const { data: q, error: qErr } = await db
    .from("questions")
    .select(
      "id, module_id, original_question_number, parsing_status, modules(module_name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (qErr || !q) {
    return NextResponse.json(
      { ok: false, message: "Question not found" },
      { status: 404 },
    );
  }

  const { error: insErr, data: inserted } = await db
    .from("bug_reports")
    .insert({
      question_id: id,
      module_id: q.module_id,
      reporter_user_id: authResult.userId,
      note: body.note?.trim() || null,
    })
    .select("id, created_at")
    .single();
  if (insErr) {
    return NextResponse.json(
      { ok: false, message: insErr.message },
      { status: 500 },
    );
  }

  // Best-effort Telegram ping. Failures don't block the response —
  // the bug_reports row is still durable.
  await notifyDevViaTelegram({
    questionId: id,
    questionNumber: q.original_question_number as number | null,
    moduleName: (q.modules as unknown as { module_name?: string } | null)?.module_name ?? null,
    parsingStatus: q.parsing_status as string,
    reporterUserId: authResult.userId,
    note: body.note?.trim() ?? null,
  });

  return NextResponse.json({
    ok: true,
    message:
      "Report sent. The dev team will follow up. You can keep reviewing the next question.",
    data: inserted,
  });
}

async function notifyDevViaTelegram(input: {
  questionId: string;
  questionNumber: number | null;
  moduleName: string | null;
  parsingStatus: string;
  reporterUserId: string;
  note: string | null;
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_DEV_CHAT_ID;
  if (!token || !chatId) return;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const url = appUrl
    ? `${appUrl.replace(/\/$/, "")}/admin/questions/${input.questionId}`
    : null;
  const text = [
    "🐛 SAT Question Bug Report",
    "",
    `Module: ${input.moduleName ?? "(unknown)"}`,
    `Question: Q${input.questionNumber ?? "?"}`,
    `Current status: ${input.parsingStatus}`,
    input.note ? `Note: ${input.note}` : null,
    url ? `Link: ${url}` : null,
    `Question ID: ${input.questionId}`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error("[report-bug] telegram notify failed:", e);
  }
}
