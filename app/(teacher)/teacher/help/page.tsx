import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  Users,
  Presentation,
  ClipboardList,
  BarChart2,
  HelpCircle,
} from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";

export default async function TeacherHelpPage() {
  const t = await getTranslations("teacherHelp");

  const steps = [
    {
      icon: Users,
      title: t("step1.title"),
      body: t("step1.body"),
      cta: { href: "/teacher/settings", label: t("step1.cta") },
    },
    {
      icon: Presentation,
      title: t("step2.title"),
      body: t("step2.body"),
      cta: { href: "/teacher/teaching-mode", label: t("step2.cta") },
    },
    {
      icon: ClipboardList,
      title: t("step3.title"),
      body: t("step3.body"),
      cta: { href: "/teacher/tests", label: t("step3.cta") },
    },
    {
      icon: BarChart2,
      title: t("step4.title"),
      body: t("step4.body"),
      cta: { href: "/teacher/results", label: t("step4.cta") },
    },
  ];

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <PageIntro tKey="teacher.help" />

      <div className="flex items-center gap-3">
        <HelpCircle size={22} className="text-warm-coral" />
        <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>
      </div>

      <p className="text-mid-gray text-sm">{t("intro")}</p>

      <ol className="space-y-4">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          return (
            <li
              key={idx}
              className="bg-surface border border-divider rounded-2xl p-5 flex gap-4 items-start"
            >
              <div className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-warm-coral/10 text-warm-coral font-semibold">
                {idx + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Icon size={16} className="text-warm-coral" />
                  <h2 className="text-charcoal font-semibold text-base">
                    {step.title}
                  </h2>
                </div>
                <p className="text-mid-gray text-sm leading-relaxed mb-3">
                  {step.body}
                </p>
                {step.cta && (
                  <Link
                    href={step.cta.href}
                    className="inline-flex items-center gap-1 text-sm font-medium text-warm-coral hover:underline"
                  >
                    {step.cta.label} →
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="bg-warm-amber/10 border border-warm-amber/20 rounded-2xl p-5 text-sm text-charcoal">
        <p className="font-medium mb-1">{t("supportTitle")}</p>
        <p className="text-mid-gray">{t("supportBody")}</p>
      </div>
    </div>
  );
}
