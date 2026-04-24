import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/class-groups — create
export async function POST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;

  let body: { name: string; campus?: string; grade?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const db = getServiceClient();
  const { data, error } = await db
    .from("class_groups")
    .insert({
      name: body.name,
      campus: body.campus ?? null,
      grade: body.grade ?? null,
      created_by: admin.userId,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[class-groups] DB error:", error);
    return NextResponse.json({ error: "Failed to create class group" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data.id }, { status: 201 });
}
