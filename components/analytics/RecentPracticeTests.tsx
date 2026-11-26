import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { History } from "lucide-react";
import { formatShortDate } from "@/lib/datetime";
import { SubjectTag } from "@/components/ui/StatusBadge";
import {
  formatScoreChange,
  recentScoreRows,
  RECENT_SCORES_DEFAULT,
  type RecentScoreItem,
  type RecentScoreRow,
} from "@/lib/recent-scores";

/**
 * First block of the admin / teacher student pages: the student's finished
 * practice tests, newest first (RECENT_SCORES_DEFAULT, then "Show all"),
 * with the real stored scores and the change vs. the previous test of the
 * same section (a full-length SAT: its 400–1600 total vs. the previous one).
 */
export default async function RecentPracticeTests({ items }: { items: RecentScoreItem[] }) {
  const t = await getTranslations("recentScores");
  const rows = recentScoreRows(items);
  const sectionLabel = (s: string) => (s === "Math" ? t("math") : s === "Reading & Writing" ? t("rw") : s);

  const row = (r: RecentScoreRow) => {
    const name = r.href ? (
      <Link href={r.href} className="hover:text-warm-coral-text transition-colors">
        {r.testName}
      </Link>
    ) : (
      r.testName
    );
    const est = r.estimated ? (
      <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-soft-mute">{t("estimated")}</span>
    ) : null;
    return (
      <li key={r.key} className="grid grid-cols-[3.5rem_1fr] sm:grid-cols-[3.5rem_minmax(0,1fr)_9.5rem_11rem_8.5rem] gap-x-4 gap-y-0.5 py-2.5 items-baseline">
        <span className="text-xs text-soft-mute tabular-nums">{formatShortDate(r.date)}</span>
        <span className="min-w-0 text-sm font-medium text-charcoal">
          {name}
          {r.kind === "full" && <SubjectTag fullLength label={t("fullLength")} className="ml-2" />}
        </span>
        <span className="col-start-2 sm:col-start-auto text-sm tabular-nums whitespace-nowrap">
          {r.kind === "full" ? (
            <>
              <span className="font-bold text-charcoal">
                {t("total")} {r.total ?? "—"}
              </span>
              {est}
              <span className="block text-xs text-mid-gray">
                {r.sections.map((s) => `${sectionLabel(s.section)} ${s.sat ?? "—"}`).join(" · ")}
              </span>
            </>
          ) : (
            <>
              <span className="font-bold text-charcoal">
                <SubjectTag section={r.sections[0]?.section} label={sectionLabel(r.sections[0]?.section ?? "")} className="mr-1.5" />
                {r.sections[0]?.sat ?? "—"}
              </span>
              {est}
            </>
          )}
        </span>
        <span className="col-start-2 sm:col-start-auto text-xs text-mid-gray tabular-nums">
          {r.kind === "full"
            ? r.sections.map((s) => (
                <span key={s.section} className="block whitespace-nowrap">
                  {sectionLabel(s.section)} {s.modules.filter(Boolean).join(" · ") || "—"}
                </span>
              ))
            : r.sections[0]?.modules.map((m, i) => `M${i + 1} ${m}`).join(" · ") || "—"}
        </span>
        <span className="col-start-2 sm:col-start-auto sm:text-right text-xs tabular-nums whitespace-nowrap">
          {r.change ? (
            <span
              className={
                r.change.delta > 0
                  ? "font-semibold text-status-success"
                  : r.change.delta < 0
                    ? "font-semibold text-warm-coral-text"
                    : "text-soft-mute"
              }
            >
              {t("vs", { delta: formatScoreChange(r.change.delta), date: formatShortDate(r.change.vsDate) })}
            </span>
          ) : r.score != null ? (
            <span className="text-soft-mute">{t("first")}</span>
          ) : null}
        </span>
      </li>
    );
  };

  const head = rows.slice(0, RECENT_SCORES_DEFAULT);
  const rest = rows.slice(RECENT_SCORES_DEFAULT);
  return (
    <section className="rounded-2xl border border-divider bg-surface p-5 md:p-6">
      <div className="flex items-center gap-2 mb-2">
        <History size={18} className="text-warm-coral-text" />
        <div>
          <h2 className="text-base font-semibold text-charcoal">{t("title")}</h2>
          <p className="text-xs text-soft-mute">{t("subtitle")}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-soft-mute py-2">{t("empty")}</p>
      ) : (
        <>
          <div className="hidden sm:grid grid-cols-[3.5rem_minmax(0,1fr)_9.5rem_11rem_8.5rem] gap-x-4 border-b border-divider pb-1.5 text-[11px] uppercase tracking-wide text-soft-mute">
            <span>{t("colDate")}</span>
            <span>{t("colTest")}</span>
            <span>{t("colScore")}</span>
            <span>{t("colModules")}</span>
            <span className="text-right">{t("colChange")}</span>
          </div>
          <ul className="divide-y divide-divider/60">
            {head.map(row)}
          </ul>
          {rest.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer list-none select-none pt-2 text-sm font-medium text-warm-coral-text hover:underline">
                <span className="group-open:hidden">{t("showAll", { n: rows.length })}</span>
                <span className="hidden group-open:inline">{t("showLess")}</span>
              </summary>
              <ul className="divide-y divide-divider/60 border-t border-divider/60 mt-2">
                {rest.map(row)}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
