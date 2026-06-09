"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { CheckCircle2, XCircle, AlertCircle, Save, KeyRound, Sparkles } from "lucide-react";
import PDFViewer from "./PDFViewer";
import ConfidenceBadge from "./ConfidenceBadge";
import MathMarkdown from "@/components/MathMarkdown";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { friendlyParsingNote } from "@/lib/friendly-parsing-notes";

const SAT_DOMAINS = [
  "Information and Ideas",
  "Craft and Structure",
  "Expression of Ideas",
  "Standard English Conventions",
  "Algebra",
  "Advanced Math",
  "Problem Solving and Data Analysis",
  "Geometry and Trigonometry",
];

interface Choice {
  label: "A" | "B" | "C" | "D";
  text: string;
}

interface Question {
  id: string;
  module_id: string;
  section: string;
  original_question_number: number | null;
  question_text: string;
  choices: Choice[];
  correct_answer: string | null;
  explanation: string | null;
  difficulty: "Easy" | "Medium" | "Hard" | null;
  domain: string | null;
  skill: string | null;
  concept: string | null;
  question_type: "Multiple Choice" | "Student Produced Response" | null;
  has_image: boolean;
  has_table: boolean;
  has_formula: boolean;
  page_number: number | null;
  parsing_status: string;
  parsing_notes: string | null;
  ai_confidence_score: number | null;
  reviewed_at: string | null;
  image_urls: string[] | null;
  image_alts: string[] | null;
  official_answer: string | null;
  mismatch_with_official: boolean;
  modules: {
    module_name: string;
    source_name: string | null;
    pdf_url: string;
    section: string;
    difficulty: string | null;
    module_number: number | null;
  } | null;
}

interface QuestionReviewPanelProps {
  question: Question;
}

const statusStyles: Record<string, string> = {
  Draft: "bg-light-bg text-mid-gray",
  Approved: "bg-warm-amber/15 text-warm-amber",
  "Needs Review": "bg-status-warning/15 text-status-warning",
  Rejected: "bg-status-error/15 text-status-error",
};

