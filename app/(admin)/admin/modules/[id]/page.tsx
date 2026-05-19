import { getServiceClient } from "@/lib/supabase";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, AlertCircle, CheckCircle2, ClipboardList, Ban, Upload } from "lucide-react";
import { clsx } from "clsx";
import { getTranslations } from "next-intl/server";
import ModuleParseButton from "./ModuleParseButton";
import DeleteModuleButton from "../DeleteModuleButton";
import EditModuleButton from "./EditModuleButton";
import { friendlyParseError } from "@/lib/friendly-parse-error";
import { formatDate, formatDateTime } from "@/lib/datetime";

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
  uploaded: "bg-light-bg text-mid-gray",
  parsing: "bg-status-warning/15 text-status-warning",
  parsed: "bg-warm-coral/15 text-warm-coral",
  approved: "bg-warm-amber/15 text-warm-amber",
  failed: "bg-status-error/15 text-status-error",
  rejected_not_sat: "bg-status-error/15 text-status-error",
};

const statusLabels: Record<string, string> = {
  pending: "uploaded",
  uploaded: "uploaded",
  parsing: "parsing",
  parsed: "parsed",
  approved: "approved",
  failed: "failed",
  rejected_not_sat: "rejected (not SAT)",
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
  const [mod, tr] = await Promise.all([getModule(id), getTranslations("moduleDetail")]);
  const t = {
    parseTitle: tr("parseTitle"),
    parseHint: tr("parseHint"),
    btnParse: tr("btnParse"),
    btnRetry: tr("btnRetry"),
    btnStarting: tr("btnStarting"),
    btnParsing: tr("btnParsing"),
    rejectedTitle: `\u26A0\uFE0F ${tr("rejectedTitle")}`,
    rejectedSub: tr("rejectedSub"),
    rejectedReason: tr("rejectedReason"),
    uploadNew: tr("uploadNew"),
    parsingNow: tr("parsingNow"),
    parsingHint: tr("parsingHint"),
    failed: tr("failed"),
    approved: tr("approved"),
    previewQuestions: tr("previewQuestions"),
    questions: tr("questions"),
    reviewQueue: tr("reviewQueue"),
    allQuestions: tr("allQuestions"),
    noQuestions: tr("noQuestions"),
    openPdf: tr("openPdf"),
    pdfFile: tr("pdfFile"),
  };

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
          {statusLabels[mod.parsing_status] ?? mod.parsing_status}
        </span>
        <EditModuleButton
          mod={{
            id: mod.id,
            module_name: mod.module_name,
            section: mod.section,
            module_number: mod.module_number,
            difficulty: mod.difficulty,
            source_name: mod.source_name,
            version: mod.version,
          }}
        />
        <DeleteModuleButton moduleId={id} moduleName={mod.module_name} />
      </div>

      {/* Info card */}
      <div className="bg-surface border border-divider rounded-2xl p-6 grid grid-cols-2 gap-4 text-sm">
        {[
          ["Source", mod.source_name ?? "—"],
          ["Version", mod.version ?? "—"],
          ["Questions", String(mod.total_questions)],
          ["Uploaded", formatDate(mod.created_at)],
          ...(mod.parsing_model ? [["AI Model", mod.parsing_model as string]] : []),
          ...(mod.parsing_completed_at
            ? [["Parsed at", formatDateTime(mod.parsing_completed_at as string)]]
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
          <p className="text-soft-mute text-xs mb-0.5">{t.pdfFile}</p>
          <p className="text-charcoal text-sm truncate max-w-xs">{mod.pdf_url}</p>
        </div>
        <a
          href={`/api/admin/modules/${id}/pdf`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-light-bg hover:bg-light-bg text-charcoal text-sm transition-colors shrink-0 ml-3"
        >
          <ExternalLink size={14} />
          {t.openPdf}
        </a>
      </div>

      {/* Parse section — uploaded (legacy 'pending' is treated the same) */}
      {(mod.parsing_status === "uploaded" || mod.parsing_status === "pending") && (
        <div className="bg-warm-coral/10 border border-warm-coral/20 rounded-2xl p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-charcoal font-medium text-sm mb-1">{t.parseTitle}</p>
            <p className="text-mid-gray text-xs">{t.parseHint}</p>
          </div>
          <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} labels={{ parse: t.btnParse, retry: t.btnRetry, starting: t.btnStarting, parsing: t.btnParsing }} />
        </div>
      )}

      {/* Rejected — non-SAT content */}
      {mod.parsing_status === "rejected_not_sat" && (
        <div className="bg-status-error/10 border border-status-error/30 rounded-2xl p-5 space-y-3">
          <div className="flex items-start gap-3">
            <Ban size={20} className="text-status-error shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-charcoal font-semibold text-sm">{t.rejectedTitle}</p>
              <p className="text-charcoal/80 text-sm mt-1">{t.rejectedSub}</p>
              {mod.parsing_error && (
                <p className="text-status-error/80 text-xs mt-2 bg-surface/40 rounded px-2 py-1">
                  {t.rejectedReason}: {mod.parsing_error as string}
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end">
            <Link
              href="/admin/modules/new"
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-medium transition-colors"
            >
              <Upload size={14} />
              {t.uploadNew}
            </Link>
          </div>
        </div>
      )}

      {/* Parsing in progress — client polls */}
      {mod.parsing_status === "parsing" && (
        <div className="bg-status-warning/10 border border-status-warning/20 rounded-2xl p-5 flex items-center gap-4">
          <div className="flex-1">
            <p className="text-charcoal text-sm font-medium mb-1">{t.parsingNow}</p>
            <p className="text-mid-gray text-xs">{t.parsingHint}</p>
          </div>
          <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} labels={{ parse: t.btnParse, retry: t.btnRetry, starting: t.btnStarting, parsing: t.btnParsing }} />
        </div>
      )}

      {/* Failed */}
      {mod.parsing_status === "failed" && (() => {
        const friendly = friendlyParseError(mod.parsing_error as string | null);
        return (
          <div className="bg-status-error/10 border border-status-error/20 rounded-2xl p-5 space-y-3">
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="text-status-error shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1">
                <p className="text-charcoal text-sm font-medium">{friendly.summary}</p>
                <p className="text-mid-gray text-xs">{friendly.hint}</p>
                {mod.parsing_error && (
                  <details className="mt-2">
                    <summary className="text-status-error/60 text-xs cursor-pointer hover:text-status-error">
                      Raw error (for dev team)
                    </summary>
                    <pre className="mt-1 text-status-error/70 text-xs whitespace-pre-wrap break-words font-mono">
                      {mod.parsing_error as string}
                    </pre>
                  </details>
                )}
              </div>
              <ModuleParseButton moduleId={id} initialStatus={mod.parsing_status as string} labels={{ parse: t.btnParse, retry: t.btnRetry, starting: t.btnStarting, parsing: t.btnParsing }} />
            </div>
          </div>
        );
      })()}

      {/* Approved */}
      {mod.parsing_status === "approved" && (
        <div className="bg-warm-amber/10 border border-warm-amber/20 rounded-2xl p-5 flex items-center gap-4">
          <CheckCircle2 size={20} className="text-warm-amber shrink-0" />
          <p className="text-charcoal text-sm">{t.approved}</p>
          <Link
            href={`/admin/questions?moduleId=${id}`}
            className="ml-auto text-xs text-warm-coral hover:underline shrink-0"
          >
            {t.previewQuestions}
          </Link>
        </div>
      )}

      {/* Questions */}
      <div className="bg-surface border border-divider rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-charcoal">{t.questions} ({questions.length})</h2>
          {questions.length > 0 && (
            <div className="flex gap-2">
              <Link
                href={`/admin/modules/${id}/review`}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-warm-coral/15 text-warm-coral hover:bg-warm-coral/25 transition-colors"
              >
                <ClipboardList size={12} />
                {t.reviewQueue}
              </Link>
              <Link
                href={`/admin/questions?moduleId=${id}`}
                className="text-xs text-soft-mute hover:text-charcoal transition-colors px-2 py-1.5"
              >
                {t.allQuestions} →
              </Link>
            </div>
          )}
        </div>
        {questions.length === 0 ? (
          <p className="text-soft-mute text-sm text-center py-6">{t.noQuestions}</p>
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
