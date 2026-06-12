import { NextResponse, after } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import {
  repairMathForQuestion,
  repairImageForQuestion,
} from "@/lib/repair-ops";

// Auto-resolver work can run two AI ladders + a sharp crop +
// blob uploads — give it the same 60s ceiling the repair endpoints
// already use.
export const maxDuration = 60;

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

  // Hand off to background auto-resolver. Next.js' after() runs
  // the callback once the response has been sent so the admin
  // doesn't wait on AI calls. The auto-resolver inspects the row,
  // tries the right repair op (math vs image), and pings Telegram
  // again with the result.
  after(async () => {
    try {
      const result = await autoResolveBugReport(id);
      await notifyDevViaTelegram({
        questionId: id,
        questionNumber: q.original_question_number as number | null,
        moduleName:
          (q.modules as unknown as { module_name?: string } | null)
            ?.module_name ?? null,
        parsingStatus: result.newStatus ?? (q.parsing_status as string),
        reporterUserId: authResult.userId,
        note: null,
        autoResolveSummary: result.summary,
      });
      // Mark the bug report as resolved when at least one repair op
      // actually changed something, so the dev queue doesn't keep
      // listing rows the bot already fixed.
      if (result.touched && inserted?.id) {
        await db
          .from("bug_reports")
          .update({
            status: "resolved",
            resolved_at: new Date().toISOString(),
          })
          .eq("id", inserted.id);
      }
    } catch (e) {
      console.error("[report-bug] auto-resolve crashed:", e);
    }
  });

  return NextResponse.json({
    ok: true,
    message:
      "Report sent. The dev team will look at this question and Telegram you when it's resolved. You can keep reviewing the next question.",
    data: inserted,
  });
}

/**
 * Inspect the question's current state and run the right repair op
 * automatically. Heuristic:
 *   - If has_image=true AND image_urls is empty → repairImageForQuestion
 *   - If parsing_notes references math / table / render / contains-prose
 *     → repairMathForQuestion
 *   - Otherwise nothing to do; flagged for human follow-up
 *
 * Returns a short prose summary suitable for Telegram + a boolean
 * saying whether any DB write happened.
 */
async function autoResolveBugReport(questionId: string): Promise<{
  summary: string;
  newStatus: string | null;
  touched: boolean;
}> {
  const db = getServiceClient();
  const { data: q } = await db
    .from("questions")
    .select(
      "id, parsing_status, parsing_notes, has_image, image_urls, question_text, choices, explanation",
    )
    .eq("id", questionId)
    .maybeSingle();
  if (!q) {
    return { summary: "Question not found.", newStatus: null, touched: false };
  }

  const notes = (q.parsing_notes as string | null) ?? "";
  const wantsImageFix =
    q.has_image === true &&
    (!Array.isArray(q.image_urls) || q.image_urls.length === 0);
  const wantsMathFix =
    /math-render-failed|math-unwrapped|math-contains-prose|has-table-flag-but-no-table-in-text|pipe-flattened-table|blank-artifact/i.test(
      notes,
    ) ||
    /Mismatch:|Possible duplicate/i.test(notes);

  if (!wantsImageFix && !wantsMathFix) {
    // No automatic repair path is obviously safe. Tell the dev to
    // look manually.
    return {
      summary:
        "No automatic repair path matched the audit notes. A dev needs to look at this question manually.",
      newStatus: q.parsing_status as string,
      touched: false,
    };
  }

  const parts: string[] = [];
  let lastStatus = q.parsing_status as string;

  if (wantsImageFix) {
    try {
      const r = await repairImageForQuestion(questionId);
      parts.push(`Image: ${r.message}`);
      if (r.ok) lastStatus = "Draft";
    } catch (e) {
      parts.push(
        `Image fix crashed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (wantsMathFix) {
    try {
      const r = await repairMathForQuestion(questionId);
      parts.push(`Math: ${r.message}`);
      if (r.ok) lastStatus = "Draft";
    } catch (e) {
      parts.push(
        `Math fix crashed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    summary: parts.join(" · "),
    newStatus: lastStatus,
    touched: parts.some((p) => p.includes("Math:") || p.includes("Image:")),
  };
}

async function notifyDevViaTelegram(input: {
  questionId: string;
  questionNumber: number | null;
  moduleName: string | null;
  parsingStatus: string;
  reporterUserId: string;
  note: string | null;
  autoResolveSummary?: string;
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_DEV_CHAT_ID;
  if (!token || !chatId) return;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const url = appUrl
    ? `${appUrl.replace(/\/$/, "")}/admin/questions/${input.questionId}`
    : null;
  const headline = input.autoResolveSummary
    ? "🔧 Auto-fix result"
    : "🐛 SAT Question Bug Report";
  const text = [
    headline,
    "",
    `Module: ${input.moduleName ?? "(unknown)"}`,
    `Question: Q${input.questionNumber ?? "?"}`,
    `Current status: ${input.parsingStatus}`,
    input.note ? `Note: ${input.note}` : null,
    input.autoResolveSummary ? `Result: ${input.autoResolveSummary}` : null,
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
