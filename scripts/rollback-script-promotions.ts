// scripts/rollback-script-promotions.ts
//
// Undo of auto-promote-high-confidence: flips every question that
// was promoted to "Approved" by the script (parsing_status='Approved'
// AND reviewed_by IS NULL) back to "Draft" so the admin can re-audit
// from scratch. Manually-approved rows (reviewed_by IS NOT NULL) are
// left alone.
//
// Use when sample audit shows the auto-promote pool has an
// unacceptable error rate.
//
// Usage:
//   npx tsx scripts/rollback-script-promotions.ts             # dry-run
//   npx tsx scripts/rollback-script-promotions.ts --apply     # actually flip
//   npx tsx scripts/rollback-script-promotions.ts --module=<uuid> --apply

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing env");
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const moduleArg = args.find((a) => a.startsWith("--module="));
const moduleId = moduleArg ? moduleArg.slice("--module=".length) : null;

async function main() {
  const sb = createClient(supabaseUrl!, supabaseKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let q = sb
    .from("questions")
    .select("id, original_question_number, module_id, ai_confidence_score")
    .eq("parsing_status", "Approved")
    .is("reviewed_by", null);
  if (moduleId) q = q.eq("module_id", moduleId);
  const { data, error } = await q;
  if (error) {
    console.error("[rollback] select failed:", error);
    process.exit(1);
  }
  const rows = data ?? [];
  console.log(
    `[rollback] script-approved rows found: ${rows.length} module=${moduleId ?? "<all>"} apply=${apply}`,
  );
  if (rows.length === 0) {
    console.log("[rollback] nothing to roll back.");
    return;
  }
  if (!apply) {
    console.log("[rollback] DRY RUN — re-run with --apply to flip.");
    return;
  }

  const now = new Date().toISOString();
  const chunk = 100;
  let total = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const ids = rows.slice(i, i + chunk).map((r) => r.id);
    const { error: upErr } = await sb
      .from("questions")
      .update({
        parsing_status: "Draft",
        reviewed_at: null,
        updated_at: now,
      })
      .in("id", ids);
    if (upErr) {
      console.error(`[rollback] chunk ${i / chunk} failed:`, upErr.message);
      process.exit(1);
    }
    total += ids.length;
    console.log(`[rollback] rolled back ${total}/${rows.length}`);
  }
  console.log(`[rollback] DONE. rolled_back=${total}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
