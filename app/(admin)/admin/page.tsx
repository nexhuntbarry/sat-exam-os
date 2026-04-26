import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { Users, GraduationCap, BookOpen, ClipboardList, HelpCircle, Clock } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";

async function getAdminStats() {
  const db = getServiceClient();

  const [pending, approved, teachers, modules] = await Promise.all([
    db.from("users").select("id", { count: "exact", head: true }).eq("role", "student").eq("account_status", "pending"),
    db.from("users").select("id", { count: "exact", head: true }).eq("role", "student").eq("account_status", "approved"),
    db.from("users").select("id", { count: "exact", head: true }).eq("role", "teacher").eq("account_status", "approved"),
    db.from("modules").select("id", { count: "exact", head: true }),
  ]);

  return {
    pendingStudents: pending.count ?? 0,
    approvedStudents: approved.count ?? 0,
    teachers: teachers.count ?? 0,
    modules: modules.count ?? 0,
  };
}

export default async function AdminDashboardPage() {
  const [user, stats] = await Promise.all([getCurrentUser(), getAdminStats()]);

  const statCards = [
    {
      label: "Pending Students",
      value: stats.pendingStudents,
      icon: Clock,
      color: "text-status-warning",
      bg: "bg-status-warning/10 border-status-warning/20",
      href: "/admin/students",
    },
    {
      label: "Approved Students",
      value: stats.approvedStudents,
      icon: Users,
      color: "text-warm-amber",
      bg: "bg-warm-amber/10 border-warm-amber/20",
      href: "/admin/students?tab=approved",
    },
    {
      label: "Teachers",
      value: stats.teachers,
      icon: GraduationCap,
      color: "text-warm-coral",
      bg: "bg-warm-coral/10 border-warm-coral/20",
      href: "/admin/teachers",
    },
    {
      label: "Modules",
      value: stats.modules,
      icon: BookOpen,
      color: "text-status-success",
      bg: "bg-status-success/10 border-status-success/20",
      href: "/admin/modules",
    },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <PageIntro tKey="admin.dashboard" />
      <div>
        <h1 className="text-2xl font-bold text-charcoal">
          Welcome back, {user?.displayName ?? "Admin"}
        </h1>
        <p className="text-soft-mute text-sm mt-1">Here&apos;s an overview of your platform.</p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <a
            key={card.label}
            href={card.href}
            className={`flex items-center gap-4 p-5 rounded-2xl border ${card.bg} hover:opacity-80 transition-opacity`}
          >
            <div className={`p-3 rounded-xl bg-light-bg`}>
              <card.icon size={20} className={card.color} />
            </div>
            <div>
              <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
              <div className="text-mid-gray text-xs mt-0.5">{card.label}</div>
            </div>
          </a>
        ))}
      </div>

      {/* Two column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pending Approvals */}
        <div className="bg-surface border border-divider rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-charcoal flex items-center gap-2">
              <Clock size={16} className="text-status-warning" />
              Pending Approvals
            </h2>
            <a
              href="/admin/students"
              className="text-xs text-warm-coral hover:text-warm-coral transition-colors"
            >
              View all →
            </a>
          </div>
          {stats.pendingStudents === 0 ? (
            <p className="text-soft-mute text-sm text-center py-8">No pending approvals</p>
          ) : (
            <p className="text-status-warning text-sm">
              {stats.pendingStudents} student{stats.pendingStudents !== 1 ? "s" : ""} awaiting
              approval
            </p>
          )}
        </div>

        {/* Quick Actions */}
        <div className="bg-surface border border-divider rounded-2xl p-6">
          <h2 className="font-semibold text-charcoal flex items-center gap-2 mb-4">
            <ClipboardList size={16} className="text-warm-coral" />
            Quick Actions
          </h2>
          <div className="space-y-2">
            <a
              href="/admin/students"
              className="flex items-center gap-3 p-3 rounded-xl hover:bg-light-bg transition-colors text-sm text-mid-gray hover:text-charcoal"
            >
              <Users size={15} />
              Review student approvals
            </a>
            <a
              href="/admin/teachers"
              className="flex items-center gap-3 p-3 rounded-xl hover:bg-light-bg transition-colors text-sm text-mid-gray hover:text-charcoal"
            >
              <GraduationCap size={15} />
              Invite a teacher
            </a>
            <a
              href="/admin/modules/new"
              className="flex items-center gap-3 p-3 rounded-xl hover:bg-light-bg transition-colors text-sm text-mid-gray hover:text-charcoal"
            >
              <BookOpen size={15} />
              Upload a module
            </a>
            <a
              href="/admin/classes"
              className="flex items-center gap-3 p-3 rounded-xl hover:bg-light-bg transition-colors text-sm text-mid-gray hover:text-charcoal"
            >
              <HelpCircle size={15} />
              Manage class groups
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
