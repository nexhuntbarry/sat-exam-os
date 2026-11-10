import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { studentTestAccess, type StudentTestAccess } from "@/lib/module2-access";
import { loadFlContext, type FlContext } from "@/lib/full-length-attempt";

/**
 * The full-length test and the student's access to it (same rules as a
 * section test: QA side, Published — or Closed with an attempt to finish —
 * and assigned or mid-attempt). A NextResponse when refused.
 */
export async function flAccess(
  db: SupabaseClient,
  user: { userId: string; isQa: boolean },
  testId: string,
): Promise<{ ctx: FlContext; access: StudentTestAccess } | NextResponse> {
  const ctx = await loadFlContext(db, testId);
  if (!ctx) return NextResponse.json({ error: "Full-length test not found" }, { status: 404 });
  const access = await studentTestAccess(db, user, ctx.parent);
  if (access.error) return NextResponse.json({ error: access.error.error }, { status: access.error.status });
  return { ctx, access };
}
