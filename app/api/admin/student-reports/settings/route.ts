import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { STUDENT_REPORTS_SETTING_KEY, getStudentReportsSetting } from "@/lib/student-reports";

// GET — is the student "Report a problem" button on?
export async function GET() {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ enabled: await getStudentReportsSetting(getServiceClient()) });
}

// PUT { enabled: boolean } — turn student reporting on / off for everyone.
// Pages read it on load, so an open test picks the change up on its next load;
// the report API checks it on every request.
export async function PUT(req: Request) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const qaBlock = forbidQa(auth);
  if (qaBlock) return qaBlock;

  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
  }
  const { error } = await getServiceClient()
    .from("app_settings")
    .upsert({
      key: STUDENT_REPORTS_SETTING_KEY,
      value: { enabled: body.enabled },
      updated_at: new Date().toISOString(),
      updated_by: auth.userId,
    });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ enabled: body.enabled });
}
