import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { fullLengthLinks } from "@/lib/full-length";
import { fullLengthAttemptScore, groupFullLengthAttempts, loadFlAttemptMeta, type FlScoreRow } from "@/lib/full-length-score";

// GET /api/admin/tests/[id]/submissions
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;
  const db = getServiceClient();

  // Full-length SAT parent: the module rows are on its two section
  // children (each row carries its own test_id), plus one combined entry
  // per full-length attempt (total, R&W, Math, status).
  const links = await fullLengthLinks(db);
  const kids = links.childrenOf.get(id);
  const columns: string = kids
    ? `
      id, test_id, student_id, status, score, correct_count, total_questions,
      percentage, started_at, submitted_at, time_spent_seconds, attempt_number, metadata,
      session_id, adaptive_track,
      users!inner(display_name, email)
    `
    : `
      id, student_id, status, score, correct_count, total_questions,
      percentage, started_at, submitted_at, time_spent_seconds, attempt_number, metadata,
      users!inner(display_name, email)
    `;
  const { data: submissions, error } = await db
    .from("submissions")
    .select(columns)
    .in("test_id", kids ? [kids.rw, kids.math].filter((x): x is string => Boolean(x)) : [id])
    .order("submitted_at", { ascending: false });

  if (error) {
    console.error("[admin/tests/submissions/get]", error);
    return NextResponse.json({ error: "Failed to fetch submissions" }, { status: 500 });
  }
  if (!kids) return NextResponse.json({ data: submissions ?? [] });

  const meta = await loadFlAttemptMeta(db, [id]);
  const { attempts } = groupFullLengthAttempts((submissions ?? []) as unknown as FlScoreRow[], links);
  const fullLength = attempts.map((g) => {
    const s = fullLengthAttemptScore(g.rw, g.math, meta.get(g.key));
    return {
      studentId: g.studentId,
      attemptNumber: g.attemptNumber,
      status: s.status,
      total: s.total,
      rw: s.rw.score?.sat ?? null,
      math: s.math.score?.sat ?? null,
      rwModules: s.rw.score?.modules ?? null,
      mathModules: s.math.score?.modules ?? null,
      rwTrack: s.rwTrack,
      mathTrack: s.mathTrack,
    };
  });
  return NextResponse.json({ data: submissions ?? [], fullLength });
}
