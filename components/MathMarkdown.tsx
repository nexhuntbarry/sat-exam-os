import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMath } from "@/lib/math/normalize-math";

export { normalizeMath };

export default function MathMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const normalized = normalizeMath(children);
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
