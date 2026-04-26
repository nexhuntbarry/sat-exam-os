/**
 * Reset the published test for a clean re-take by the actual user.
 * Removes the e2e script's synthetic submission so the real user gets a fresh start.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const TEST_ID = "e89070ae-61e5-4d96-8b08-ed091a1e8245";
  const { data: subs } = await db
    .from("submissions")
    .select("id, student_id, status")
    .eq("test_id", TEST_ID);
  console.log("Found:", subs);
  for (const s of subs ?? []) {
    await db.from("answer_records").delete().eq("submission_id", s.id);
    await db.from("submissions").delete().eq("id", s.id);
    console.log(`  deleted submission ${s.id}`);
  }
  // Also enable allow_retake + show_answers_after_submission so user can re-take + see results
  await db
    .from("tests")
    .update({ allow_retake: true, show_answers_after_submission: true })
    .eq("id", TEST_ID);
  console.log("Enabled allow_retake + show_answers_after_submission");
}

main().catch((e) => { console.error(e); process.exit(1); });
