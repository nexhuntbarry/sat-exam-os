import { getServiceClient } from "@/lib/supabase";
import Link from "next/link";
import { Plus, FileText, ArrowUp, ArrowDown } from "lucide-react";
import { clsx } from "clsx";
import { sectionTitleClass } from "@/lib/section-color";
import DeleteModuleButton from "./DeleteModuleButton";
import PageIntro from "@/components/shared/PageIntro";
import { formatShortDate } from "@/lib/datetime";
import { approvalCounts, isFullyApproved } from "../tests/module-approval";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  TwoLineCell,
} from "@/components/ui/data-table";

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
  approved: number;
  approvalTotal: number;
}

async function getModules(): Promise<ModuleRow[]> {
  const db = getServiceClient();
  const { data } = await db
    .from("modules")
    .select("id, module_name, section, module_number, difficulty, source_name, total_questions, parsing_status, created_at, questions:questions!module_id(parsing_status)")
    .order("created_at", { ascending: false });
  return (data ?? []).map(({ questions, ...m }) => {
    const counts = approvalCounts(questions as { parsing_status: string }[] | null);
    return { ...m, approved: counts.approved, approvalTotal: counts.total } as ModuleRow;
  });
}

const statusStyles: Record<string, string> = {
  pending: "bg-light-bg text-mid-gray",
  parsing: "bg-status-warning/15 text-status-warning",
  parsed: "bg-warm-coral/15 text-warm-coral-text",
  approved: "bg-warm-amber/15 text-warm-amber",
  failed: "bg-status-error/15 text-status-error",
};


type SortKey = "name" | "section" | "difficulty" | "questions" | "approval" | "status" | "uploaded";
const SORT_LABEL: Record<SortKey, string> = {
  name: "Module",
  section: "Section",
  difficulty: "Difficulty",
  questions: "Questions",
  approval: "Approved",
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
      case "approval": return m.approvalTotal ? m.approved / m.approvalTotal : 0;
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
  const sortKey = (["name", "section", "difficulty", "questions", "approval", "status", "uploaded"].includes(sp.sort ?? "")
    ? sp.sort
    : "name") as SortKey;
  const dir = sp.dir === "desc" ? "desc" : "asc";
  const modules = sortModules(await getModules(), sortKey, dir);

  // A sortable column header: clicking toggles asc/desc on that column.
  const SortTh = ({
    col,
    kind = "short" as const,
    priority,
    sticky,
  }: {
    col: SortKey;
    kind?: "main" | "short" | "long" | "actions";
    priority?: "always" | "md" | "lg" | "xl";
    sticky?: "left" | "right";
  }) => {
    const active = col === sortKey;
    const nextDir = active && dir === "asc" ? "desc" : "asc";
    return (
      <Th kind={kind} priority={priority} sticky={sticky}>
        <Link
          href={`/admin/modules?sort=${col}&dir=${nextDir}`}
          className={clsx("inline-flex items-center gap-1 hover:text-charcoal transition-colors", active ? "text-charcoal" : "")}
        >
          {SORT_LABEL[col]}
          {active && (dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
        </Link>
      </Th>
    );
  };

  return (
    <div className="space-y-6">
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

      {modules.length === 0 ? (
        <div className="py-16 text-center space-y-3">
          <FileText size={40} className="text-charcoal/20 mx-auto" />
          <p className="text-soft-mute text-sm">
            No modules yet.{" "}
            <Link href="/admin/modules/new" className="text-warm-coral-text hover:underline">
              Upload your first module
            </Link>
          </p>
        </div>
      ) : (
        <DataTable>
          <thead>
            <HeadRow>
              <SortTh col="name" kind="main" sticky="left" />
              <SortTh col="section" priority="md" />
              <SortTh col="difficulty" priority="md" />
              <SortTh col="questions" priority="md" />
              <SortTh col="approval" priority="md" />
              <SortTh col="status" />
              <SortTh col="uploaded" priority="lg" />
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {modules.map((mod) => {
              const sectionLabel = mod.section
                ? `${mod.section}${mod.module_number ? ` · M${mod.module_number}` : ""}`
                : "—";
              const approvalTitle = mod.approvalTotal === 0
                ? undefined
                : isFullyApproved({ approved: mod.approved, total: mod.approvalTotal })
                  ? "All questions approved"
                  : `${mod.approvalTotal - mod.approved} question(s) not yet approved`;

              return (
                <DataRow
                  key={mod.id}
                  expandBelow="lg"
                  details={
                    <>
                      <DetailItem label="Section" priority="md">{sectionLabel}</DetailItem>
                      <DetailItem label="Difficulty" priority="md">{mod.difficulty ?? "—"}</DetailItem>
                      <DetailItem label="Questions" priority="md">{mod.total_questions ?? "—"}</DetailItem>
                      <DetailItem label="Approved" priority="md">
                        {mod.approvalTotal === 0 ? "—" : `${mod.approved}/${mod.approvalTotal}`}
                      </DetailItem>
                      <DetailItem label="Uploaded" priority="lg">{formatShortDate(mod.created_at)}</DetailItem>
                    </>
                  }
                >
                  <Td kind="main" sticky="left">
                    <Link href={`/admin/modules/${mod.id}`} className="group block">
                      <TwoLineCell
                        main={mod.module_name}
                        detail={mod.source_name ?? ""}
                        mainClassName={clsx("font-medium group-hover:underline", sectionTitleClass(mod.section))}
                      />
                    </Link>
                  </Td>
                  <Td priority="md" className="text-mid-gray whitespace-nowrap">{sectionLabel}</Td>
                  <Td priority="md" className="text-mid-gray">{mod.difficulty ?? "—"}</Td>
                  <Td priority="md" className="text-mid-gray">{mod.total_questions}</Td>
                  <Td priority="md">
                    {mod.approvalTotal === 0 ? (
                      <span className="text-soft-mute">—</span>
                    ) : (
                      <span
                        title={approvalTitle}
                        className={clsx(
                          "px-2 py-1 rounded-full text-xs font-medium tabular-nums whitespace-nowrap",
                          isFullyApproved({ approved: mod.approved, total: mod.approvalTotal })
                            ? "bg-status-success/15 text-status-success"
                            : "bg-status-error/15 text-status-error",
                        )}
                      >
                        {mod.approved}/{mod.approvalTotal}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span
                      className={clsx(
                        "px-2 py-1 rounded-full text-xs font-medium capitalize whitespace-nowrap",
                        statusStyles[mod.parsing_status] ?? "bg-light-bg text-mid-gray"
                      )}
                    >
                      {mod.parsing_status}
                    </span>
                  </Td>
                  <Td priority="lg" className="text-soft-mute">{formatShortDate(mod.created_at)}</Td>
                  <Td kind="actions" sticky="right">
                    <DeleteModuleButton moduleId={mod.id} moduleName={mod.module_name} />
                  </Td>
                </DataRow>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
