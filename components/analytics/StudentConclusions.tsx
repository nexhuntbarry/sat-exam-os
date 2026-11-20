import { getLocale, getTranslations } from "next-intl/server";
import { Lightbulb, Star, Target, Timer } from "lucide-react";
import { studentConclusions, type Segment } from "@/lib/conclusions";
import en from "@/lib/conclusions/templates.en";
import zh from "@/lib/conclusions/templates.zh";
import type { Occasion } from "@/lib/score-analysis";

const ICON: Record<Segment, typeof Star> = { strength: Star, focus: Target, habit: Timer };
const TONE: Record<Segment, string> = {
  strength: "bg-status-success/12 text-status-success",
  focus: "bg-warm-coral/12 text-warm-coral-text",
  habit: "bg-status-info/12 text-status-info",
};

/**
 * Overview "Key takeaways": top strength, focus area and one test habit,
 * written from sentence templates (lib/conclusions), no AI. `occasions` must
 * already be limited to what the viewer may see (getStudentProgressOccasions
 * with { habits: true }; a single-subject teacher: their section only).
 */
export default async function StudentConclusions({
  occasions,
  studentId,
  displayName,
}: {
  occasions: Occasion[];
  studentId: string;
  displayName: string | null;
}) {
  const [t, locale] = await Promise.all([getTranslations("studentTabs"), getLocale()]);
  const bank = locale === "zh" ? zh : en;
  const name = displayName?.trim().split(/\s+/)[0] || t("thisStudent");
  const result = studentConclusions(occasions, studentId, bank, name);
  return (
    <section className="rounded-2xl border border-divider bg-surface p-5 md:p-6">
      <div className="flex items-center gap-2 mb-3">
        <Lightbulb size={18} className="text-warm-coral-text" />
        <div>
          <h2 className="text-base font-semibold text-charcoal">{t("takeawaysTitle")}</h2>
          <p className="text-xs text-soft-mute">{t("takeawaysSubtitle")}</p>
        </div>
      </div>
      {result.thin ? (
        <p className="text-sm text-soft-mute py-1">{result.message}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-3">
          {result.items.map((c) => {
            const Icon = ICON[c.segment];
            return (
              <li key={c.segment} className="rounded-xl border border-divider bg-light-bg/40 p-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${TONE[c.segment]}`}>
                    <Icon size={13} aria-hidden />
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wide text-soft-mute">
                    {t(`segment.${c.segment}`)}
                  </span>
                </div>
                <p className="text-sm text-charcoal leading-relaxed">{c.text}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
