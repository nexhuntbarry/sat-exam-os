import { readFileSync } from "fs";
import path from "path";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Logo from "@/components/Logo";

export type LegalSlug = "terms" | "privacy" | "disclaimer";

const LINKS: { slug: LegalSlug; label: string }[] = [
  { slug: "terms", label: "Terms" },
  { slug: "privacy", label: "Privacy" },
  { slug: "disclaimer", label: "Disclaimer" },
];

// The drafts live in docs/LEGAL as the single source of truth; next.config
// traces each file into its route so the read works on Vercel.
export function readLegalDoc(slug: LegalSlug): string {
  return readFileSync(path.join(process.cwd(), "docs", "LEGAL", `${slug}.md`), "utf8");
}

export default function LegalDoc({ slug }: { slug: LegalSlug }) {
  const markdown = readLegalDoc(slug);
  return (
    <div className="min-h-screen bg-cream text-charcoal">
      <header className="border-b border-divider">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={26} />
            <span className="font-semibold text-sm">SAT Exam OS</span>
          </Link>
          <nav className="flex gap-4 text-xs text-soft-mute">
            {LINKS.map((l) => (
              <Link
                key={l.slug}
                href={`/${l.slug}`}
                className={l.slug === slug ? "text-charcoal font-medium" : "hover:text-mid-gray"}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-12">
        <article className="prose prose-sm sm:prose-base max-w-none prose-headings:text-charcoal prose-p:text-mid-gray prose-li:text-mid-gray">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </article>
      </main>
    </div>
  );
}
