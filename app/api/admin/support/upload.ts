import { put } from "@vercel/blob";

const MAX_FILES = 6;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Upload the screenshots attached to a support message (multipart field
 * `screenshots`) to the private Blob store. Returns the blob URLs, or an
 * error string to send back as a 400.
 */
export async function uploadScreenshots(form: FormData): Promise<string[] | string> {
  // Not `instanceof File`: the runtime's multipart entries aren't always the global File class.
  const files = form.getAll("screenshots").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (files.length > MAX_FILES) return `At most ${MAX_FILES} screenshots per message`;
  for (const f of files) {
    if (!f.type.startsWith("image/")) return `${f.name} is not an image`;
    if (f.size > MAX_BYTES) return `${f.name} is over 10 MB`;
  }
  const urls: string[] = [];
  for (const f of files) {
    const ext = f.type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "png";
    const blob = await put(`support/${crypto.randomUUID()}.${ext}`, f, {
      access: "private",
      contentType: f.type,
    });
    urls.push(blob.url);
  }
  return urls;
}
