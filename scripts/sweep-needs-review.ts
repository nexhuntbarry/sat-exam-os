// scripts/sweep-needs-review.ts
//
// Mass-repair pass: walk every question currently parked in
// Needs Review, try the right repair op for it, and auto-approve
// when the repair output passes the local math-clean check.
//
// Heuristic per row:
//   1. has_image=true and image_urls empty → run repairImageForQuestion
//      (Claude vision bbox + sharp crop + Blob upload). Continue.
//   2. Always run repairMathForQuestion (Sonnet → Opus ladder lives
//      inside the function). If it succeeds, the row is updated to
//      Draft + clean parsing_notes.
//   3. If the function flipped the row to Draft we promote it
//      straight to Approved per Barry's call ("解決後就直接approve").
//   4. If neither op cleaned the row, we leave it Needs Review and
//      log the reason for the next human pass.
//
// Designed to be re-runnable. Skips rows already Approved.
//
// Usage:
//   npx tsx scripts/sweep-needs-review.ts                # dry-run
//   npx tsx scripts/sweep-needs-review.ts --apply
//   npx tsx scripts/sweep-needs-review.ts --apply --module=<uuid>
//   npx tsx scripts/sweep-needs-review.ts --apply --limit=20

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import {
  repairMathForQuestion,
  repairImageForQuestion,
} from "../lib/repair-ops";

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

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const apply = process.argv.includes("--apply");
const moduleArg = process.argv.find((a) => a.startsWith("--module="));
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : null;

async function main() {
  let q = sb
    .from("questions")
    .select(
      "id, original_question_number, module_id, parsing_status, parsing_notes, has_image, image_urls, source_pdf_url, modules!inner(module_name)",
    )
    .eq("parsing_status", "Needs Review")
    .order("module_id")
    .order("original_question_number");
  if (moduleArg) q = q.eq("module_id", moduleArg.split("=")[1]);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    id: string;
    original_question_number: number | null;
    module_id: string;
    parsing_status: string;
    parsing_notes: string | null;
    has_image: boolean | null;
    image_urls: string[] | null;
    source_pdf_url: string | null;
    modules: { module_name: string } | { module_name: string }[] | null;
  }>;

  if (rows.length === 0) {
    console.log("No Needs Review rows match.");
    return;
  }
  const target = limit !== null ? rows.slice(0, limit) : rows;
  console.log(
    `${rows.length} Needs Review rows found; will attempt ${target.length}. apply=${apply}`,
  );

  let approved = 0;
  let stillStuck = 0;
  let skipped = 0;
  const failures: Array<{ q: number; module: string; reason: string }> = [];

  for (const row of target) {
    const moduleName = Array.isArray(row.modules)
      ? row.modules[0]?.module_name
      : row.modules?.module_name;
    const label = `Q${row.original_question_number} (${moduleName ?? row.module_id.slice(0, 8)})`;

    if (!row.source_pdf_url) {
      console.log(`  ${label}: SKIP no source_pdf_url`);
      skipped++;
      continue;
    }

    if (!apply) {
      console.log(`  ${label}: would attempt repair`);
      continue;
    }

    let mathOk = false;
    let imageOk = false;
    const blindImage =
      row.has_image === true &&
      (!Array.isArray(row.image_urls) || row.image_urls.length === 0);

    try {
      if (blindImage) {
        const r = await repairImageForQuestion(row.id);
        imageOk = r.ok;
        if (!r.ok)
          console.log(`  ${label}: image repair → ${r.message}`);
      }
      const r = await repairMathForQuestion(row.id);
      mathOk = r.ok;
      if (!r.ok) console.log(`  ${label}: math repair → ${r.message}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ${label}: ERROR ${msg}`);
      failures.push({
        q: row.original_question_number ?? 0,
        module: moduleName ?? row.module_id,
        reason: msg,
      });
      continue;
    }

    if (mathOk || imageOk) {
      // Both repair ops park the row at Draft. Promote straight to
      // Approved per Barry's directive.
      const { error: upErr } = await sb
        .from("questions")
        .update({
          parsing_status: "Approved",
          parsing_notes:
            "Auto-approved by sweep-needs-review after AI repair. Re-review if anything looks off.",
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (upErr) {
        console.log(`  ${label}: PROMOTE FAILED ${upErr.message}`);
        stillStuck++;
      } else {
        console.log(`  ${label}: APPROVED`);
        approved++;
      }
    } else {
      stillStuck++;
      failures.push({
        q: row.original_question_number ?? 0,
        module: moduleName ?? row.module_id,
        reason: "Sonnet + Opus both failed math-clean check",
      });
    }
  }

  console.log(
    `\nDone. approved=${approved} stillStuck=${stillStuck} skipped=${skipped} of ${target.length}`,
  );
  if (failures.length > 0) {
    console.log(`\n${failures.length} rows need manual review:`);
    for (const f of failures.slice(0, 50)) {
      console.log(`  Q${f.q} (${f.module}): ${f.reason}`);
    }
    if (failures.length > 50) {
      console.log(`  …and ${failures.length - 50} more.`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
