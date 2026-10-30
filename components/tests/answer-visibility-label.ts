import type { VisibilityDecision } from "@/lib/answer-visibility";

type T = (key: string, values?: Record<string, string>) => string;

/** "Visible (test setting)" / "Hidden (student override)" for admin tables. */
export function answerVisibilityLabel(t: T, d: VisibilityDecision): string {
  const state = !d.answers ? t("hidden") : d.explanations ? t("withExplanations") : t("visible");
  return t("effective", { state, source: t(`source.${d.source}`) });
}
