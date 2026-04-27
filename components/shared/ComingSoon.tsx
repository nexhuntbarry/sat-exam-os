import Link from "next/link";
import { Construction } from "lucide-react";
import { getTranslations } from "next-intl/server";

interface ComingSoonProps {
  title: string;
  description?: string;
  dashboardHref: string;
  dashboardLabel?: string;
}

export default async function ComingSoon({
  title,
  description,
  dashboardHref,
  dashboardLabel,
}: ComingSoonProps) {
  const t = await getTranslations("comingSoon");
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 max-w-md mx-auto">
      <div className="p-5 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
        <Construction size={36} className="text-warm-coral" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-charcoal">{title}</h1>
        <p className="text-soft-mute text-sm leading-relaxed">
          {description ?? t("defaultDescription")}
        </p>
        <p className="text-soft-mute text-xs mt-1">{t("subtitle")}</p>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <Link
          href={dashboardHref}
          className="px-5 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold transition-colors"
        >
          {dashboardLabel ?? t("backToDashboard")}
        </Link>
        <Link
          href="/"
          className="px-5 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider text-sm transition-colors"
        >
          {t("home")}
        </Link>
      </div>
    </div>
  );
}
