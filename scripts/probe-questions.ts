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
  const moduleId = "4172ae56-db46-4940-a60d-08966bcf8f56"; // Math
  const { data } = await db
    .from("questions")
    .select("id, original_question_number, question_type, question_text, choices, correct_answer, parsing_status, has_image, page_number")
    .eq("module_id", moduleId)
    .order("original_question_number", { ascending: true })
    .limit(3);
  console.log(JSON.stringify(data, null, 2));

  console.log("\n== Status counts ==");
  const { data: statuses } = await db
    .from("questions")
    .select("parsing_status")
    .eq("module_id", moduleId);
  const c: Record<string, number> = {};
  for (const r of statuses ?? []) {
    c[r.parsing_status] = (c[r.parsing_status] ?? 0) + 1;
  }
  console.log(c);
}
main().catch(console.error);
