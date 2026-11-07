// scripts/backup-module-pdfs.ts
//
// One-off: back up every module's source PDF that still resolves to
// backups/modules/<moduleId>/<timestamp>-<name>.pdf (same private Blob
// store, via @vercel/blob copy()). New uploads and "Replace source PDF" are
// backed up by the app (lib/pdf-backup.ts); this covers the existing ones.
// Idempotent: a module that already has a backup of the same file name is
// skipped.
//
// Usage:
//   npx tsx scripts/backup-module-pdfs.ts           # dry run (default)
//   npx tsx scripts/backup-module-pdfs.ts --apply   # copy the blobs

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { backupModulePdf, backupPathFor, isOurBlob, listModuleBackups } from "../lib/pdf-backup";

function loadEnv(file: string, overwrite: boolean) {
  try {
    const body = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of body.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (overwrite || !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}
loadEnv(".env.local", true);

const apply = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function resolves(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  });
  return res.status;
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN missing");
  const { data: mods, error } = await sb
    .from("modules")
    .select("id, module_name, pdf_url")
    .order("created_at", { ascending: true });
  if (error) throw error;

  const counts = { modules: 0, noUrl: 0, notBlob: 0, missing: 0, alreadyBackedUp: 0, toBackUp: 0, backedUp: 0, failed: 0 };
  const missing: string[] = [];
  for (const m of mods ?? []) {
    counts.modules++;
    const url = m.pdf_url as string | null;
    const label = `${m.module_name} (${m.id})`;
    if (!url) {
      counts.noUrl++;
      continue;
    }
    if (!isOurBlob(url)) {
      counts.notBlob++;
      console.log(`skip (not a Blob URL)  ${label}`);
      continue;
    }
    const status = await resolves(url);
    if (status !== 200) {
      counts.missing++;
      missing.push(`${label} → HTTP ${status}`);
      continue;
    }
    const suffix = backupPathFor(m.id, url).replace(/^.*?Z-/, "-");
    const existing = await listModuleBackups(m.id);
    if (existing.some((b) => b.pathname.endsWith(suffix))) {
      counts.alreadyBackedUp++;
      continue;
    }
    counts.toBackUp++;
    if (!apply) {
      console.log(`would back up  ${label}`);
      continue;
    }
    try {
      const to = await backupModulePdf(m.id, url);
      counts.backedUp++;
      console.log(`backed up  ${label} → ${new URL(to).pathname}`);
    } catch (err) {
      counts.failed++;
      console.error(`FAILED  ${label}:`, err instanceof Error ? err.message : err);
    }
  }

  if (missing.length) {
    console.log(`\nSource PDFs that do NOT resolve (cannot be backed up):`);
    for (const s of missing) console.log(`  ${s}`);
  }
  console.log(`\n${apply ? "APPLY" : "DRY RUN"}: ${JSON.stringify(counts)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
