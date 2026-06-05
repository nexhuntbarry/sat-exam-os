// One-off: find the most recently uploaded module and dump Q2 so
// the agent can see the broken row Barry referenced ("剛上傳的
// module 的第二題").

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

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: mods } = await sb
    .from("modules")
    .select("id, module_name, created_at")
    .order("created_at", { ascending: false })
    .limit(3);
  console.log("Latest 3 modules:");
  for (const m of mods ?? []) {
    console.log(`  · ${m.id} | ${m.module_name} | ${m.created_at}`);
  }
  const latest = mods?.[0];
  if (!latest) return;
  const { data: q } = await sb
    .from("questions")
    .select(
      "id, original_question_number, parsing_status, parsing_notes, correct_answer, question_text, choices, explanation",
    )
    .eq("module_id", latest.id)
    .eq("original_question_number", 2)
    .maybeSingle();
  console.log(`\nModule: ${latest.module_name}`);
  console.log(`Q2 →`);
  console.log(JSON.stringify(q, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
