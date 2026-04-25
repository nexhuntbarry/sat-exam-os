import Link from "next/link";
import { Construction } from "lucide-react";

interface ComingSoonProps {
  title: string;
  description?: string;
  dashboardHref: string;
  dashboardLabel?: string;
}

export default function ComingSoon({
  title,
  description = "This page is being built and will be available soon.",
  dashboardHref,
  dashboardLabel = "Back to Dashboard",
}: ComingSoonProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 max-w-md mx-auto">
      <div className="p-5 rounded-2xl bg-electric-blue/10 border border-electric-blue/20">
        <Construction size={36} className="text-electric-blue" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        <p className="text-soft-gray/50 text-sm leading-relaxed">{description}</p>
        <p className="text-soft-gray/30 text-xs mt-1">
          此頁尚未建置 / This page is being built
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <Link
          href={dashboardHref}
          className="px-5 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white text-sm font-semibold transition-colors"
        >
          {dashboardLabel}
        </Link>
        <Link
          href="/"
          className="px-5 py-2.5 rounded-xl border border-white/10 text-soft-gray/70 hover:text-soft-gray hover:border-white/20 text-sm transition-colors"
        >
          Home
        </Link>
      </div>
    </div>
  );
}
