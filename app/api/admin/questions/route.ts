import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/questions
// Query params: keyword, section, status, domain, skill, difficulty, moduleId,
//               questionType, hasImage, hasTable, hasFormula, page, limit
export async function GET(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(req.url);
  const keyword = searchParams.get("keyword") ?? "";
  const section = searchParams.get("section") ?? "";
  const status = searchParams.get("status") ?? "";
  const domain = searchParams.get("domain") ?? "";
  const skill = searchParams.get("skill") ?? "";
  const difficulty = searchParams.get("difficulty") ?? "";
  const moduleId = searchParams.get("moduleId") ?? "";
  const questionType = searchParams.get("questionType") ?? "";
  const hasImage = searchParams.get("hasImage");
  const hasTable = searchParams.get("hasTable");
  const hasFormula = searchParams.get("hasFormula");
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const offset = (page - 1) * limit;

  const db = getServiceClient();

  let query = db
    .from("questions")
    .select(
      `id, module_id, section, original_question_number, question_text,
       difficulty, domain, skill, concept, question_type,
       has_image, has_table, has_formula, parsing_status, parsing_notes,
       ai_confidence_score, page_number, correct_answer,
       reviewed_by, reviewed_at, created_at,
       modules!inner(module_name, source_name)`,
      { count: "exact" }
    );

  // Full-text keyword search
  if (keyword.trim()) {
    query = query.textSearch("question_text", keyword.trim(), {
      type: "websearch",
      config: "english",
    });
  }

  if (section) query = query.eq("section", section);
  if (status) query = query.eq("parsing_status", status);
  if (domain) query = query.eq("domain", domain);
  if (skill) query = query.ilike("skill", `%${skill}%`);
  if (difficulty) query = query.eq("difficulty", difficulty);
  if (moduleId) query = query.eq("module_id", moduleId);
  if (questionType) query = query.eq("question_type", questionType);
  if (hasImage === "true") query = query.eq("has_image", true);
  if (hasTable === "true") query = query.eq("has_table", true);
  if (hasFormula === "true") query = query.eq("has_formula", true);

  // Audit pivot for auto-promote-high-confidence: rows where the
  // script flipped parsing_status to Approved without a human
  // reviewer (reviewed_by left null). Caller passes ?autoApproved=true
  // and is expected to also pass status=Approved.
  const autoApproved = searchParams.get("autoApproved");
  if (autoApproved === "true") query = query.is("reviewed_by", null);

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error("[questions] GET error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  return NextResponse.json({
    data: data ?? [],
    total: count ?? 0,
    page,
    limit,
    pages: Math.ceil((count ?? 0) / limit),
  });
}
