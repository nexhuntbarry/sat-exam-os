import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/students
//
// Returns approved students for use in pickers (e.g. add-students-to-test
// modal). Optional `q` query param does a case-insensitive prefix match
// against display_name / email so the picker can stay responsive on
// large rosters.
//
// Response: { data: [{ id, email, display_name, grade?, school?, class_group? }] }
export async function GET(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const onlyApproved = url.searchParams.get("status") !== "all";

  const db = getServiceClient();
  let query = db
    .from("users")
    .select(
      "id, email, display_name, account_status, student_profiles(grade, school, class_group)",
    )
    .eq("role", "student")
    .order("display_name", { ascending: true })
    .limit(200);

  if (onlyApproved) query = query.eq("account_status", "approved");
  if (q.length > 0) {
    // OR across display_name + email; ilike handles spaces fine.
    // SECURITY: PostgREST .or() parses commas, parens, and dots as
    // operator separators. Raw user input would let a caller inject
    // sibling filters (e.g. ",role.eq.admin") and pull rows outside
    // the intended search scope. Strip those meta-characters before
    // interpolation. Wildcards (% _) are left in since they remain
    // bounded by the ilike pattern.
    const safeQ = q.replace(/[,().*]/g, "");
    if (safeQ.length > 0) {
      query = query.or(`display_name.ilike.%${safeQ}%,email.ilike.%${safeQ}%`);
    }
  }

  const { data, error } = await query;
  if (error) {
    console.error("[admin/students/get]", error);
    return NextResponse.json({ error: "Failed to fetch students" }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [] });
}
