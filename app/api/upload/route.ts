import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { requireAnyRole } from "@/lib/rbac";

export async function POST(req: Request) {
  const authResult = await requireAnyRole(["admin", "teacher", "student"]);
  if (authResult instanceof NextResponse) return authResult;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const pathname = formData.get("pathname") as string | null;
  const blobPathname = pathname ?? `uploads/${Date.now()}-${file.name}`;

  const blob = await put(blobPathname, file, {
    access: "public",
    addRandomSuffix: false,
  });

  return NextResponse.json({ url: blob.url, size: file.size });
}
