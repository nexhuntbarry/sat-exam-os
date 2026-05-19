import { getServiceClient } from "@/lib/supabase";
import Link from "next/link";
import { Plus, FileText } from "lucide-react";
import { clsx } from "clsx";
import DeleteModuleButton from "./DeleteModuleButton";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";

async function getModules() {
  const db = getServiceClient();
  const { data } = await db
    .from("modules")
    .select("id, module_name, section, module_number, difficulty, source_name, total_questions, parsing_status, created_at")
    .order("created_at", { ascending: false });
  return data ?? [];
}

const statusStyles: Record<string, string> = {
  pending: "bg-light-bg text-mid-gray",
  parsing: "bg-status-warning/15 text-status-warning",
  parsed: "bg-warm-coral/15 text-warm-coral",
  approved: "bg-warm-amber/15 text-warm-amber",
  failed: "bg-status-error/15 text-status-error",
};

export default async function ModulesPage() {
  const modules = await getModules();

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageIntro tKey="admin.modules" />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Modules</h1>
        <Link
          href="/admin/modules/new"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
        >
          <Plus size={16} />
          Upload Module
        </Link>
      </div>

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {modules.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <FileText size={40} className="text-charcoal/20 mx-auto" />
            <p className="text-soft-mute text-sm">
              No modules yet.{" "}
              <Link href="/admin/modules/new" className="text-warm-coral hover:underline">
                Upload your first module
              </Link>
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Module</th>
                  <th className="text-left px-5 py-3 font-medium">Section</th>
                  <th className="text-left px-5 py-3 font-medium">Difficulty</th>
                  <th className="text-left px-5 py-3 font-medium">Questions</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Uploaded</th>
                  <th className="text-right px-5 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {modules.map((mod) => (
                  <tr
                    key={mod.id}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <Link href={`/admin/modules/${mod.id}`} className="hover:text-warm-coral transition-colors">
                        <div className="font-medium text-charcoal">{mod.module_name}</div>
                        {mod.source_name && (
                          <div className="text-soft-mute text-xs">{mod.source_name}</div>
                        )}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-mid-gray">
                      {mod.section}
                      {mod.module_number && ` · M${mod.module_number}`}
                    </td>
                    <td className="px-5 py-3 text-mid-gray">{mod.difficulty ?? "—"}</td>
                    <td className="px-5 py-3 text-mid-gray">{mod.total_questions}</td>
                    <td className="px-5 py-3">
                      <span
                        className={clsx(
                          "px-2 py-1 rounded-full text-xs font-medium capitalize",
                          statusStyles[mod.parsing_status] ?? "bg-light-bg text-mid-gray"
                        )}
                      >
                        {mod.parsing_status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-soft-mute text-xs">
                      {formatDate(mod.created_at)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <DeleteModuleButton moduleId={mod.id} moduleName={mod.module_name} />
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
