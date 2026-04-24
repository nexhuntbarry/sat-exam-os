import { getCurrentUser } from "@/lib/auth";
import { ClipboardList, Users, BarChart2 } from "lucide-react";

export default async function TeacherDashboardPage() {
  const user = await getCurrentUser();

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">
          Welcome, {user?.displayName ?? "Teacher"}
        </h1>
        <p className="text-soft-gray/50 text-sm mt-1">Teacher dashboard overview.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-electric-blue/10 border-electric-blue/20">
          <div className="p-3 rounded-xl bg-white/5">
            <ClipboardList size={20} className="text-electric-blue" />
          </div>
          <div>
            <div className="text-2xl font-bold text-electric-blue">—</div>
            <div className="text-soft-gray/60 text-xs mt-0.5">Assigned Tests</div>
          </div>
        </div>

        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-lime-green/10 border-lime-green/20">
          <div className="p-3 rounded-xl bg-white/5">
            <Users size={20} className="text-lime-green" />
          </div>
          <div>
            <div className="text-2xl font-bold text-lime-green">—</div>
            <div className="text-soft-gray/60 text-xs mt-0.5">Students Under Review</div>
          </div>
        </div>

        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-emerald/10 border-emerald/20">
          <div className="p-3 rounded-xl bg-white/5">
            <BarChart2 size={20} className="text-emerald" />
          </div>
          <div>
            <div className="text-2xl font-bold text-emerald">—</div>
            <div className="text-soft-gray/60 text-xs mt-0.5">Submissions This Week</div>
          </div>
        </div>
      </div>

      <div className="bg-white/3 border border-white/8 rounded-2xl p-8 text-center">
        <ClipboardList size={40} className="text-soft-gray/20 mx-auto mb-4" />
        <p className="text-soft-gray/50 text-sm">
          Your assigned tests will appear here once an admin assigns classes to you.
        </p>
      </div>
    </div>
  );
}
