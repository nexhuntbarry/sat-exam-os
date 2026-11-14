import { teacherManagerAuth, testReadiness } from "@/lib/test-status-handlers";

// GET /api/teacher/tests/[id]/readiness — what the status menu shows before a change.
// Admins, or an approved teacher who manages the test (teacherManagerAuth, lib/test-manage). Body shared with the other side's route (lib/test-status-handlers).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return testReadiness(id, teacherManagerAuth, "teacher/tests");
}
