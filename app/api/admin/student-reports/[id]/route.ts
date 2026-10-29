import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, onSide } from "@/lib/qa";
import { formatDateTime } from "@/lib/datetime";
import { SUPPORT_TYPE, type SupportRequest } from "@/lib/support";
import {
  STUDENT_REPORT_TYPE,
  describeStudentReports,
  studentReportForwardBody,
  type StudentReport,
  type StudentReportRow,
} from "@/lib/student-reports";

const ADMIN_NOTE_MAX = 2000;

// POST /api/admin/student-reports/[id]
// Body: { action: "forward" | "dismiss" | "reopen", adminNote? }
// "forward" is the only path from a student report to the dev pipeline: it
// creates an ordinary support_request owned by this admin.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as { action?: string; adminNote?: unknown } | null;
  const action = body?.action;
  const adminNote = typeof body?.adminNote === "string" ? body.adminNote.trim() : "";
  if (action !== "forward" && action !== "dismiss" && action !== "reopen") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  if (adminNote.length > ADMIN_NOTE_MAX) {
    return NextResponse.json({ error: "Note is too long" }, { status: 400 });
  }

  const db = getServiceClient();
  const { data } = await db
    .from("notifications")
    .select("id, user_id, created_at, payload")
    .eq("type", STUDENT_REPORT_TYPE)
    .eq("id", id)
    .maybeSingle();
  const row = data as StudentReportRow | null;
  // QA admins only act on QA students' reports and vice versa.
  if (!row || !onSide(row.user_id, await getQaUserIds(), auth.isQa)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const from = row.payload.status;
  const allowed =
    action === "reopen" ? from === "dismissed" : from === "new" || (action === "forward" && from === "dismissed");
  if (!allowed) {
    return NextResponse.json({ error: `This report is already ${from}` }, { status: 409 });
  }

  const now = new Date().toISOString();
  const handled = { handled_by: auth.userId, handled_by_name: auth.displayName, handled_at: now };
  const next: StudentReport =
    action === "reopen"
      ? { ...row.payload, status: "new", ...handled }
      : { ...row.payload, status: action === "forward" ? "forwarded" : "dismissed", ...handled };

  // Guard on the status we read so two admins can't both forward it.
  const { data: claimed, error: claimErr } = await db
    .from("notifications")
    .update({ payload: next })
    .eq("id", row.id)
    .eq("payload->>status", from)
    .select("id");
  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 500 });
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: "Someone else just handled this report — reload the page" }, { status: 409 });
  }
  if (action !== "forward") return NextResponse.json({ ok: true, status: next.status });

  const [view] = await describeStudentReports(db, [row]);
  const message = studentReportForwardBody(view, {
    origin: new URL(req.url).origin,
    reportedAt: formatDateTime(row.created_at),
    adminNote: adminNote || undefined,
  });
  const support: SupportRequest = {
    kind: SUPPORT_TYPE,
    status: "new",
    reporter_name: auth.displayName,
    reporter_email: auth.email,
    messages: [{ from: "reporter", body: message, at: now }],
    updated_at: now,
  };
  const { data: created, error } = await db
    .from("notifications")
    .insert({ user_id: auth.userId, type: SUPPORT_TYPE, payload: support, read_at: now })
    .select("id")
    .single();
  if (error || !created) {
    // Put the report back so it can be forwarded again.
    await db.from("notifications").update({ payload: row.payload }).eq("id", row.id);
    return NextResponse.json({ error: error?.message ?? "Couldn't forward" }, { status: 500 });
  }
  await db
    .from("notifications")
    .update({ payload: { ...next, forwarded_request_id: created.id } })
    .eq("id", row.id);
  return NextResponse.json({ ok: true, status: "forwarded", requestId: created.id });
}
