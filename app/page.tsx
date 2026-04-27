import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Logo from "@/components/Logo";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { getCurrentUser } from "@/lib/auth";
import Link from "next/link";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("brand");
  return {
    title: t("name"),
    description: t("tagline"),
  };
}

function HeroSection({ dashboardHref }: { dashboardHref: string | null }) {
  const t = useTranslations("landing.hero");
  const tBrand = useTranslations("brand");
  const tCommon = useTranslations("common");
  const tLanding = useTranslations("landing");

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-6 py-24 overflow-hidden">
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage:
            "linear-gradient(rgba(240,82,61,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(240,82,61,0.18) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Glow orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-10 blur-3xl bg-warm-coral" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full opacity-10 blur-3xl bg-warm-amber" />

      <div className="relative z-10 max-w-4xl mx-auto text-center">
        <div className="flex justify-center mb-10">
          <Logo size={80} />
        </div>

        <h1 className="text-3xl md:text-5xl font-bold tracking-widest uppercase mb-12 text-warm-coral">
          {tBrand("name")}
        </h1>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          {dashboardHref ? (
            <Link
              href={dashboardHref}
              className="px-8 py-4 rounded-xl font-semibold text-white bg-warm-coral hover:bg-warm-coral-dark transition-all duration-200 shadow-lg shadow-warm-coral/20 hover:shadow-warm-coral/30 hover:-translate-y-0.5"
            >
              {tLanding("goToDashboard")}
            </Link>
          ) : (
            <>
              <Link
                href="/sign-in"
                className="px-8 py-4 rounded-xl font-semibold text-white bg-warm-coral hover:bg-warm-coral-dark transition-all duration-200 shadow-lg shadow-warm-coral/20 hover:shadow-warm-coral/30 hover:-translate-y-0.5"
              >
                {t("adminCta")}
              </Link>
              <Link
                href="/sign-in"
                className="px-8 py-4 rounded-xl font-semibold text-warm-coral bg-surface border border-warm-coral/40 hover:border-warm-coral hover:bg-warm-coral/5 transition-all duration-200"
              >
                {t("teacherCta")}
              </Link>
              <Link
                href="/register"
                className="px-8 py-4 rounded-xl font-semibold text-warm-amber bg-surface border border-warm-amber/40 hover:border-warm-amber hover:bg-warm-amber/5 transition-all duration-200"
              >
                {t("studentCta")}
              </Link>
            </>
          )}
        </div>
        <p className="mt-4 text-soft-mute text-xs text-center">
          {tLanding("loginHint")}
        </p>
      </div>

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-soft-mute text-xs">
        <div className="w-px h-12 bg-gradient-to-b from-transparent to-warm-coral/60" />
      </div>
    </section>
  );
}

function FeaturesSection() {
  const features = [
    {
      icon: "↑",
      title: "Upload PDF",
      description:
        "Upload SAT module PDFs directly. Supports multi-section files for Math, Reading & Writing modules.",
      color: "text-warm-coral",
      borderColor: "border-warm-coral/20",
    },
    {
      icon: "◈",
      title: "AI Parse",
      description:
        "Claude Vision automatically extracts questions, choices, answers, and metadata from PDFs with high accuracy.",
      color: "text-warm-amber",
      borderColor: "border-warm-amber/20",
    },
    {
      icon: "◎",
      title: "Track Performance",
      description:
        "Detailed analytics on student scores, domain mastery, and progress over time with visual charts.",
      color: "text-status-success",
      borderColor: "border-status-success/20",
    },
  ];

  return (
    <section className="py-24 px-6 border-t border-divider">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-4 text-charcoal">
          Everything a tutoring center needs
        </h2>
        <p className="text-soft-mute text-center mb-16 max-w-xl mx-auto">
          From PDF upload to student analytics — fully managed, AI-powered.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {features.map((feature) => (
            <div
              key={feature.title}
              className={`p-6 rounded-2xl border ${feature.borderColor} bg-surface hover:bg-light-bg hover:border-divider transition-all duration-200`}
            >
              <div className={`text-3xl mb-4 ${feature.color}`}>
                {feature.icon}
              </div>
              <h3 className="font-semibold text-lg mb-2 text-charcoal">
                {feature.title}
              </h3>
              <p className="text-mid-gray text-sm leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const tLanding = useTranslations("landing");
  const tBrand = useTranslations("brand");

  return (
    <footer className="py-12 px-6 border-t border-divider">
      <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <Logo size={28} />
          <span className="font-semibold text-charcoal text-sm">
            {tBrand("name")}
          </span>
        </div>

        <p className="text-soft-mute text-xs text-center max-w-sm">
          {tLanding("disclaimer")}
        </p>

        <div className="flex items-center gap-4 text-xs text-soft-mute">
          <a
            href="/docs/LEGAL/terms.md"
            className="hover:text-mid-gray transition-colors"
          >
            Terms
          </a>
          <a
            href="/docs/LEGAL/privacy.md"
            className="hover:text-mid-gray transition-colors"
          >
            Privacy
          </a>
          <span>© {new Date().getFullYear()} SAT Exam OS</span>
        </div>
      </div>
    </footer>
  );
}

export default async function HomePage() {
  const user = await getCurrentUser();
  const dashboardHref = user?.role === "admin"
    ? "/admin"
    : user?.role === "teacher"
    ? "/teacher"
    : user?.role === "student"
    ? "/student"
    : null;

  return (
    <main>
      <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 py-4 bg-surface/90 backdrop-blur-md border-b border-divider">
        <Logo size={32} />
        <LanguageSwitcher />
      </nav>

      <HeroSection dashboardHref={dashboardHref} />
      <Footer />
    </main>
  );
}
