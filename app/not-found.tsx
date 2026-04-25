import { getCurrentUser } from "@/lib/auth";
import Link from "next/link";
import { Construction } from "lucide-react";

function getDashboardLink(role: string | null): { href: string; label: string } {
  if (role === "admin") return { href: "/admin", label: "Admin Dashboard" };
  if (role === "teacher") return { href: "/teacher", label: "Teacher Dashboard" };
  return { href: "/student", label: "Student Dashboard" };
}

export default async function NotFound() {
  const user = await getCurrentUser();
  const { href, label } = getDashboardLink(user?.role ?? null);

  return (
    <div className="min-h-screen bg-deep-navy text-soft-gray flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="inline-flex items-center justify-center p-5 rounded-2xl bg-electric-blue/10 border border-electric-blue/20">
          <Construction size={36} className="text-electric-blue" />
        </div>

        <div className="space-y-2">
          <p className="text-electric-blue text-sm font-semibold tracking-widest uppercase">
            404
          </p>
          <h1 className="text-3xl font-bold text-white">Page Not Found</h1>
          <p className="text-soft-gray/50 text-sm leading-relaxed">
            This page doesn&apos;t exist yet or is being built.
          </p>
          <p className="text-soft-gray/30 text-xs">
            此頁尚未建置 / This page is being built
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          {user ? (
            <Link
              href={href}
              className="px-5 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white text-sm font-semibold transition-colors"
            >
              {label}
            </Link>
          ) : null}
          <Link
            href="/"
            className="px-5 py-2.5 rounded-xl border border-white/10 text-soft-gray/70 hover:text-soft-gray hover:border-white/20 text-sm transition-colors"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
