import { getServiceClient } from "@/lib/supabase";
import Link from "next/link";
import { Plus, FileText } from "lucide-react";
import { clsx } from "clsx";

async function getModules() {
  const db = getServiceClient();
  const { data } = await db
    .from("modules")
    .select("id, module_name, section, module_number, difficulty, source_name, total_questions, parsing_status, created_at")
    .order("created_at", { ascending: false });
  return data ?? [];
}

const statusStyles: Record<string, string> = {
  pending: "bg-white/10 text-soft-gray/60",
  parsing: "bg-amber/15 text-amber",
  parsed: "bg-electric-blue/15 text-electric-blue",
  approved: "bg-lime-green/15 text-lime-green",
  failed: "bg-rose/15 text-rose",
};

export default async function ModulesPage() {
  const modules = await getModules();

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Modules</h1>
        <Link
          href="/admin/modules/new"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm transition-colors"
        >
          <Plus size={16} />
          Upload Module
        </Link>
      </div>

      <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
        {modules.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <FileText size={40} className="text-soft-gray/20 mx-auto" />
            <p className="text-soft-gray/40 text-sm">
              No modules yet.{" "}
              <Link href="/admin/modules/new" className="text-electric-blue hover:underline">
                Upload your first module
              </Link>
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-soft-gray/50">
                  <th className="text-left px-5 py-3 font-medium">Module</th>
                  <th className="text-left px-5 py-3 font-medium">Section</th>
                  <th className="text-left px-5 py-3 font-medium">Difficulty</th>
                  <th className="text-left px-5 py-3 font-medium">Questions</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((mod) => (
                  <tr
                    key={mod.id}
                    className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <Link href={`/admin/modules/${mod.id}`} className="hover:text-electric-blue transition-colors">
                        <div className="font-medium text-white">{mod.module_name}</div>
                        {mod.source_name && (
                          <div className="text-soft-gray/50 text-xs">{mod.source_name}</div>
                        )}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-soft-gray/70">
                      {mod.section}
                      {mod.module_number && ` · M${mod.module_number}`}
                    </td>
                    <td className="px-5 py-3 text-soft-gray/70">{mod.difficulty ?? "—"}</td>
                    <td className="px-5 py-3 text-soft-gray/70">{mod.total_questions}</td>
                    <td className="px-5 py-3">
                      <span
                        className={clsx(
                          "px-2 py-1 rounded-full text-xs font-medium capitalize",
                          statusStyles[mod.parsing_status] ?? "bg-white/10 text-soft-gray/60"
                        )}
                      >
                        {mod.parsing_status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-soft-gray/50 text-xs">
                      {new Date(mod.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
