import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { deviceInfoFromHeaders } from "@/lib/student-exam";
import { latestFlAttempt, startFlMath } from "@/lib/full-length-attempt";
import { flAccess } from "../_shared";

export const maxDuration = 60;

// POST /api/student/full-length/[testId]/start-math   body: { auto?: boolean }
//
// End the break and start Math: creates Math Module 1 with its clock
// starting now (lib/full-length-attempt startFlMath). "Resume testing"
// sends {}; the break screen at 0:00 sends {auto: true}, which is only
// accepted when pausing is off and the break is really over (2 s
// tolerance) — otherwise 409 with the true remaining time so the screen
// re-syncs. Idempotent: an existing Math Module 1 is returned. Allowed
// on a Closed test for an attempt already running.
export async function POST(req: Request, { params }: { params: Promise<{ testId: string }> }) {
  const auth = await requireRole("student");
  if (auth instanceof NextResponse) return auth;
  const { testId } = await params;
  let auto = false;
  try {
    const body = (await req.json()) as { auto?: unknown } | null;
    auto = body?.auto === true;
  } catch {
    // no body = a manual Resume
  }
  const db = getServiceClient();

  try {
    const res = await flAccess(db, auth, testId);
    if (res instanceof NextResponse) return res;
    const attempt = await latestFlAttempt(db, testId, auth.userId);
    if (!attempt) return NextResponse.json({ error: "No attempt to continue" }, { status: 404 });
    const out = await startFlMath(db, res.ctx, attempt, { auto, device: deviceInfoFromHeaders(req.headers) });
    if (!out.ok) {
      return NextResponse.json(
        {
          error: out.error,
          ...(out.retryInSeconds != null ? { retryInSeconds: out.retryInSeconds } : {}),
          ...(out.breakEndsAtMs != null ? { breakEndsAt: new Date(out.breakEndsAtMs).toISOString() } : {}),
          now: new Date().toISOString(),
        },
        { status: out.status },
      );
    }
    return NextResponse.json({ data: { submissionId: out.submissionId, created: out.created } });
  } catch (e) {
    console.error("[full-length/start-math]", testId, e);
    return NextResponse.json({ error: "Couldn't start Math — please try again." }, { status: 503 });
  }
}
