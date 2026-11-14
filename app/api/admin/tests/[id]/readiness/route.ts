import { adminTestAuth, testReadiness } from "@/lib/test-status-handlers";

// GET /api/admin/tests/[id]/readiness — what the status menu shows before a change.
// Admins only (adminTestAuth). Body shared with the other side's route (lib/test-status-handlers).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return testReadiness(id, adminTestAuth, "admin/tests");
}
