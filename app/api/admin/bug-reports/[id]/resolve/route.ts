import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { notifyBugReportResolved } from "@/lib/notifications";

// POST /api/admin/bug-reports/[id]/resolve
//
// Admin-side "mark resolved". Used from the bug-reports list page when a human
// has fixed something the auto-resolver couldn't. Optional body { message }
// lets the resolver leave a note the reporter sees in their notifications.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const db = getServiceClient();

  let message = "";
  try {
    const body = (await req.json()) as { message?: string };
    message = (body?.message ?? "").trim();
  } catch {
    // no body → resolve without a note
  }

  // Load the report so we can notify its reporter.
  const { data: report } = await db
    .from("bug_reports")
    .select("id, question_id, reporter_user_id")
    .eq("id", id)
    .maybeSingle();

  const { error } = await db
    .from("bug_reports")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: auth.userId,
    })
    .eq("id", id);
  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  }

  if (report?.reporter_user_id && report.question_id) {
    await notifyBugReportResolved(db, {
      reporterUserId: report.reporter_user_id as string,
      bugReportId: id,
      questionId: report.question_id as string,
      message: message || "Marked resolved by the dev team.",
      auto: false,
    });
  }

  return NextResponse.json({ ok: true });
}
