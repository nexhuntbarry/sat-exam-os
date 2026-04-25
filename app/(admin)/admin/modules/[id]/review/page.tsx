import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getServiceClient } from "@/lib/supabase";
import { Suspense } from "react";
import QuestionBankTable from "@/components/questions/QuestionBankTable";
import BulkApproveHighConfidence from "./BulkApproveHighConfidence";

async function getModuleSummary(id: string) {
  const db = getServiceClient();
  const { data: mod } = await db
    .from("modules")
    .select("id, module_name, total_questions")
    .eq("id", id)
    .single();

  if (!mod) return null;

  const { data: counts } = await db
    .from("questions")
    .select("parsing_status")
    .eq("module_id", id);

  const statusCounts = (counts ?? []).reduce(
    (acc, q) => {
      acc[q.parsing_status] = (acc[q.parsing_status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return { ...mod, statusCounts };
}

export default async function ModuleReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const summary = await getModuleSummary(id);

  if (!summary) notFound();

  const approved = summary.statusCounts["Approved"] ?? 0;
  const total = summary.total_questions;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/admin/modules/${id}`} className="text-soft-mute hover:text-charcoal transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-charcoal">Review: {summary.module_name}</h1>
          <p className="text-soft-mute text-sm mt-0.5">
            {approved} of {total} approved
          </p>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-3">
          <div className="w-40 h-2 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-warm-amber rounded-full transition-all"
              style={{ width: total > 0 ? `${(approved / total) * 100}%` : "0%" }}
            />
          </div>
          <span className="text-xs text-soft-mute">
            {total > 0 ? Math.round((approved / total) * 100) : 0}%
          </span>
        </div>

        <BulkApproveHighConfidence moduleId={id} />
      </div>

      {/* Status summary */}
      <div className="flex gap-3 flex-wrap">
        {Object.entries(summary.statusCounts).map(([status, count]) => (
          <div key={status} className="bg-surface border border-divider rounded-xl px-4 py-2 text-sm">
            <span className="text-soft-mute text-xs">{status}</span>
            <p className="text-charcoal font-semibold">{count}</p>
          </div>
        ))}
      </div>

      {/* Question table filtered to this module, Draft status */}
      <Suspense fallback={<div className="text-soft-mute text-sm">Loading questions...</div>}>
        <QuestionBankTable initialModuleId={id} />
      </Suspense>
    </div>
  );
}
