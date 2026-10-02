import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/modules/[id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data, error } = await db
    .from("modules")
    .select("*, questions(id, parsing_status)")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  return NextResponse.json({ data });
}

// PATCH /api/admin/modules/[id] — edit metadata fields (name, section,
// module_number, difficulty, source, version). Does NOT touch the PDF
// or parsed questions; safe to call after parse.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;

  let body: {
    moduleName?: string;
    section?: "Math" | "Reading & Writing";
    moduleNumber?: 1 | 2 | null;
    difficulty?: "Easy" | "Medium" | "Hard" | "Mixed" | null;
    sourceName?: string | null;
    version?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.moduleName !== undefined) {
    const trimmed = body.moduleName.trim();
    if (!trimmed) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    updates.module_name = trimmed;
  }
  if (body.section !== undefined) {
    if (!["Math", "Reading & Writing"].includes(body.section)) {
      return NextResponse.json({ error: "Invalid section" }, { status: 400 });
    }
    updates.section = body.section;
  }
  if (body.moduleNumber !== undefined) {
    if (body.moduleNumber !== null && ![1, 2].includes(body.moduleNumber)) {
      return NextResponse.json({ error: "Module number must be 1 or 2" }, { status: 400 });
    }
    updates.module_number = body.moduleNumber;
  }
  if (body.difficulty !== undefined) {
    if (
      body.difficulty !== null &&
      !["Easy", "Medium", "Hard", "Mixed"].includes(body.difficulty)
    ) {
      return NextResponse.json({ error: "Invalid difficulty" }, { status: 400 });
    }
    updates.difficulty = body.difficulty;
  }
  if (body.sourceName !== undefined) updates.source_name = body.sourceName;
  if (body.version !== undefined) updates.version = body.version;

  const db = getServiceClient();
  const { error } = await db.from("modules").update(updates).eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/modules/[id] — remove module + cascade questions + delete blob
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data: mod, error: fetchErr } = await db
    .from("modules")
    .select("id, pdf_url")
    .eq("id", id)
    .single();
  if (fetchErr || !mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  // Guard against destroying real data. A module can't be deleted straight
  // off because its questions (and their answer_records) and any tests
  // reference it. We cascade-delete the module's OWN questions, but refuse
  // when a test uses the module or students have answered its questions —
  // deleting then would break a test or lose student attempts.
  const { data: usedByTests } = await db
    .from("tests")
    .select("test_name")
    .or(
      `module_id.eq.${id},module_2_id.eq.${id},module_1_id.eq.${id},module_2_easy_id.eq.${id},module_2_hard_id.eq.${id}`,
    );
  if (usedByTests && usedByTests.length > 0) {
    const names = usedByTests.map((t) => t.test_name).join(", ");
    return NextResponse.json(
      {
        error: `This module is used by ${usedByTests.length} test(s): ${names}. Remove it from those tests first, then delete.`,
      },
      { status: 409 },
    );
  }

  const { data: qRows } = await db.from("questions").select("id").eq("module_id", id);
  const questionIds = (qRows ?? []).map((q) => q.id);

  if (questionIds.length > 0) {
    const { count: arCount } = await db
      .from("answer_records")
      .select("*", { count: "exact", head: true })
      .in("question_id", questionIds);
    if (arCount && arCount > 0) {
      return NextResponse.json(
        {
          error: `Students have answered ${arCount} of this module's questions. Deleting would erase their attempts — this module can't be deleted.`,
        },
        { status: 409 },
      );
    }
    // Safe to remove: no tests use it, no student answers exist. Delete the
    // child questions first so the modules FK no longer blocks the delete.
    const { error: qErr } = await db.from("questions").delete().eq("module_id", id);
    if (qErr) {
      console.error("[modules DELETE] question delete error:", qErr);
      return NextResponse.json(
        { error: `Failed to delete module's questions: ${qErr.message}` },
        { status: 500 },
      );
    }
  }

  if (mod.pdf_url) {
    try {
      await del(mod.pdf_url);
    } catch (err) {
      console.warn("[modules DELETE] blob delete failed (continuing):", err);
    }
  }

  const { error } = await db.from("modules").delete().eq("id", id);
  if (error) {
    console.error("[modules DELETE] DB error:", error);
    return NextResponse.json(
      { error: `Failed to delete module: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
