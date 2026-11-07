// Read-only: render every Approved question (stem, choices, explanation) with
// the same pipeline as components/MathMarkdown and flag text a student would
// see as raw LaTeX: KaTeX errors, or "$" / "\frac"-style commands left in plain text.
import { getServiceClient } from "@/lib/supabase";
import { renderProblems } from "@/lib/math/render-problems";

export const problems = renderProblems;

async function main() {
  const db = getServiceClient();
  let rows: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from("questions").select("id, module_id, original_question_number, question_text, choices, explanation").eq("parsing_status", "Approved").range(f, f + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
  }
  const { data: mods } = await db.from("modules").select("id, module_name");
  const mn = new Map((mods ?? []).map((m) => [m.id, m.module_name]));
  let bad = 0;
  for (const q of rows) {
    const found: string[] = [];
    for (const p of problems(q.question_text ?? "")) found.push(`stem ${p}`);
    for (const c of (q.choices ?? []) as { label: string; text: string }[]) for (const p of problems(c.text ?? "")) found.push(`choice ${c.label} ${p}`);
    for (const p of problems(q.explanation ?? "")) found.push(`explanation ${p}`);
    if (found.length) { bad++; console.log(`${q.id.slice(0, 8)} ${mn.get(q.module_id)} Q${q.original_question_number}\n   ${found.slice(0, 4).join("\n   ")}`); }
  }
  console.log(`\nscanned ${rows.length} approved questions, ${bad} with visible raw math`);
}
if (process.argv[1]?.endsWith("scan-math-render.ts")) main();
