import { teacherManagerAuth, closeTest } from "@/lib/test-status-handlers";

// POST /api/teacher/tests/[id]/close — Published → Closed.
// Admins, or an approved teacher who manages the test (teacherManagerAuth, lib/test-manage). Body shared with the other side's route (lib/test-status-handlers).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return closeTest(id, teacherManagerAuth, "teacher/tests");
}
