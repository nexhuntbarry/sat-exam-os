import { NextResponse, after } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import {
  repairMathForQuestion,
  repairImageForQuestion,
  repairTableForQuestion,
  hasMarkdownTable,
} from "@/lib/repair-ops";
import { CHECKS, type AuditRow } from "@/lib/post-parse-cleanup";
import { stemFigureMissing } from "@/lib/parse-guards";
import { notifyBugReportResolved } from "@/lib/notifications";
import { bugReportSupportBody, createSupportRequest, findSupportForBugReport, resolveBugReportThread } from "@/lib/support";
import { uploadScreenshots } from "@/app/api/admin/support/upload";

const AUDIT_COLS =
  "id, parsing_status, parsing_notes, section, question_type, correct_answer, has_image, has_table, image_urls, question_text, choices, explanation";

// Auto-resolver work can run two AI ladders + a sharp crop +
// blob uploads — give it the same 60s ceiling the repair endpoints
// already use.
export const maxDuration = 60;

// POST /api/admin/questions/[id]/report-bug
//
// Reviewer-triggered "this question is broken — please fix" report.
// Body: JSON { note } or multipart (`note` + optional `screenshots`).
// Inserts a row into bug_reports, opens a "Report a Problem" thread for it
// (/admin/support: status, dev replies, bell, follow-ups) and fires a
// best-effort Telegram ping to the dev chat. Side effects are isolated so a
// failed thread / Telegram ping doesn't block the DB row.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;
  const { id } = await params;
  let body: { note?: string } = {};
  let screenshots: string[] = [];
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData();
    body = { note: String(form.get("note") ?? "") };
    if ((body.note ?? "").length > 5000) {
      return NextResponse.json({ ok: false, message: "Note is too long (5000 characters max)" }, { status: 400 });
    }
    try {
      const r = await uploadScreenshots(form);
      if (typeof r === "string") return NextResponse.json({ ok: false, message: r }, { status: 400 });
      screenshots = r;
    } catch (e) {
      console.error("[report-bug] screenshot upload failed:", e);
      return NextResponse.json({ ok: false, message: "Screenshot upload failed, please try again" }, { status: 500 });
    }
  } else {
    try {
      body = await req.json();
    } catch {
      /* no body is fine */
    }
    if (typeof body.note === "string" && body.note.length > 5000) {
      return NextResponse.json({ ok: false, message: "Note is too long (5000 characters max)" }, { status: 400 });
    }
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

  // A retried request (same person, question and note within a minute)
  // returns the existing report instead of opening a second thread.
  {
    const since = new Date(Date.now() - 60_000).toISOString();
    let dup = db
      .from("bug_reports")
      .select("id")
      .eq("question_id", id)
      .eq("reporter_user_id", authResult.userId)
      .gte("created_at", since)
      .limit(1);
    const note = body.note?.trim() || null;
    dup = note === null ? dup.is("note", null) : dup.eq("note", note);
    const { data: existing } = await dup;
    if (existing && existing.length > 0) {
      const thread = await findSupportForBugReport(db, existing[0].id as string).catch(() => null);
      return NextResponse.json({ ok: true, duplicate: true, id: existing[0].id, supportId: thread?.id ?? null });
    }
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

  // The same report as a support thread (lib/support.ts — the code path
  // /admin/support uses), linked back via payload.source.
  const moduleName = (q.modules as unknown as { module_name?: string } | null)?.module_name ?? null;
  let supportId: string | null = null;
  try {
    supportId = await createSupportRequest(db, {
      userId: authResult.userId,
      reporterName: authResult.displayName,
      reporterEmail: authResult.email,
      body: bugReportSupportBody(body.note),
      screenshots,
      question: { id, module_name: moduleName, number: (q.original_question_number as number | null) ?? null },
      source: { kind: "bug_report", id: inserted.id as string },
    });
  } catch (e) {
    console.error("[report-bug] support thread failed:", e);
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
      const result = await autoResolveBugReport(id, body.note?.trim() || null);
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
        // In-app notification so the reporter sees the outcome without
        // depending on the dev Telegram bot: a dev reply on the support
        // thread (bell), or the old bell item when there's no thread.
        const message = result.summary || "Auto-repair fixed the reported issue.";
        const mirrored = await resolveBugReportThread(db, inserted.id, `Auto-fix: ${message}`).catch((e) => {
          console.error("[report-bug] support thread update failed:", e);
          return false;
        });
        if (!mirrored) {
          await notifyBugReportResolved(db, {
            reporterUserId: authResult.userId,
            bugReportId: inserted.id,
            questionId: id,
            message,
            auto: true,
          });
        }
      }
    } catch (e) {
      console.error("[report-bug] auto-resolve crashed:", e);
    }
  });

  return NextResponse.json({
    ok: true,
    message: supportId
      ? "Report sent. Follow it (status, dev replies) on Report a Problem; you'll get a bell notification when it's resolved."
      : "Report sent. The dev team will look at this question. You can keep reviewing the next question.",
    data: inserted,
    supportId,
  });
}

