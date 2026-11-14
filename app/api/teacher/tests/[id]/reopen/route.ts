import { teacherManagerAuth, publishTest } from "@/lib/test-status-handlers";

// POST /api/teacher/tests/[id]/reopen — Closed → Published.
// Admins, or an approved teacher who manages the test (teacherManagerAuth, lib/test-manage). Body shared with the other side's route (lib/test-status-handlers).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return publishTest(id, teacherManagerAuth, "reopen", "teacher/tests");
}
