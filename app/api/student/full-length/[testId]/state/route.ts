import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { flAttemptRows, latestFlAttempt, stateOf } from "@/lib/full-length-attempt";
import { flAccess } from "../_shared";

// GET /api/student/full-length/[testId]/state
//
// Where the student's latest full-length attempt is (flState), with the
// break's end and the server's now so the break screen can re-sync its
// countdown. Read-only: recovery happens on the /sat page.
export async function GET(_req: Request, { params }: { params: Promise<{ testId: string }> }) {
  const auth = await requireRole("student");
  if (auth instanceof NextResponse) return auth;
  const { testId } = await params;
  const db = getServiceClient();

  try {
    const res = await flAccess(db, auth, testId);
    if (res instanceof NextResponse) return res;
    const attempt = await latestFlAttempt(db, testId, auth.userId);
    const now = Date.now();
    if (!attempt) {
      return NextResponse.json({ data: { state: null, now: new Date(now).toISOString() } }, { headers: { "Cache-Control": "no-store" } });
    }
    const st = stateOf(res.ctx, attempt, await flAttemptRows(db, res.ctx, auth.userId, attempt.attempt_number), now);
    return NextResponse.json(
      {
        data: {
          attemptId: attempt.id,
          state: st.state,
          section: st.section,
          submissionId: st.row?.id ?? null,
          breakEndsAt: st.breakEndsAtMs != null ? new Date(st.breakEndsAtMs).toISOString() : null,
          breakRemainingSeconds: st.breakRemainingSeconds,
          mathStartBlock: st.mathStartBlock,
          allowSectionPause: Boolean(attempt.allow_section_pause),
          now: new Date(now).toISOString(),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[full-length/state]", testId, e);
    return NextResponse.json({ error: "Couldn't load the test state" }, { status: 503 });
  }
}