/**
 * Inspect the question + the admin's note and run the repair op(s) that
 * actually match the complaint, then report whether anything was truly
 * fixed.
 *
 * Routing (a report can trigger more than one op):
 *   - table   → note mentions a table, OR has_table=true but the stored
 *     text has no Markdown table → repairTableForQuestion
 *   - image   → note mentions a figure, OR blind image (has_image but no
 *     image_urls) → repairImageForQuestion
 *   - math    → note mentions math/render, OR nothing more specific
 *     matched (the catch-all for vague "this is broken" reports)
 *   - answer  → note is about answer-key / choice correctness → NO safe
 *     auto-fix; left open for a human (never auto-resolved)
 *
 * `touched` is true ONLY when at least one op returned ok===true, so a
 * report is auto-resolved only when something was genuinely fixed. An op
 * that reports "couldn't fix — edit by hand" (ok:false) leaves the report
 * open in the dev queue.
 */
async function autoResolveBugReport(
  questionId: string,
  note: string | null,
): Promise<{
  summary: string;
  newStatus: string | null;
  touched: boolean;
}> {
  const db = getServiceClient();
  const { data: q } = await db
    .from("questions")
    .select(AUDIT_COLS)
    .eq("id", questionId)
    .maybeSingle();
  if (!q) {
    return { summary: "Question not found.", newStatus: null, touched: false };
  }
  // Structural checks the question fails BEFORE we touch it — used to
  // verify, after repair, that the issue is genuinely gone (B3).
  const originalFails = CHECKS.filter((c) => c.failed(q as unknown as AuditRow)).map(
    (c) => c.id,
  );

  const n = (note ?? "").toLowerCase();
  const tableComplaint = /\btable\b|\bcolumn\b|\brow\b|\bgrid\b|表格|表|欄位|列/.test(n);
  const imageComplaint =
    /\bimage\b|\bfigure\b|\bgraph\b|\bpicture\b|\bdiagram\b|\bchart\b|圖|看不到/.test(n);
  const mathComplaint =
    /\bmath\b|\brender\b|\bfrac\b|\bequation\b|\blatex\b|\bformula\b|\bdisplay\b|公式|數學|顯示|亂碼/.test(
      n,
    );
  const answerComplaint =
    /\banswer\b|\bcorrect\b|\bkey\b|\bchoice\b|\boption\b|\bwrong\b|答案|選項|錯/.test(n);

  const tableFlagButFlat =
    q.has_table === true && !hasMarkdownTable((q.question_text as string) ?? "");
  const blindImage = stemFigureMissing(q);

  const ops: Array<{ label: string; run: () => Promise<{ ok: boolean; message: string }> }> = [];
  if (tableComplaint || tableFlagButFlat)
    ops.push({ label: "Table", run: () => repairTableForQuestion(questionId) });
  if (imageComplaint || blindImage)
    ops.push({ label: "Image", run: () => repairImageForQuestion(questionId) });
  // Math runs when explicitly asked for, or as the catch-all for a vague
  // report — but NOT when the only signal is an answer-key complaint
  // (a math re-extract can't fix a wrong answer and would falsely "touch").
  const onlyAnswer = answerComplaint && !tableComplaint && !imageComplaint && !mathComplaint;
  if (mathComplaint || (ops.length === 0 && !onlyAnswer))
    ops.push({ label: "Math", run: () => repairMathForQuestion(questionId) });

  const parts: string[] = [];
  let touched = false;
  let lastStatus = q.parsing_status as string;
  for (const op of ops) {
    try {
      const r = await op.run();
      parts.push(`${op.label}: ${r.message}`);
      if (r.ok) touched = true;
    } catch (e) {
      parts.push(
        `${op.label} fix crashed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Repairs normally demote to Draft / Needs Review, but a question in a
  // live test keeps Approved (lib/live-questions.ts) — report what's stored.
  if (touched) {
    const { data: cur } = await db.from("questions").select("parsing_status").eq("id", questionId).maybeSingle();
    if (cur?.parsing_status) lastStatus = cur.parsing_status as string;
  }

  // Answer-key correctness has no safe automatic fix — always leave the
  // report open for a human even if another op ran.
  if (answerComplaint) {
    parts.push(
      "Answer-key concern noted — no automatic fix for answer correctness; left for human review.",
    );
  }
  if (ops.length === 0) {
    parts.push("No automatic repair path matched — left open for human review.");
  }

  // B3 — verify the repair actually worked: re-audit the row and confirm
  // the checks it originally failed are now clear. "Claude returned ok" +
  // "KaTeX renders" isn't proof the reported defect is gone, so we re-run
  // the same structural CHECKS against the freshly-written row.
  let verifiedClear = true;
  if (touched && originalFails.length) {
    const { data: fresh } = await db
      .from("questions")
      .select(AUDIT_COLS)
      .eq("id", questionId)
      .maybeSingle();
    const stillFails = fresh
      ? CHECKS.filter((c) => c.failed(fresh as unknown as AuditRow)).map((c) => c.id)
      : originalFails;
    const unresolved = originalFails.filter((f) => stillFails.includes(f));
    if (unresolved.length) {
      verifiedClear = false;
      parts.push(`Still failing after repair: ${unresolved.join(", ")} — left for human review.`);
    }
  }

  // Auto-close only when something was repaired, the post-repair audit is
  // clean, and the complaint isn't an answer-key concern (no safe auto-fix).
  const resolvable = touched && verifiedClear && !answerComplaint;

  return {
    summary: parts.join(" · "),
    newStatus: lastStatus,
    touched: resolvable,
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
