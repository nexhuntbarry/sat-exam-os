// scripts/fix-spr-choices.ts
//
// Finds every question where question_type = 'Student Produced Response'
// AND choices is non-empty, then strips those phantom choices.
//
// Usage:
//   npx tsx scripts/fix-spr-choices.ts          # dry-run (print only)
//   npx tsx scripts/fix-spr-choices.ts --apply  # perform the UPDATE
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const APPLY = process.argv.includes("--apply");

const envText = readFileSync(".env.local", "utf-8");
for (const l of envText.split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  // Fetch all SPR questions that still carry non-empty choices.
  const { data: rows, error } = await db
    .from("questions")
    .select("id, module_id, original_question_number, choices")
    .eq("question_type", "Student Produced Response")
    .not("choices", "eq", "[]");

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  const affected = (rows ?? []).filter(
    (r) => Array.isArray(r.choices) && r.choices.length > 0,
  );

  if (affected.length === 0) {
    console.log("No SPR questions with phantom choices found. Nothing to do.");
    return;
  }

  console.log(
    `Found ${affected.length} SPR question(s) with phantom choices:`,
  );
  for (const r of affected) {
    console.log(
      `  id=${r.id}  module=${r.module_id}  Q${r.original_question_number}  choices=${(r.choices as unknown[]).length}`,
    );
  }

  if (!APPLY) {
    console.log(
      "\nDry-run — pass --apply to clear choices on these rows.",
    );
    return;
  }

  // Perform the update in a single batch by id.
  const ids = affected.map((r) => r.id as string);
  const { error: updateError } = await db
    .from("questions")
    .update({ choices: [] })
    .in("id", ids);

  if (updateError) {
    console.error("Update failed:", updateError.message);
    process.exit(1);
  }

  console.log(`\nCleared choices on ${ids.length} row(s).`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
