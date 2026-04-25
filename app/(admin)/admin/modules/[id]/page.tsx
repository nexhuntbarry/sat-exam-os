import { getServiceClient } from "@/lib/supabase";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, AlertCircle, CheckCircle2, ClipboardList } from "lucide-react";
import { clsx } from "clsx";
import ModuleParseButton from "./ModuleParseButton";

async function getModule(id: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("modules")
    .select("*, questions(id, parsing_status)")
    .eq("id", id)
    .single();
  return data;
}

const statusStyles: Record<string, string> = {
  pending: "bg-light-bg text-mid-gray",
  parsing: "bg-status-warning/15 text-status-warning",
  parsed: "bg-warm-coral/15 text-warm-coral",
  approved: "bg-warm-amber/15 text-warm-amber",
  failed: "bg-status-error/15 text-status-error",
};

const questionStatusColors: Record<string, string> = {
  Draft: "bg-light-bg text-mid-gray",
  Approved: "bg-warm-amber/15 text-warm-amber",
  "Needs Review": "bg-status-warning/15 text-status-warning",
  Rejected: "bg-status-error/15 text-status-error",
};

export default async function ModuleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const mod = await getModule(id);

  if (!mod) notFound();

  const questions = Array.isArray(mod.questions) ? mod.questions : [];

  const statusCounts = (questions as { parsing_status: string }[]).reduce<Record<string, number>>(
    (acc, q) => {
      acc[q.parsing_status] = (acc[q.parsing_status] ?? 0) + 1;
      return acc;
    },
    {}
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/modules" className="text-soft-mute hover:text-charcoal transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-charcoal">{mod.module_name}</h1>
          <p className="text-soft-mute text-sm mt-0.5">
            {mod.section} · Module {mod.module_number}
            {mod.difficulty && ` · ${mod.difficulty}`}
          </p>
        </div>
        <span
          className={clsx(
            "px-3 py-1 rounded-full text-xs font-medium capitalize",
            statusStyles[mod.parsing_status] ?? "bg-light-bg text-mid-gray"
          )}
        >
          {mod.parsing_status}
        </span>
      </div>

      {/* Info card */}
      <div className="bg-surface border border-divider rounded-2xl p-6 grid grid-cols-2 gap-4 text-sm">
        {[
          ["Source", mod.source_name ?? "—"],
          ["Version", mod.version ?? "—"],
          ["Questions", String(mod.total_questions)],
          ["Uploaded", new Date(mod.created_at).toLocaleDateString()],
          ...(mod.parsing_model ? [["AI Model", mod.parsing_model as string]] : []),
          ...(mod.parsing_completed_at
            ? [["Parsed at", new Date(mod.parsing_completed_at as string).toLocaleString()]]
            : []),
        ].map(([label, value]) => (
          <div key={label}>
            <p className="text-soft-mute text-xs mb-0.5">{label}</p>
            <p className="text-charcoal font-medium">{value}</p>
          </div>
        ))}
      </div>

      {/* PDF link */}
      <div className="bg-surface border border-divider rounded-2xl p-5 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-soft-mute text-xs mb-0.5">PDF File</p>
          <p className="text-charcoal text-sm truncate max-w-xs">{mod.pdf_url}</p>
        </div>
        <a
          href={mod.pdf_url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-light-bg hover:bg-light-bg text-charcoal text-sm transition-colors shrink-0 ml-3"
        >
          <ExternalLink size={14} />
          Open PDF
        </a>
      </div>

      {/* Parse section — pending */}
      {mod.parsing_status === "pending" && (
        <div className="bg-warm-coral/10 border border-warm-coral/20 rounded-2xl p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-charcoal font-medium text-sm mb-1">Parse with AI</p>
            <p className="text-mid-gray text-xs">
              Trigger AI parsing to extract questions from this PDF. This takes 1-3 minutes.
            </p>
          </div>
          <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} />
        </div>
      )}

      {/* Parsing in progress — client polls */}
      {mod.parsing_status === "parsing" && (
        <div className="bg-status-warning/10 border border-status-warning/20 rounded-2xl p-5 flex items-center gap-4">
          <div className="flex-1">
            <p className="text-charcoal text-sm font-medium mb-1">AI parsing in progress…</p>
            <p className="text-mid-gray text-xs">This takes 1-3 minutes. The page will update automatically.</p>
          </div>
          <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} />
        </div>
      )}

      {/* Failed */}
      {mod.parsing_status === "failed" && (
        <div className="bg-status-error/10 border border-status-error/20 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-3">
            <AlertCircle size={18} className="text-status-error shrink-0" />
            <div className="flex-1">
              <p className="text-charcoal text-sm font-medium">Parsing failed</p>
              {mod.parsing_error && (
                <p className="text-status-error/70 text-xs mt-0.5">{mod.parsing_error as string}</p>
              )}
            </div>
            <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} />
          </div>
        </div>
      )}

      {/* Approved */}
      {mod.parsing_status === "approved" && (
        <div className="bg-warm-amber/10 border border-warm-amber/20 rounded-2xl p-5 flex items-center gap-4">
          <CheckCircle2 size={20} className="text-warm-amber shrink-0" />
          <p className="text-charcoal text-sm">All questions approved. This module is locked.</p>
          <Link
            href={`/admin/questions?moduleId=${id}`}
            className="ml-auto text-xs text-warm-coral hover:underline shrink-0"
          >
            Preview questions
          </Link>
        </div>
      )}

      {/* Questions */}
      <div className="bg-surface border border-divider rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-charcoal">Questions ({questions.length})</h2>
          {questions.length > 0 && (
            <div className="flex gap-2">
              <Link
                href={`/admin/modules/${id}/review`}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-warm-coral/15 text-warm-coral hover:bg-warm-coral/25 transition-colors"
              >
                <ClipboardList size={12} />
                Review queue
              </Link>
              <Link
                href={`/admin/questions?moduleId=${id}`}
                className="text-xs text-soft-mute hover:text-charcoal transition-colors px-2 py-1.5"
              >
                All questions →
              </Link>
            </div>
          )}
        </div>
        {questions.length === 0 ? (
          <p className="text-soft-mute text-sm text-center py-6">
            No questions yet. Parse this module to extract questions.
          </p>
        ) : (
          <div className="flex gap-3 flex-wrap">
            {Object.entries(statusCounts).map(([status, count]) => (
              <Link
                key={status}
                href={`/admin/questions?moduleId=${id}&status=${encodeURIComponent(status)}`}
                className={clsx(
                  "px-3 py-2 rounded-xl text-sm font-medium transition-opacity hover:opacity-80",
                  questionStatusColors[status] ?? "bg-surface text-mid-gray"
                )}
              >
                {count} {status}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
