// Read-only: render every Approved question (stem, choices, explanation) with
// the same pipeline as components/MathMarkdown and flag text a student would
// see as raw LaTeX: KaTeX errors, or "$" / "\frac"-style commands left in plain text.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import { getServiceClient } from "@/lib/supabase";
import { normalizeMath } from "@/lib/math/normalize-math";

type Node = { type: string; tagName?: string; value?: string; properties?: { className?: string[] }; children?: Node[] };
const proc = unified().use(remarkParse).use(remarkMath).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeKatex, { strict: "ignore" as const, throwOnError: false });

export function problems(src: string): string[] {
  const tree = proc.runSync(proc.parse(normalizeMath(src))) as Node;
  const out: string[] = [];
  const walk = (n: Node, inKatex: boolean) => {
    const cls = n.properties?.className ?? [];
    if (cls.includes("katex-error")) { out.push(`KaTeX error: ${JSON.stringify(n.properties)?.slice(0, 120)}`); return; }
    const k = inKatex || cls.includes("katex");
    // "$" before a digit is a dollar amount and reads fine; any other "$",
    // a backslash command or ^{ / _{ is LaTeX the student would see raw.
    if (n.type === "text" && !k && n.value) {
      const m = n.value.match(/\$(?![\d.,])|\\[a-zA-Z]+|\\\s|\^\{|_\{/);
      if (m) out.push(`raw "${m[0]}": "${n.value.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 40).replace(/\s+/g, " ")}"`);
    }
    for (const c of n.children ?? []) walk(c, k);
  };
  walk(tree, false);
  return out;
}

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
