import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { forbidQa } from "@/lib/qa";
import { clearTableFlag } from "@/lib/repair-ops";

// POST /api/admin/questions/[id]/clear-table-flag
//
// Used when the audit flagged has_table=true but the reviewer
// verified the question doesn't actually need a table — flip the
// flag so the row stops failing.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;
  const { id } = await params;
  const res = await clearTableFlag(id);
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
