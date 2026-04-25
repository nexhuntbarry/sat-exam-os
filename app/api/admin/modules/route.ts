import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/modules
export async function GET() {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const db = getServiceClient();
  const { data, error } = await db
    .from("modules")
    .select("id, module_name, section, module_number, difficulty, source_name, version, pdf_url, total_questions, parsing_status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[modules/get] DB error:", error);
    return NextResponse.json({ error: "Failed to fetch modules" }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// POST /api/admin/modules — create module
export async function POST(req: Request) {
  console.log("[modules POST] received");
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) {
    console.warn("[modules POST] auth failed", authResult.status);
    return authResult;
  }
  const admin = authResult;
  console.log("[modules POST] auth ok userId=", admin.userId);

  let body: {
    moduleName: string;
    section: "Math" | "Reading & Writing";
    moduleNumber: 1 | 2;
    difficulty?: "Easy" | "Medium" | "Hard" | "Mixed";
    sourceName?: string;
    version?: string;
    pdfUrl: string;
    pdfSizeBytes?: number;
    triggerParse?: boolean;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.moduleName || !body.section || !body.moduleNumber || !body.pdfUrl) {
    console.warn("[modules POST] missing fields", { hasName: !!body.moduleName, hasSection: !!body.section, hasNum: !!body.moduleNumber, hasUrl: !!body.pdfUrl });
    return NextResponse.json(
      { error: "moduleName, section, moduleNumber, pdfUrl are required" },
      { status: 400 }
    );
  }
  console.log("[modules POST] inserting moduleName=", body.moduleName, "pdfUrl=", body.pdfUrl, "size=", body.pdfSizeBytes);

  const db = getServiceClient();
  const { data, error } = await db
    .from("modules")
    .insert({
      module_name: body.moduleName,
      section: body.section,
      module_number: body.moduleNumber,
      difficulty: body.difficulty ?? null,
      source_name: body.sourceName ?? null,
      version: body.version ?? null,
      pdf_url: body.pdfUrl,
      pdf_size_bytes: body.pdfSizeBytes ?? null,
      parsing_status: body.triggerParse ? "parsing" : "pending",
      uploaded_by: admin.userId,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[modules/post] DB error:", error);
    return NextResponse.json({ error: "Failed to create module" }, { status: 500 });
  }
  console.log("[modules POST] inserted id=", data.id);

  return NextResponse.json(
    { ok: true, id: data.id, parseQueued: body.triggerParse ?? false },
    { status: 201 }
  );
}
