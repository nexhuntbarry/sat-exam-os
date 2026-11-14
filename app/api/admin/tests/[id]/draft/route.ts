import { adminTestAuth, draftTest } from "@/lib/test-status-handlers";

// POST /api/admin/tests/[id]/draft — Published / Closed → Draft, only while no student has started it.
// Admins only (adminTestAuth). Body shared with the other side's route (lib/test-status-handlers).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return draftTest(id, adminTestAuth);
}
