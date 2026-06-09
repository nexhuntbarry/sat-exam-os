import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";
import { normalizeMath } from "@/lib/math/normalize-math";

export { normalizeMath };

// SAT R&W questions that ask "function of the underlined portion in
// the text" depend on raw <u>…</u> markup in question_text actually
// rendering as an underline. ReactMarkdown drops raw HTML by default,
// so we enable rehype-raw and ship a tiny allowlist of tags we trust
// (only u and br right now; ReactMarkdown still escapes everything
// else as text). remark-gfm is on so that the same prose can use the
// occasional inline ~~strike~~ for SAT "Wrong answer" callouts in
// explanations without surprises.
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
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          // KaTeX defaults render broken math in bright red with a
          // pop-up tooltip pointing at the LaTeX parser error —
          // terrifying for admins reviewing imperfect parser output.
          // We soften it: ignore strict-mode warnings (no console
          // noise), render any unrenderable region in a neutral
          // gray so the row still reads like a placeholder instead
          // of an emergency, and never throw (default already).
          [
            rehypeKatex,
            { strict: "ignore", errorColor: "#9ca3af", throwOnError: false },
          ],
        ]}
        components={{
          u: ({ children }) => (
            <u className="underline decoration-2 underline-offset-4">
              {children}
            </u>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
