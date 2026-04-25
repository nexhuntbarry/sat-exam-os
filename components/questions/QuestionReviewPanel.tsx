"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { CheckCircle2, XCircle, AlertCircle, Save } from "lucide-react";
import PDFViewer from "./PDFViewer";
import ConfidenceBadge from "./ConfidenceBadge";

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

  function updateChoice(label: string, text: string) {
    setQ((prev) => ({
      ...prev,
      choices: prev.choices.map((c) => (c.label === label ? { ...c, text } : c)),
    }));
  }

  const pdfUrl = q.modules?.pdf_url;
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

      {/* Flags */}
      {q.parsing_notes && (
        <div className="bg-status-warning/8 border border-status-warning/20 rounded-xl px-4 py-2.5 text-status-warning text-xs">
          {q.parsing_notes}
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
            <textarea
              value={q.question_text}
              onChange={(e) => setQ((prev) => ({ ...prev, question_text: e.target.value }))}
              rows={5}
              className="w-full bg-light-bg border border-divider rounded-xl px-3 py-2.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50 resize-none"
            />
          </div>

          {/* Choices */}
          {q.choices.length > 0 && (
            <div>
              <label className="block text-xs text-soft-mute mb-2">Answer Choices</label>
              <div className="space-y-2">
                {q.choices.map((c) => (
                  <div key={c.label} className="flex items-center gap-2">
                    <span className="text-xs text-soft-mute w-4 shrink-0">{c.label}</span>
                    <input
                      type="text"
                      value={c.text}
                      onChange={(e) => updateChoice(c.label, e.target.value)}
                      className="flex-1 bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Correct answer + explanation */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-soft-mute mb-1">Correct Answer</label>
              <input
                type="text"
                value={q.correct_answer ?? ""}
                onChange={(e) => setQ((prev) => ({ ...prev, correct_answer: e.target.value || null }))}
                className="w-full bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
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
            <label className="block text-xs text-soft-mute mb-1">Explanation</label>
            <textarea
              value={q.explanation ?? ""}
              onChange={(e) => setQ((prev) => ({ ...prev, explanation: e.target.value || null }))}
              rows={3}
              className="w-full bg-light-bg border border-divider rounded-xl px-3 py-2.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50 resize-none"
            />
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
              {q.reviewed_at && <p>Reviewed: {new Date(q.reviewed_at).toLocaleString()}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
