// Source-PDF backups. Every module PDF (on upload and on replace) is copied
// to backups/modules/<moduleId>/<timestamp>-<name>.pdf in the same private
// Blob store, so a deleted or lost file can be restored. Nothing in the app
// deletes under backups/ (the module DELETE route only removes the module's
// own pdf_url blob). Relative imports only: scripts/backup-module-pdfs.ts
// runs this under tsx.

import { copy, list } from "@vercel/blob";

export const BACKUP_PREFIX = "backups/modules/";

export function isOurBlob(url: string | null | undefined): boolean {
  return !!url && /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//.test(url);
}

export function backupPathFor(moduleId: string, sourceUrl: string, now = new Date()): string {
  const base = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() ?? "module")
    .replace(/\.pdf$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .slice(0, 120) || "module";
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${BACKUP_PREFIX}${moduleId}/${ts}-${base}.pdf`;
}

/** Copy a module's PDF blob into its backup folder. Returns the backup URL. */
export async function backupModulePdf(moduleId: string, sourceUrl: string): Promise<string> {
  if (!isOurBlob(sourceUrl)) throw new Error(`Not a Vercel Blob URL: ${sourceUrl}`);
  const res = await copy(sourceUrl, backupPathFor(moduleId, sourceUrl), {
    access: "private",
    contentType: "application/pdf",
    addRandomSuffix: false,
  });
  return res.url;
}

/** Backups already stored for one module (newest last by pathname). */
export async function listModuleBackups(moduleId: string): Promise<{ pathname: string; url: string; size: number }[]> {
  const out: { pathname: string; url: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `${BACKUP_PREFIX}${moduleId}/`, cursor, limit: 1000 });
    for (const b of page.blobs) out.push({ pathname: b.pathname, url: b.url, size: b.size });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
}
