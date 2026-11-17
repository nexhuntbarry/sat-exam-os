import { NextResponse } from "next/server";
import { customTestAdmin, familyExclusions, poolFor } from "@/lib/custom-test/api";
import { poolCounts } from "@/lib/custom-test/select";

// GET /api/admin/custom-tests/pool?familyId=
// Eligible questions per official (domain, skill, difficulty), one per
// duplicate group, for the builder's count cells. With familyId ("Make
// another version") earlier versions' questions are left out and counted.
export async function GET(req: Request) {
  const ctx = await customTestAdmin();
  if (ctx instanceof NextResponse) return ctx;
  const { admin, db } = ctx;
  try {
    const familyId = new URL(req.url).searchParams.get("familyId");
    const [pool, family] = await Promise.all([poolFor(db, admin), familyExclusions(db, familyId)]);
    return NextResponse.json({
      data: {
        counts: { rw: poolCounts(pool.questions, "rw", family.ids), math: poolCounts(pool.questions, "math", family.ids) },
        excluded: family.ids.size,
      },
    });
  } catch (e) {
    console.error("[custom-tests/pool]", e);
    return NextResponse.json({ error: "Could not load the question bank" }, { status: 500 });
  }
}
