// lib/draft-race.ts
//
// "Back to draft" (POST /api/admin/tests/[id]/draft) refuses once anyone
// has started, but a student's start can land between that check and the
// status update. Without a DB trigger, the start paths close the gap from
// their side: after inserting, they re-read the test's status and, if it is
// Draft now, remove the row they just created (only while it has no
// answers) and refuse like any Draft test. The draft route re-checks for
// submissions after its update for the other ordering.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Is this test (a full-length parent, for full-length) Draft right now? */
export async function testIsDraftNow(db: SupabaseClient, testId: string): Promise<boolean> {
  const { data, error } = await db.from("tests").select("status").eq("id", testId).maybeSingle();
  if (error) {
    // Can't tell: keep the start (the normal path) and let the draft route's re-check catch it.
    console.error("[draft-race] status re-read", testId, error.message);
    return false;
  }
  return data?.status === "Draft";
}

/** Delete a just-created submission if it is still untouched (no answers). */
export async function dropUnansweredSubmission(db: SupabaseClient, submissionId: string): Promise<void> {
  const { data, error } = await db.from("submissions").select("answers").eq("id", submissionId).maybeSingle();
  if (error || !data) return;
  const answers = data.answers as Record<string, unknown> | null;
  if (answers && Object.keys(answers).length > 0) return;
  const { error: delErr } = await db.from("submissions").delete().eq("id", submissionId).eq("status", "In Progress");
  if (delErr) console.error("[draft-race] delete", submissionId, delErr.message);
}
