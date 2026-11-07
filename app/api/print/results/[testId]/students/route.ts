import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { listPrintableAttempts, PrintAccessError } from "@/lib/result-printout";

// GET /api/print/results/<testId>/students → finished attempts the caller may print/download.
export async function GET(_req: Request, { params }: { params: Promise<{ testId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "teacher" && user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { testId } = await params;
  const db = getServiceClient();
  try {
    const students = await listPrintableAttempts(db, { userId: user.userId, role: user.role, isQa: user.isQa }, testId);
    const { data: test } = await db.from("tests").select("test_name").eq("id", testId).maybeSingle();
    return NextResponse.json({ testName: test?.test_name ?? "Test", students });
  } catch (e) {
    if (e instanceof PrintAccessError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
