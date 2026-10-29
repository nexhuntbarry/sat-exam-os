import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { requireQuestionReviewer } from "@/lib/rbac";
import { forbidQa } from "@/lib/qa";
import { getServiceClient } from "@/lib/supabase";

const MAX_BYTES = 10 * 1024 * 1024;

// POST /api/admin/questions/[id]/images
//
// Reviewer edits to a question's extracted figure images (multipart):
//   action=delete,  index, url            → drop that image
//   action=replace, index, url, file(PNG) → swap in a cropped version
// `url` must still be the image at `index`, so two reviewers editing the
// same question can't remove or overwrite the wrong one.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireQuestionReviewer();
  if (user instanceof NextResponse) return user;
  const qaBlock = forbidQa(user);
  if (qaBlock) return qaBlock;
  const { id } = await params;

  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const index = Number(form.get("index"));
  const url = String(form.get("url") ?? "");
  if (!["delete", "replace"].includes(action) || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const db = getServiceClient();
  const { data: q, error } = await db
    .from("questions")
    .select("module_id, original_question_number, image_urls, image_alts")
    .eq("id", id)
    .single();
  if (error || !q) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  const urls: string[] = [...(q.image_urls ?? [])];
  const alts: string[] = [...(q.image_alts ?? [])];
  if (urls[index] !== url) {
    return NextResponse.json({ error: "This image changed since you opened the page. Refresh and try again." }, { status: 409 });
  }

  let patch: Record<string, unknown>;
  if (action === "delete") {
    urls.splice(index, 1);
    alts.splice(index, 1);
    // No figure left → the question no longer expects one.
    patch = { image_urls: urls, image_alts: alts, ...(urls.length === 0 ? { has_image: false } : {}) };
  } else {
    const file = form.get("file");
    if (!file || typeof file === "string" || file.size === 0) {
      return NextResponse.json({ error: "Missing cropped image" }, { status: 400 });
    }
    if (file.type !== "image/png" || file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Cropped image must be a PNG under 10 MB" }, { status: 400 });
    }
    const blob = await put(
      `images/${q.module_id}/${q.original_question_number}-${index}-crop.png`,
      file,
      { access: "private", contentType: "image/png", addRandomSuffix: true },
    );
    urls[index] = blob.url;
    patch = { image_urls: urls, image_alts: alts };
  }

  const { error: upErr } = await db.from("questions").update(patch).eq("id", id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  console.log(`[question-images] ${user.email} ${action} q=${id} i=${index} old=${url}`);
  return NextResponse.json({ ok: true, image_urls: urls, image_alts: alts, ...(patch.has_image === false ? { has_image: false } : {}) });
}
