import { getCurrentUser } from "@/lib/auth";
import Link from "next/link";
import { Construction } from "lucide-react";
import { getTranslations } from "next-intl/server";

function getDashboardLink(
  role: string | null,
  labels: { admin: string; teacher: string; student: string }
): { href: string; label: string } {
  if (role === "admin") return { href: "/admin", label: labels.admin };
  if (role === "teacher") return { href: "/teacher", label: labels.teacher };
  return { href: "/student", label: labels.student };
}

export default async function NotFound() {
  const user = await getCurrentUser();
  const [tNotFound, tDash] = await Promise.all([
    getTranslations("notFound"),
    getTranslations("dashboard"),
  ]);
  const { href, label } = getDashboardLink(user?.role ?? null, {
    admin: tDash("admin.title"),
    teacher: tDash("teacher.title"),
    student: tDash("student.title"),
  });

  return (
    <div className="min-h-screen bg-cream text-charcoal flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="inline-flex items-center justify-center p-5 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
          <Construction size={36} className="text-warm-coral" />
        </div>

        <div className="space-y-2">
          <p className="text-warm-coral text-sm font-semibold tracking-widest uppercase">
            {tNotFound("code")}
          </p>
          <h1 className="text-3xl font-bold text-charcoal">{tNotFound("title")}</h1>
          <p className="text-soft-mute text-sm leading-relaxed">
            {tNotFound("body")}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          {user ? (
            <Link
              href={href}
              className="px-5 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold transition-colors"
            >
              {label}
            </Link>
          ) : null}
          <Link
            href="/"
            className="px-5 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider text-sm transition-colors"
          >
            {tNotFound("back")}
          </Link>
        </div>
      </div>
    </div>
  );
}
