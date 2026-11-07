// Render text with the same pipeline as components/MathMarkdown and report
// what a student would see as raw LaTeX: KaTeX errors, or "$" / "\frac"-style
// commands left in plain text. (Moved from scripts/scan-math-render.ts so the
// explanation auto-fix can use it server-side.)
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import { normalizeMath } from "@/lib/math/normalize-math";

type Node = { type: string; tagName?: string; value?: string; properties?: { className?: string[] }; children?: Node[] };
const proc = unified().use(remarkParse).use(remarkMath).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeKatex, { strict: "ignore" as const, throwOnError: false });

export function renderProblems(src: string): string[] {
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
