import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data: mods } = await db.from("modules").select("id, module_name").ilike("module_name", "%Test #12%");
  console.log(mods);
  for (const m of mods ?? []) {
    const { data: qs } = await db.from("questions").select("original_question_number, has_image, has_table, image_urls, image_alts, parsing_notes, question_text").eq("module_id", m.id).eq("original_question_number", 9);
    console.log(m.module_name, JSON.stringify(qs, null, 1).slice(0, 1500));
  }
  const { count } = await db.from("modules").select("id", { count: "exact", head: true });
  console.log("modules", count);
})();
