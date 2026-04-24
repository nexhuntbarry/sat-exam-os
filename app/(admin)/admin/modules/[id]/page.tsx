import { getServiceClient } from "@/lib/supabase";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Cpu } from "lucide-react";
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

export default async function ModuleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const mod = await getModule(id);

  if (!mod) notFound();

  const questions = Array.isArray(mod.questions) ? mod.questions : [];

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
        ].map(([label, value]) => (
          <div key={label}>
            <p className="text-soft-gray/50 text-xs mb-0.5">{label}</p>
            <p className="text-white font-medium">{value}</p>
          </div>
        ))}
      </div>

      {/* PDF link */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-5 flex items-center justify-between">
        <div>
          <p className="text-soft-gray/50 text-xs mb-0.5">PDF File</p>
          <p className="text-white text-sm truncate max-w-xs">{mod.pdf_url}</p>
        </div>
        <a
          href={mod.pdf_url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-soft-gray text-sm transition-colors"
        >
          <ExternalLink size={14} />
          Open PDF
        </a>
      </div>

      {/* Parse section */}
      {mod.parsing_status === "pending" && (
        <div className="bg-electric-blue/10 border border-electric-blue/20 rounded-2xl p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-white font-medium text-sm mb-1">Parse with AI</p>
            <p className="text-soft-gray/60 text-xs">
              Trigger AI parsing to extract questions from this PDF. You can review drafts
              once parsing is complete (Phase 1B).
            </p>
          </div>
          <ModuleParseButton moduleId={id} />
        </div>
      )}

      {mod.parsing_status === "parsing" && (
        <div className="bg-amber/10 border border-amber/20 rounded-2xl p-5 flex items-center gap-4">
          <Cpu size={20} className="text-amber shrink-0 animate-pulse" />
          <p className="text-soft-gray/80 text-sm">
            Parsing queued. Admin will review question drafts once AI parse is complete (Phase 1B).
          </p>
        </div>
      )}

      {/* Questions */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-soft-gray">Questions ({questions.length})</h2>
          {questions.length > 0 && (
            <Link
              href={`/admin/questions?moduleId=${id}`}
              className="text-xs text-electric-blue hover:underline"
            >
              View questions →
            </Link>
          )}
        </div>
        {questions.length === 0 ? (
          <p className="text-soft-gray/40 text-sm text-center py-6">
            No questions yet. Parse this module to extract questions.
          </p>
        ) : (
          <p className="text-soft-gray/60 text-sm">{questions.length} question(s) extracted.</p>
        )}
      </div>
    </div>
  );
}
