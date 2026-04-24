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
  pending: "bg-white/10 text-soft-gray/60",
  parsing: "bg-amber/15 text-amber",
  parsed: "bg-electric-blue/15 text-electric-blue",
  approved: "bg-lime-green/15 text-lime-green",
  failed: "bg-rose/15 text-rose",
};

const questionStatusColors: Record<string, string> = {
  Draft: "bg-white/10 text-soft-gray/60",
  Approved: "bg-lime-green/15 text-lime-green",
  "Needs Review": "bg-amber/15 text-amber",
  Rejected: "bg-rose/15 text-rose",
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
        <Link href="/admin/modules" className="text-soft-gray/50 hover:text-soft-gray transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-white">{mod.module_name}</h1>
          <p className="text-soft-gray/50 text-sm mt-0.5">
            {mod.section} · Module {mod.module_number}
            {mod.difficulty && ` · ${mod.difficulty}`}
          </p>
        </div>
        <span
          className={clsx(
            "px-3 py-1 rounded-full text-xs font-medium capitalize",
            statusStyles[mod.parsing_status] ?? "bg-white/10 text-soft-gray/60"
          )}
        >
          {mod.parsing_status}
        </span>
      </div>

      {/* Info card */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-6 grid grid-cols-2 gap-4 text-sm">
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
            <p className="text-soft-gray/50 text-xs mb-0.5">{label}</p>
            <p className="text-white font-medium">{value}</p>
          </div>
        ))}
      </div>

      {/* PDF link */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-5 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-soft-gray/50 text-xs mb-0.5">PDF File</p>
          <p className="text-white text-sm truncate max-w-xs">{mod.pdf_url}</p>
        </div>
        <a
          href={mod.pdf_url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-soft-gray text-sm transition-colors shrink-0 ml-3"
        >
          <ExternalLink size={14} />
          Open PDF
        </a>
      </div>

      {/* Parse section — pending */}
      {mod.parsing_status === "pending" && (
        <div className="bg-electric-blue/10 border border-electric-blue/20 rounded-2xl p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-white font-medium text-sm mb-1">Parse with AI</p>
            <p className="text-soft-gray/60 text-xs">
              Trigger AI parsing to extract questions from this PDF. This takes 1-3 minutes.
            </p>
          </div>
          <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} />
        </div>
      )}

      {/* Parsing in progress — client polls */}
      {mod.parsing_status === "parsing" && (
        <div className="bg-amber/10 border border-amber/20 rounded-2xl p-5 flex items-center gap-4">
          <div className="flex-1">
            <p className="text-white text-sm font-medium mb-1">AI parsing in progress…</p>
            <p className="text-soft-gray/60 text-xs">This takes 1-3 minutes. The page will update automatically.</p>
          </div>
          <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} />
        </div>
      )}

      {/* Failed */}
      {mod.parsing_status === "failed" && (
        <div className="bg-rose/10 border border-rose/20 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-3">
            <AlertCircle size={18} className="text-rose shrink-0" />
            <div className="flex-1">
              <p className="text-white text-sm font-medium">Parsing failed</p>
              {mod.parsing_error && (
                <p className="text-rose/70 text-xs mt-0.5">{mod.parsing_error as string}</p>
              )}
            </div>
            <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} />
          </div>
        </div>
      )}

      {/* Approved */}
      {mod.parsing_status === "approved" && (
        <div className="bg-lime-green/10 border border-lime-green/20 rounded-2xl p-5 flex items-center gap-4">
          <CheckCircle2 size={20} className="text-lime-green shrink-0" />
          <p className="text-soft-gray/80 text-sm">All questions approved. This module is locked.</p>
          <Link
            href={`/admin/questions?moduleId=${id}`}
            className="ml-auto text-xs text-electric-blue hover:underline shrink-0"
          >
            Preview questions
          </Link>
        </div>
      )}

      {/* Questions */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-soft-gray">Questions ({questions.length})</h2>
          {questions.length > 0 && (
            <div className="flex gap-2">
              <Link
                href={`/admin/modules/${id}/review`}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-electric-blue/15 text-electric-blue hover:bg-electric-blue/25 transition-colors"
              >
                <ClipboardList size={12} />
                Review queue
              </Link>
              <Link
                href={`/admin/questions?moduleId=${id}`}
                className="text-xs text-soft-gray/50 hover:text-soft-gray transition-colors px-2 py-1.5"
              >
                All questions →
              </Link>
            </div>
          )}
        </div>
        {questions.length === 0 ? (
          <p className="text-soft-gray/40 text-sm text-center py-6">
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
                  questionStatusColors[status] ?? "bg-white/8 text-soft-gray/60"
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
