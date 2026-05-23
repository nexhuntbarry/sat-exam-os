// scripts/strip-blank-word.ts
//
// SAT R&W transition / vocab-in-context questions use a row of
// underscores as the fill-in spot. The PDF parser was emitting the
// literal English word "blank" right after the underscores ("______
// blank time did not stand still…"), making the passage read
// nonsensically to the student. This script strips the spurious word
// from every affected question_text without touching the underscores.
//
// Idempotent — safe to re-run; rows that no longer match the pattern
// are left alone.
//
// Usage: npx tsx scripts/strip-blank-word.ts [--dry-run]

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const dryRun = process.argv.includes("--dry-run");

// Match a run of >=2 underscores followed by optional whitespace and
// the literal word "blank" (case-insensitive), with a word boundary
// after so we don't gobble "blanks" or "blanket". The substitution
// keeps the underscores and the surrounding spacing intact.
const PATTERN = /(_{2,})\s+blank\b/gi;

async function main() {
  const sb = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Pull every question whose text matches the parser-bug shape. ilike
  // is good enough to narrow the read; the regex above gates the
  // actual rewrite.
  const { data, error } = await sb
    .from("questions")
    .select("id, original_question_number, question_text")
    .or(
      "question_text.ilike.%__ blank%,question_text.ilike.%___ blank%,question_text.ilike.%____ blank%",
    );
  if (error) {
    console.error("Query failed:", error);
    process.exit(1);
  }
  console.log(
    `[strip-blank-word] candidates=${data?.length ?? 0} dry_run=${dryRun}`,
  );

  let patched = 0;
  let unchanged = 0;
  for (const q of data ?? []) {
    const original: string = q.question_text ?? "";
    PATTERN.lastIndex = 0;
    if (!PATTERN.test(original)) {
      unchanged++;
      continue;
    }
    const next = original.replace(PATTERN, "$1");
    if (next === original) {
      unchanged++;
      continue;
    }
    console.log(`  ✓ Q${q.original_question_number} ${q.id}`);
    if (!dryRun) {
      const { error: upErr } = await sb
        .from("questions")
        .update({ question_text: next })
        .eq("id", q.id);
      if (upErr) {
        console.error(`    ! update failed:`, upErr.message);
        continue;
      }
    }
    patched++;
  }
  console.log(`[strip-blank-word] done. patched=${patched} unchanged=${unchanged}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
