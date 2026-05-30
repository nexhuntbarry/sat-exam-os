// scripts/auto-promote-high-confidence.ts
//
// Bulk-promote Draft questions whose AI confidence score is at or
// above a threshold to parsing_status="Approved". The Draft bucket
// is the parser's "solver produced an answer but no human has signed
// off yet" pile — for high-confidence rows that signoff is mostly a
// rubber stamp, and the admin would rather spend their review budget
// on Needs Review or low-confidence Draft.
//
// SAFETY:
// - Dry-run by default. Pass --apply to actually write.
// - Default threshold is 0.95 (very high). Lower with --threshold=0.9.
// - Skips rows with empty/null correct_answer (solver punted).
// - Skips rows where has_image=true but image_urls is empty (solver
//   was answering blind — already flagged by the pipeline but defend
//   in depth).
// - Optional --module=<uuid> scopes to one module.
// - Optional --limit=N caps the number promoted per run.
// - Excludes Needs Review and Rejected — only Draft is touched.
//
// Usage examples:
//   npx tsx scripts/auto-promote-high-confidence.ts
//     → dry-run, threshold 0.95, all modules
//   npx tsx scripts/auto-promote-high-confidence.ts --threshold=0.9
//     → dry-run with a slightly looser threshold
//   npx tsx scripts/auto-promote-high-confidence.ts --apply
//     → actually promote at threshold 0.95
//   npx tsx scripts/auto-promote-high-confidence.ts \
//     --module=abcd-... --threshold=0.92 --apply
//     → promote within one module at 0.92 cutoff

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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
const threshold = Number(flag("threshold") ?? "0.95");
if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
  console.error("Invalid --threshold (expected number 0..1)");
  process.exit(1);
}
const moduleId = flag("module") ?? null;
const limit = flag("limit") ? Number(flag("limit")) : null;
if (limit !== null && (Number.isNaN(limit) || limit <= 0)) {
  console.error("Invalid --limit (expected positive integer)");
  process.exit(1);
}

async function main() {
  const sb = createClient(supabaseUrl!, supabaseKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(
    `[auto-promote] threshold=${threshold} module=${moduleId ?? "<all>"} limit=${limit ?? "<none>"} apply=${apply}`,
  );

  // Select Draft rows above the threshold with a non-empty answer.
  // We also pull image-related fields so we can defend-in-depth against
  // the "solver answered blind because the image wasn't uploaded" case.
  let q = sb
    .from("questions")
    .select(
      "id, original_question_number, module_id, ai_confidence_score, correct_answer, has_image, image_urls",
    )
    .eq("parsing_status", "Draft")
    .gte("ai_confidence_score", threshold);
  if (moduleId) q = q.eq("module_id", moduleId);
  const { data: candidates, error } = await q;
  if (error) {
    console.error("[auto-promote] select failed:", error);
    process.exit(1);
  }

  const promotable = (candidates ?? []).filter((row) => {
    const hasAnswer =
      row.correct_answer != null && String(row.correct_answer).trim() !== "";
    if (!hasAnswer) return false;
    const blindImage =
      row.has_image === true &&
      (!Array.isArray(row.image_urls) || row.image_urls.length === 0);
    if (blindImage) return false;
    return true;
  });
  const skipped = (candidates ?? []).length - promotable.length;
  const subset = limit !== null ? promotable.slice(0, limit) : promotable;

  console.log(
    `[auto-promote] candidates=${candidates?.length ?? 0} promotable=${promotable.length} skipped=${skipped} will_promote=${subset.length}`,
  );

  if (subset.length === 0) {
    console.log("[auto-promote] nothing to do.");
    return;
  }

  if (!apply) {
    console.log("[auto-promote] DRY RUN — re-run with --apply to write.");
    console.log("  sample of first 10 rows that would be promoted:");
    for (const r of subset.slice(0, 10)) {
      console.log(
        `    ${r.id} Q${r.original_question_number} conf=${r.ai_confidence_score} ans=${r.correct_answer}`,
      );
    }
    return;
  }

  // Apply in chunks so a single huge update doesn't time out and so
  // we can resume cleanly if something fails partway.
  const now = new Date().toISOString();
  const chunk = 100;
  let total = 0;
  for (let i = 0; i < subset.length; i += chunk) {
    const ids = subset.slice(i, i + chunk).map((r) => r.id);
    const { error: upErr } = await sb
      .from("questions")
      .update({
        parsing_status: "Approved",
        reviewed_at: now,
        updated_at: now,
        // reviewed_by intentionally left null — this is an automated
        // promotion, not a human signoff. Filtering reviewed_by IS NULL
        // is the clean way to spot "approved by script" rows later if
        // you want to re-audit.
      })
      .in("id", ids);
    if (upErr) {
      console.error(
        `[auto-promote] chunk ${i / chunk} failed:`,
        upErr.message,
      );
      console.error(`  IDs in this chunk:`, ids);
      process.exit(1);
    }
    total += ids.length;
    console.log(`[auto-promote] promoted ${total}/${subset.length}`);
  }
  console.log(`[auto-promote] DONE. promoted=${total}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
