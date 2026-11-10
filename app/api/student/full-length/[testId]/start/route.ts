import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { deviceInfoFromHeaders } from "@/lib/student-exam";
import { startFlAttempt } from "@/lib/full-length-attempt";
import { flAccess } from "../_shared";

export const maxDuration = 60;

// POST /api/student/full-length/[testId]/start
//
// Start or resume the student's full-length SAT attempt (lib/full-length-
// attempt startFlAttempt): resumes an attempt that can still continue;
// otherwise creates the next one (Published, assigned, open, before the
// due date, retake allowed — the parent's allow_retake or a grant on the
// parent, consumed here) and its R&W Module 1. Idempotent under double
// clicks. The client then opens /student/tests/[testId]/sat.
export async function POST(req: Request, { params }: { params: Promise<{ testId: string }> }) {
  const auth = await requireRole("student");
  if (auth instanceof NextResponse) return auth;
  const { testId } = await params;
  const db = getServiceClient();

  try {
    const res = await flAccess(db, auth, testId);
    if (res instanceof NextResponse) return res;
    const out = await startFlAttempt(db, res.ctx, auth.userId, {
      assigned: res.access.assigned,
      device: deviceInfoFromHeaders(req.headers),
    });
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(
      { data: { attemptId: out.attempt.id, resumed: out.resumed, submissionId: out.submissionId } },
      { status: out.resumed ? 200 : 201 },
    );
  } catch (e) {
    console.error("[full-length/start]", testId, e);
    return NextResponse.json({ error: "Couldn't start the test — please try again." }, { status: 503 });
  }
}