export default function QuestionReviewPanel({ question: initial }: QuestionReviewPanelProps) {
  const router = useRouter();
  const [q, setQ] = useState<Question>(initial);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_text: q.question_text,
          choices: q.choices,
          correct_answer: q.correct_answer,
          explanation: q.explanation,
          difficulty: q.difficulty,
          domain: q.domain,
          skill: q.skill,
          concept: q.concept,
          question_type: q.question_type,
          has_image: q.has_image,
          has_table: q.has_table,
          has_formula: q.has_formula,
          page_number: q.page_number,
        }),
      });
      if (res.ok) {
        showToast("Saved successfully");
      } else {
        showToast("Save failed", false);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleAction(action: "approve" | "reject" | "needs-review") {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/${action}`, {
        method: "POST",
      });
      if (res.ok) {
        const json = await res.json();
        setQ((prev) => ({ ...prev, parsing_status: json.data.parsing_status }));
        showToast(`Marked as ${action === "needs-review" ? "Needs Review" : action}`);
        router.refresh();
      } else {
        showToast("Action failed", false);
      }
    } finally {
      setActionLoading(null);
    }
  }

  async function handleResolveMismatch(trust: "ai" | "official") {
    setActionLoading(`resolve-${trust}`);
    try {
      const res = await fetch(`/api/admin/questions/${q.id}/resolve-mismatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trust }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setQ((prev) => ({
          ...prev,
          correct_answer: json.data.correct_answer,
          official_answer: json.data.official_answer,
          mismatch_with_official: false,
          parsing_status: json.data.parsing_status,
          parsing_notes: json.data.parsing_notes,
        }));
        showToast(
          trust === "ai" ? "Approved using AI's answer" : "Approved using answer key",
        );
        router.refresh();
      } else {
        showToast(json.error ?? "Resolve failed", false);
      }
    } finally {
      setActionLoading(null);
    }
  }

  // Pull AI's original answer out of the "Mismatch: AI answered X, official Y"
  // hint stored in parsing_notes. Displayed alongside the official answer
  // so the admin can compare without parsing the note string by eye.
  const aiAnswer = q.parsing_notes
    ? q.parsing_notes.match(/Mismatch:\s*AI answered\s+([^,;]+?)\s*,\s*official/i)?.[1]?.trim() ?? null
    : null;

  function updateChoice(label: string, text: string) {
    setQ((prev) => ({
      ...prev,
      choices: prev.choices.map((c) => (c.label === label ? { ...c, text } : c)),
    }));
  }

  // Use admin-only proxy route (handles private-blob auth) instead of raw URL
  const pdfUrl = q.modules?.pdf_url ? `/api/admin/modules/${q.module_id}/pdf` : null;
  const pageNum = q.page_number ?? 1;

  return (
    <div className="flex flex-col gap-4">
      {/* Toast */}
      {toast && (
        <div
          className={clsx(
            "fixed top-4 right-4 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg",
            toast.ok ? "bg-warm-amber/20 text-warm-amber border border-warm-amber/30" : "bg-status-error/15 text-status-error border border-status-error/30"
          )}
        >
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-soft-mute text-sm">
            Q{q.original_question_number ?? "?"} · {q.modules?.module_name ?? "Unknown module"}
          </span>
          <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", statusStyles[q.parsing_status])}>
            {q.parsing_status}
          </span>
          <ConfidenceBadge score={q.ai_confidence_score} />
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface hover:bg-light-bg text-charcoal text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={() => handleAction("approve")}
            disabled={actionLoading !== null || q.parsing_status === "Approved"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warm-amber/15 hover:bg-warm-amber/25 text-warm-amber text-sm font-medium transition-colors disabled:opacity-50"
          >
            <CheckCircle2 size={14} />
            {actionLoading === "approve" ? "..." : "Approve"}
          </button>
          <button
            onClick={() => handleAction("reject")}
            disabled={actionLoading !== null || q.parsing_status === "Rejected"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-status-error/15 hover:bg-status-error/25 text-status-error text-sm font-medium transition-colors disabled:opacity-50"
          >
            <XCircle size={14} />
            {actionLoading === "reject" ? "..." : "Reject"}
          </button>
          <button
            onClick={() => handleAction("needs-review")}
            disabled={actionLoading !== null || q.parsing_status === "Needs Review"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-status-warning/15 hover:bg-status-warning/25 text-status-warning text-sm font-medium transition-colors disabled:opacity-50"
          >
            <AlertCircle size={14} />
            {actionLoading === "needs-review" ? "..." : "Flag"}
          </button>
        </div>
      </div>

      {/* Flags — show a translated, action-oriented banner instead
          of the raw "Demoted by post-parse-cleanup: failed checks → …"
          / UUID-dropping technical strings. The original text is
          kept available behind a <details> in case the reviewer
          really wants the engineering log line. */}
      {q.parsing_notes &&
        (() => {
          const note = friendlyParsingNote(q.parsing_notes);
          if (!note) return null;
          const tone =
            note.tone === "error"
              ? "bg-status-danger/8 border-status-danger/25 text-status-danger"
              : note.tone === "info"
                ? "bg-blue-50 border-blue-200 text-blue-900"
                : "bg-status-warning/8 border-status-warning/20 text-status-warning";
          return (
            <div
              className={`${tone} border rounded-xl px-4 py-3 text-sm space-y-1`}
            >
              <p className="font-semibold leading-snug">{note.headline}</p>
              {note.detail && (
                <p className="text-xs opacity-80 leading-snug">{note.detail}</p>
              )}
              {note.action && (
                <p className="text-xs opacity-90 leading-snug">
                  <span className="font-medium">What to do: </span>
                  {note.action}
                </p>
              )}
              <details className="text-[11px] opacity-60 mt-1">
                <summary className="cursor-pointer">
                  Show technical detail
                </summary>
                <p className="font-mono break-all mt-1">{q.parsing_notes}</p>
              </details>
            </div>
          );
        })()}

      {/* Mismatch resolver — visible only when AI disagreed with the answer
          key at parse time. One-click to pick which answer wins. */}
      {q.mismatch_with_official && (
        <div className="bg-status-warning/10 border border-status-warning/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="text-status-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-charcoal text-sm font-semibold">
                Answer mismatch — pick which one to trust
              </p>
              <p className="text-mid-gray text-xs mt-0.5">
                The AI solver disagreed with the answer key on this question. Read both, then
                approve the correct one. Choosing &ldquo;Trust AI&rdquo; will overwrite
                <code className="px-1"> correct_answer</code> with the AI&rsquo;s value.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-surface border border-divider rounded-xl p-3 space-y-2">
              <p className="text-xs uppercase tracking-wider text-soft-mute font-semibold flex items-center gap-1.5">
                <Sparkles size={12} className="text-warm-coral" />
                AI answered
              </p>
              <p className="text-2xl font-bold text-warm-coral">
                {aiAnswer ?? "?"}
              </p>
              {q.explanation && (
                <div className="text-mid-gray text-xs leading-relaxed border-t border-divider pt-2 max-h-32 overflow-y-auto">
                  <p className="font-medium text-charcoal mb-1">AI&rsquo;s explanation</p>
                  <MathMarkdown>{q.explanation}</MathMarkdown>
                </div>
              )}
              <button
                onClick={() => handleResolveMismatch("ai")}
                disabled={actionLoading !== null || !aiAnswer}
                className="w-full mt-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold transition-colors disabled:opacity-50"
              >
                <Sparkles size={13} />
                {actionLoading === "resolve-ai" ? "Resolving..." : "Trust AI's answer"}
              </button>
            </div>

            <div className="bg-surface border border-divider rounded-xl p-3 space-y-2">
              <p className="text-xs uppercase tracking-wider text-soft-mute font-semibold flex items-center gap-1.5">
                <KeyRound size={12} className="text-status-success" />
                Official answer key
              </p>
              <p className="text-2xl font-bold text-status-success">
                {q.official_answer ?? "?"}
              </p>
              <p className="text-mid-gray text-xs leading-relaxed border-t border-divider pt-2">
                Pulled from the answer key on the last page of the source PDF. Currently set as{" "}
                <code className="px-1">correct_answer</code>.
              </p>
              <button
                onClick={() => handleResolveMismatch("official")}
                disabled={actionLoading !== null || !q.official_answer}
                className="w-full mt-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-status-success hover:bg-status-success/90 text-white text-sm font-semibold transition-colors disabled:opacity-50"
              >
                <KeyRound size={13} />
                {actionLoading === "resolve-official" ? "Resolving..." : "Trust answer key"}
              </button>
            </div>
          </div>

          <p className="text-soft-mute text-xs italic">
            Need a third option? Edit <code>correct_answer</code> below and click Save +
            Approve manually.
          </p>
        </div>
      )}

      {/* Side-by-side layout */}
      <div className="grid grid-cols-2 gap-6 min-h-[640px]">
        {/* Left: PDF */}
        <div className="flex flex-col gap-2">
          <p className="text-xs text-soft-mute font-medium uppercase tracking-wide">
            PDF · Page {pageNum}
          </p>
          {pdfUrl ? (
            <PDFViewer url={pdfUrl} page={pageNum} className="flex-1 min-h-[600px] w-full rounded-xl border border-divider" />
          ) : (
            <div className="flex-1 bg-surface border border-divider rounded-xl flex items-center justify-center text-soft-mute text-sm">
              No PDF
            </div>
          )}
        </div>

        {/* Right: Editable form */}
        <div className="flex flex-col gap-4 overflow-y-auto max-h-[780px] pr-1">
          {/* Question text */}
          <div>
            <label className="block text-xs text-soft-mute mb-1">Question Text</label>
            <MathMarkdown
              className="prose prose-sm max-w-none text-charcoal bg-light-bg border border-divider rounded-xl px-3 py-2.5 mb-2"
            >
              {q.question_text}
            </MathMarkdown>
            <details className="text-xs text-soft-mute">
              <summary className="cursor-pointer">Edit raw</summary>
              <textarea
                value={q.question_text}
                onChange={(e) => setQ((prev) => ({ ...prev, question_text: e.target.value }))}
                rows={5}
                className="w-full mt-1 bg-light-bg border border-divider rounded-xl px-3 py-2.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50 resize-none"
              />
            </details>
          </div>

          {/* Inline PDF page for visual questions — primary path that always
              works, since cropping is unreliable on serverless. */}
          {(q.has_image || q.has_table) && (
            <div>
              <label className="block text-xs text-soft-mute mb-2">
                Source figure · Page {q.page_number ?? 1}
              </label>
              <iframe
                src={`/api/modules/${q.module_id}/page/${q.page_number ?? 1}`}
                className="w-full h-[360px] rounded-xl border border-divider bg-white"
                title={`Question figure (PDF page ${q.page_number ?? 1})`}
              />
            </div>
          )}

          {/* Extracted images (best-effort enhancement when cropping worked) */}
          {q.image_urls && q.image_urls.length > 0 && (
            <div>
              <label className="block text-xs text-soft-mute mb-2">
                Extracted Images ({q.image_urls.length})
              </label>
              <div className="flex flex-wrap gap-3">
                {q.image_urls.map((url, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={url}
                    src={`/api/blob-image?u=${encodeURIComponent(url)}`}
                    alt={q.image_alts?.[i] ?? "Question image"}
                    className="max-w-full md:max-w-md rounded-xl border border-divider bg-white"
                  />
                ))}
              </div>
            </div>
          )}

          {/* Choices */}
          <div>
            <label className="block text-xs text-soft-mute mb-2">
              Answer Choices {q.choices.length === 0 && (
                <span className="text-soft-mute/70">(none — Student Produced Response)</span>
              )}
            </label>
            {q.choices.length > 0 ? (
              <div className="space-y-2">
                {q.choices.map((c) => {
                  const isCorrect = q.correct_answer === c.label;
                  return (
                    <div key={c.label} className="flex items-center gap-2">
                      <span
                        className={clsx(
                          "text-xs w-5 shrink-0 font-semibold text-center rounded-full py-0.5",
                          isCorrect
                            ? "bg-warm-amber/25 text-warm-amber"
                            : "text-soft-mute",
                        )}
                      >
                        {c.label}
                      </span>
                      <div className="flex-1 flex flex-col gap-1">
                        <MathMarkdown className="prose prose-sm max-w-none text-charcoal bg-light-bg border border-divider rounded-lg px-3 py-1.5 [&_p]:my-0">
                          {c.text}
                        </MathMarkdown>
                        <details className="text-[11px] text-soft-mute">
                          <summary className="cursor-pointer">Edit raw</summary>
                          <input
                            type="text"
                            value={c.text}
                            onChange={(e) => updateChoice(c.label, e.target.value)}
                            className="w-full mt-1 bg-light-bg border border-divider rounded-lg px-2 py-1 text-xs text-charcoal focus:outline-none focus:border-warm-coral/50"
                          />
                        </details>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-soft-mute/70 italic">
                Student writes the answer directly.
              </div>
            )}
          </div>

          {/* Correct answer + explanation */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-soft-mute mb-1">Correct Answer</label>
              {q.correct_answer && (
                <MathMarkdown className="prose prose-sm max-w-none text-charcoal bg-light-bg border border-divider rounded-lg px-3 py-1.5 mb-1 [&_p]:my-0">
                  {q.correct_answer}
                </MathMarkdown>
              )}
              <input
                type="text"
                value={q.correct_answer ?? ""}
                onChange={(e) => setQ((prev) => ({ ...prev, correct_answer: e.target.value || null }))}
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-xs text-charcoal focus:outline-none focus:border-warm-coral/50"
                placeholder="Edit raw"
              />
            </div>
            <div>
              <label className="block text-xs text-soft-mute mb-1">Page #</label>
              <input
                type="number"
                value={q.page_number ?? ""}
                onChange={(e) =>
                  setQ((prev) => ({ ...prev, page_number: e.target.value ? parseInt(e.target.value, 10) : null }))
                }
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-soft-mute mb-1">
              Explanation {q.explanation && (
                <span className="text-soft-mute/70">({q.explanation.length} chars)</span>
              )}
            </label>
            {q.explanation && (
              <MathMarkdown className="prose prose-sm max-w-none text-charcoal bg-light-bg border border-divider rounded-xl px-3 py-2.5 mb-2 leading-relaxed">
                {q.explanation}
              </MathMarkdown>
            )}
            <details className="text-xs text-soft-mute">
              <summary className="cursor-pointer">Edit raw</summary>
              <textarea
                value={q.explanation ?? ""}
                onChange={(e) => setQ((prev) => ({ ...prev, explanation: e.target.value || null }))}
                rows={8}
                className="w-full mt-1 bg-light-bg border border-divider rounded-xl px-3 py-2.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50 resize-y leading-relaxed"
              />
            </details>
          </div>

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-soft-mute mb-1">Difficulty</label>
              <select
                value={q.difficulty ?? ""}
                onChange={(e) =>
                  setQ((prev) => ({ ...prev, difficulty: (e.target.value || null) as Question["difficulty"] }))
                }
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              >
                <option value="">—</option>
                <option value="Easy">Easy</option>
                <option value="Medium">Medium</option>
                <option value="Hard">Hard</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-soft-mute mb-1">Type</label>
              <select
                value={q.question_type ?? ""}
                onChange={(e) =>
                  setQ((prev) => ({ ...prev, question_type: (e.target.value || null) as Question["question_type"] }))
                }
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              >
                <option value="">—</option>
                <option value="Multiple Choice">Multiple Choice</option>
                <option value="Student Produced Response">Student Produced Response</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-soft-mute mb-1">Domain</label>
            <select
              value={q.domain ?? ""}
              onChange={(e) => setQ((prev) => ({ ...prev, domain: e.target.value || null }))}
              className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
            >
              <option value="">—</option>
              {SAT_DOMAINS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-soft-mute mb-1">Skill</label>
              <input
                type="text"
                value={q.skill ?? ""}
                onChange={(e) => setQ((prev) => ({ ...prev, skill: e.target.value || null }))}
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              />
            </div>
            <div>
              <label className="block text-xs text-soft-mute mb-1">Concept</label>
              <input
                type="text"
                value={q.concept ?? ""}
                onChange={(e) => setQ((prev) => ({ ...prev, concept: e.target.value || null }))}
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
              />
            </div>
          </div>

          {/* Boolean flags */}
          <div className="flex gap-4">
            {(
              [
                { key: "has_image", label: "Has image" },
                { key: "has_table", label: "Has table" },
                { key: "has_formula", label: "Has formula" },
              ] as const
            ).map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer text-xs text-mid-gray">
                <input
                  type="checkbox"
                  checked={q[key]}
                  onChange={(e) => setQ((prev) => ({ ...prev, [key]: e.target.checked }))}
                  className="accent-warm-coral"
                />
                {label}
              </label>
            ))}
          </div>

          {/* Parsing metadata (read-only) */}
          {q.ai_confidence_score !== null && (
            <div className="bg-surface border border-divider rounded-xl p-3 text-xs text-soft-mute space-y-1">
              <p>AI confidence: {Math.round((q.ai_confidence_score ?? 0) * 100)}%</p>
              {q.reviewed_at && <p>Reviewed: {formatDateTime(q.reviewed_at)}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
