import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/components/ui/data-table/cn";

/** Detail page header: back link, name, one summary line, then the actions
 *  (main action, Edit, ⋯ for the rest) on the right. */
export function DetailHeader({
  back,
  title,
  badge,
  summary,
  actions,
}: {
  back?: { href: string; label: string };
  title: ReactNode;
  /** Status badge shown next to the name. */
  badge?: ReactNode;
  /** One line under the name (e.g. "Math · 2 modules · 35 + 35 min"). */
  summary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {back && (
        <Link
          href={back.href}
          className="inline-flex items-center gap-1 text-soft-mute text-sm hover:text-charcoal transition-colors"
        >
          <ChevronLeft size={14} />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-bold text-charcoal break-words">{title}</h1>
            {badge}
          </div>
          {summary && <div className="mt-1 text-sm text-soft-mute">{summary}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** The 3–4 key numbers under a detail header. Neutral colours only. */
export function StatCards({
  items,
  className,
}: {
  items: { label: string; value: ReactNode; detail?: ReactNode; title?: string }[];
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:gap-4", items.length >= 4 ? "md:grid-cols-4" : "md:grid-cols-3", className)}>
      {items.map((it) => (
        <div key={it.label} title={it.title} className="rounded-2xl border border-divider bg-surface px-5 py-4">
          <p className="text-xs text-soft-mute">{it.label}</p>
          <p className="mt-1 text-2xl font-bold text-charcoal leading-tight">{it.value}</p>
          {it.detail && <p className="mt-0.5 text-xs text-soft-mute">{it.detail}</p>}
        </div>
      ))}
    </div>
  );
}
