import { adminTestAuth, publishTest } from "@/lib/test-status-handlers";

// POST /api/admin/tests/[id]/reopen — Closed → Published.
// Admins only (adminTestAuth). Body shared with the other side's route (lib/test-status-handlers).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return publishTest(id, adminTestAuth, "reopen", "admin/tests");
}
