import { getServiceClient } from "@/lib/supabase";
import Link from "next/link";
import { Plus, FileText, ArrowUp, ArrowDown } from "lucide-react";
import { clsx } from "clsx";
import DeleteModuleButton from "./DeleteModuleButton";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate } from "@/lib/datetime";

interface ModuleRow {
  id: string;
  module_name: string;
  section: string | null;
  module_number: number | null;
  difficulty: string | null;
  source_name: string | null;
  total_questions: number | null;
  parsing_status: string;
  created_at: string;
}

async function getModules(): Promise<ModuleRow[]> {
  const db = getServiceClient();
  const { data } = await db
    .from("modules")
    .select("id, module_name, section, module_number, difficulty, source_name, total_questions, parsing_status, created_at")
    .order("created_at", { ascending: false });
  return (data ?? []) as ModuleRow[];
}

const statusStyles: Record<string, string> = {
  pending: "bg-light-bg text-mid-gray",
  parsing: "bg-status-warning/15 text-status-warning",
  parsed: "bg-warm-coral/15 text-warm-coral",
  approved: "bg-warm-amber/15 text-warm-amber",
  failed: "bg-status-error/15 text-status-error",
};

// Section-based title colour: Math = blue, Reading & Writing (English) = red.
function sectionTitleClass(section: string | null): string {
  if (section === "Math") return "text-blue-600";
  if (section === "Reading & Writing") return "text-red-600";
  return "text-charcoal";
}

type SortKey = "name" | "section" | "difficulty" | "questions" | "status" | "uploaded";
const SORT_LABEL: Record<SortKey, string> = {
  name: "Module",
  section: "Section",
  difficulty: "Difficulty",
  questions: "Questions",
  status: "Status",
  uploaded: "Uploaded",
};

function sortModules(mods: ModuleRow[], key: SortKey, dir: "asc" | "desc"): ModuleRow[] {
  const val = (m: ModuleRow): string | number => {
    switch (key) {
      case "name": return m.module_name.toLowerCase();
      case "section": return `${m.section ?? ""} ${m.module_number ?? 0}`.toLowerCase();
      case "difficulty": return (m.difficulty ?? "").toLowerCase();
      case "questions": return m.total_questions ?? 0;
      case "status": return m.parsing_status;
      case "uploaded": return m.created_at;
    }
  };
  const sorted = [...mods].sort((a, b) => {
    const va = val(a), vb = val(b);
    const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

export default async function ModulesPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const sp = await searchParams;
  const sortKey = (["name", "section", "difficulty", "questions", "status", "uploaded"].includes(sp.sort ?? "")
    ? sp.sort
    : "name") as SortKey;
  const dir = sp.dir === "desc" ? "desc" : "asc";
  const modules = sortModules(await getModules(), sortKey, dir);

  // A sortable column header: clicking toggles asc/desc on that column.
  const Header = ({ col, align = "left" }: { col: SortKey; align?: "left" | "right" }) => {
    const active = col === sortKey;
    const nextDir = active && dir === "asc" ? "desc" : "asc";
    return (
      <th className={clsx("px-5 py-3 font-medium", align === "right" ? "text-right" : "text-left")}>
        <Link
          href={`/admin/modules?sort=${col}&dir=${nextDir}`}
          className={clsx("inline-flex items-center gap-1 hover:text-charcoal transition-colors", active ? "text-charcoal" : "text-soft-mute")}
        >
          {SORT_LABEL[col]}
          {active && (dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
        </Link>
      </th>
    );
  };

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
                <tr className="border-b border-divider">
                  <Header col="name" />
                  <Header col="section" />
                  <Header col="difficulty" />
                  <Header col="questions" />
                  <Header col="status" />
                  <Header col="uploaded" />
                  <th className="text-right px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {modules.map((mod) => (
                  <tr
                    key={mod.id}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <Link href={`/admin/modules/${mod.id}`} className="group">
                        <div className={clsx("font-medium group-hover:underline", sectionTitleClass(mod.section))}>
                          {mod.module_name}
                        </div>
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
