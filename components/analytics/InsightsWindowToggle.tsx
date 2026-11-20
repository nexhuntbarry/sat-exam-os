"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { clsx } from "clsx";

/**
 * "Last 3 tests" / "All tests" switch for the student insight blocks. Both
 * views are rendered on the server (lib/insights-window); this only picks
 * which one shows.
 */
export default function InsightsWindowToggle({
  recentTests,
  totalTests,
  recentList,
  recent,
  all,
}: {
  recentTests: number;
  totalTests: number;
  /** Names of the tests in the recent window. */
  recentList: string;
  recent: ReactNode;
  all: ReactNode;
}) {
  const t = useTranslations("studentInsights");
  const [view, setView] = useState<"recent" | "all">("recent");
  const btn = (v: "recent" | "all", label: string) => (
    <button
      type="button"
      onClick={() => setView(v)}
      aria-pressed={view === v}
      className={clsx(
        "px-3 py-1 text-xs font-medium rounded-lg transition-colors",
        view === v ? "bg-surface text-charcoal shadow-sm" : "text-mid-gray hover:text-charcoal",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-soft-mute">{t("windowLabel")}</span>
        <div className="inline-flex gap-0.5 rounded-xl bg-light-bg border border-divider p-0.5">
          {btn("recent", t("recent", { n: recentTests }))}
          {btn("all", t("all", { n: totalTests }))}
        </div>
        {view === "recent" && (
          <span className="text-xs text-soft-mute basis-full sm:basis-auto">{t("inWindow", { list: recentList })}</span>
        )}
      </div>
      {view === "recent" ? recent : all}
    </div>
  );
}
