'use client';

import { useTranslations } from "next-intl";
import { Info } from "lucide-react";

interface PageIntroProps {
  /**
   * Translation key prefix under the `intros` namespace, e.g. "admin.modules".
   * The component looks up `intros.<tKey>.title` and `intros.<tKey>.body`.
   */
  tKey: string;
}

/**
 * Locale-aware page-purpose block.
 * Subtle warm-coral tinted card matching SAT's cream/coral theme — sits
 * below the topbar, above any tables/forms. Client component so it works
 * inside both server and client pages.
 */
export default function PageIntro({ tKey }: PageIntroProps) {
  const t = useTranslations("intros");
  const title = t(`${tKey}.title`);
  const body = t(`${tKey}.body`);

  return (
    <div className="mb-5 rounded-xl border border-warm-coral/15 bg-warm-coral-soft/40 px-4 py-3 flex items-start gap-3">
      <Info size={14} className="text-warm-coral/80 flex-shrink-0 mt-0.5" />
      <div className="space-y-1">
        <p className="text-xs font-semibold text-warm-coral-dark uppercase tracking-wider">
          {title}
        </p>
        <p className="text-sm text-mid-gray leading-relaxed">{body}</p>
      </div>
    </div>
  );
}
