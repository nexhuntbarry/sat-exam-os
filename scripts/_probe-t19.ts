import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data: mods } = await db.from("modules").select("id, module_name, section, pdf_url, created_at").ilike("module_name", "%Test #19%");
  console.log(mods);
  for (const m of mods ?? []) {
    const { data: qs } = await db.from("questions").select("original_question_number, page_number, choices, correct_answer, official_answer, parsing_status, parsing_notes, question_text").eq("module_id", m.id).order("original_question_number").lte("original_question_number", 8);
    for (const q of qs ?? []) console.log(m.module_name, q.original_question_number, "p" + q.page_number, q.correct_answer, q.official_answer, q.parsing_status, JSON.stringify(q.choices), "|", (q.parsing_notes||"").slice(0,200), "|", q.question_text.slice(-150).replace(/\n/g," "));
  }
})();
