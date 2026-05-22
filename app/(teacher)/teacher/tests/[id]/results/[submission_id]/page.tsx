"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { Check, X, Save, Printer } from "lucide-react";
import { SubmissionDetailPanel } from "@/components/analytics/SubmissionDetailPanel";
import type { AnswerDetail } from "@/components/analytics/SubmissionDetailPanel";
import { scaleSectionScore } from "@/lib/scoring";
import { formatDate, formatDateTime } from "@/lib/datetime";

interface StudentInfo {
  name: string;
  email: string;
  grade: string | null;
  classGroup: string | null;
}

interface SubmissionInfo {
  id: string;
  status: string;
  score: number | null;
  percentage: number | null;
  correctCount: number;
  totalQuestions: number;
  timeSpentSeconds: number | null;
  startedAt: string | null;
  submittedAt: string | null;
  tutorNotes: string;
  attemptNumber: number;
  scaledScore: number | null;
  scaledSection: string | null;
  isMultiModule: boolean;
}

interface ModuleBreakdown {
  submissionId: string;
  label: string;
  isCurrent: boolean;
  status: string;
  correctCount: number;
  totalQuestions: number;
  percentage: number | null;
  scaledScore: number | null;
  timeSpentSeconds: number;
  answers: AnswerDetail[];
}

interface DetailData {
  student: StudentInfo;
  submission: SubmissionInfo;
  answers: AnswerDetail[];
  modules?: ModuleBreakdown[];
}

function fmtTime(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default function SubmissionDetailPage() {
  const params = useParams<{ id: string; submission_id: string }>();
  const testId = params.id;
  const submissionId = params.submission_id;

  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/teacher/tests/${testId}/results/${submissionId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setError(json.error);
        else setData(json);
      })
      .catch(() => setError("Failed to load"))
      .finally(() => setLoading(false));
  }, [testId, submissionId]);

  const handleToggleClassReview = useCallback(
    async (questionId: string, current: boolean) => {
      await fetch(`/api/teacher/tests/${testId}/questions/${questionId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_type: "class_review", note_body: String(!current) }),
      });
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          answers: prev.answers.map((a) =>
            a.questionId === questionId ? { ...a, classReview: !current } : a
          ),
        };
      });
    },
    [testId]
  );

  const handleSaveNote = useCallback(
    async (questionId: string, note: string) => {
      await fetch(`/api/teacher/tests/${testId}/questions/${questionId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_type: "private_note", note_body: note }),
      });
    },
    [testId]
  );

  // Tutor notes — debounced save so the teacher can type freely without
  // a "Save" click. Visible status: "Saving…" / "Saved".
  const [tutorNotes, setTutorNotes] = useState("");
  const [tutorStatus, setTutorStatus] = useState<"idle" | "saving" | "saved">("idle");
  const tutorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (data?.submission.tutorNotes !== undefined) {
      setTutorNotes(data.submission.tutorNotes);
    }
  }, [data?.submission.tutorNotes]);

  function handleTutorChange(v: string) {
    setTutorNotes(v);
    setTutorStatus("saving");
    if (tutorTimer.current) clearTimeout(tutorTimer.current);
    tutorTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/teacher/tests/${testId}/results/${submissionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tutorNotes: v }),
        });
        if (res.ok) setTutorStatus("saved");
        else setTutorStatus("idle");
      } catch {
        setTutorStatus("idle");
      }
    }, 700);
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto py-16 text-center text-soft-mute">Loading...</div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto py-16 text-center text-status-error">{error ?? "Not found"}</div>
    );
  }

  const { student, submission, answers } = data;
  const correctCount = answers.filter((a) => a.isCorrect).length;

  function handlePrint() {
    // The per-question rows in SubmissionDetailPanel are gated by
    // React state, so a plain DOM mutation can't reveal them. Fire a
    // custom event the panel listens for, then wait two animation
    // frames so React commits the state update + the layout reflow
    // before we hand off to the print pipeline.
    document.querySelectorAll<HTMLDetailsElement>("details").forEach((d) => {
      d.open = true;
    });
    window.dispatchEvent(new Event("submission-detail-expand-all"));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.print());
    });
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 print:max-w-none">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-soft-mute text-sm flex-wrap print:hidden">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${testId}/results`} className="hover:text-charcoal transition-colors">Results</Link>
        <span>/</span>
        <span className="text-charcoal">{student.name}</span>
        <button
          onClick={handlePrint}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warm-coral hover:bg-warm-coral-dark text-white text-xs font-semibold transition-colors"
          title="Open every answer and trigger the print dialog (Save as PDF works from there)"
        >
          <Printer size={13} />
          Print / Save PDF
        </button>
      </div>

      {/* Student header */}
      <div className="bg-surface border border-divider rounded-2xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-charcoal">{student.name}</h1>
            <div className="text-soft-mute text-sm mt-0.5">{student.email}</div>
            <div className="flex items-center gap-3 mt-1 text-sm text-soft-mute">
              {student.grade && <span>Grade {student.grade}</span>}
              {student.classGroup && <span>· {student.classGroup}</span>}
            </div>
          </div>
          <span className={clsx(
            "px-3 py-1 rounded-full text-sm font-medium",
            submission.status === "Submitted" ? "bg-warm-amber/15 text-warm-amber" :
            submission.status === "Late" ? "bg-status-warning/15 text-status-warning" :
            "bg-light-bg text-soft-mute"
          )}>
            {submission.status}
          </span>
        </div>
      </div>

      {/* Score summary */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4 col-span-2 sm:col-span-1">
          <div className="text-soft-mute text-xs mb-1">Score</div>
          <div className={clsx(
            "text-3xl font-bold",
            submission.percentage != null && submission.percentage >= 70 ? "text-warm-amber" :
            submission.percentage != null && submission.percentage >= 50 ? "text-status-warning" : "text-status-error"
          )}>
            {submission.percentage != null ? `${Number(submission.percentage).toFixed(1)}%` : "—"}
          </div>
        </div>
        {(() => {
          // Fall back to live computation when the submission predates
          // migration 0015 (scaled_score IS NULL in older rows).
          const effectiveScaled =
            submission.scaledScore ??
            (submission.percentage != null
              ? scaleSectionScore(Number(submission.percentage))
              : null);
          if (effectiveScaled == null) return null;
          return (
            <div
              className="bg-warm-coral/10 border border-warm-coral/20 rounded-xl p-4"
              title="Estimated SAT scaled score (200-800). Based on TestNinja-style approximation; not adaptive yet."
            >
              <div className="text-soft-mute text-xs mb-1">
                Est. SAT score
                {submission.scaledSection ? ` · ${submission.scaledSection}` : ""}
              </div>
              <div className="text-3xl font-bold text-warm-coral">
                {effectiveScaled}
                <span className="text-sm text-soft-mute font-normal">/800</span>
              </div>
            </div>
          );
        })()}
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Correct</div>
          <div className="text-charcoal text-2xl font-bold flex items-center gap-1">
            <Check size={16} className="text-warm-amber" />
            {submission.correctCount}/{submission.totalQuestions}
          </div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Incorrect</div>
          <div className="text-charcoal text-2xl font-bold flex items-center gap-1">
            <X size={16} className="text-status-error" />
            {submission.totalQuestions - submission.correctCount}
          </div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Time Spent</div>
          <div className="text-charcoal font-semibold">{fmtTime(submission.timeSpentSeconds)}</div>
          {submission.submittedAt && (
            <div className="text-soft-mute text-xs mt-1">
              {formatDateTime(submission.submittedAt)}
            </div>
          )}
        </div>
      </div>

      {/* Tutor notes — for 1-on-1 follow-up. Not visible to the
          student, and hidden in print so the printout stays condensed
          (teacher just wants questions + correct answers). */}
      <div className="bg-warm-amber/5 border border-warm-amber/20 rounded-2xl p-5 print:hidden">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-charcoal font-semibold flex items-center gap-2">
              Tutor notes
              {submission.attemptNumber > 1 && (
                <span className="text-xs font-normal text-soft-mute">
                  · attempt #{submission.attemptNumber}
                </span>
              )}
            </h2>
            <p className="text-soft-mute text-xs mt-0.5">
              Private to teachers and admins. Use for tutoring follow-ups, what was covered,
              what to revisit next time.
            </p>
          </div>
          <span className="text-xs text-soft-mute flex items-center gap-1">
            {tutorStatus === "saving" && "Saving…"}
            {tutorStatus === "saved" && (
              <>
                <Save size={11} className="text-warm-amber" /> Saved
              </>
            )}
          </span>
        </div>
        <textarea
          value={tutorNotes}
          onChange={(e) => handleTutorChange(e.target.value)}
          rows={4}
          placeholder="What was covered in this 1-on-1? What does the student still need help with?"
          className="w-full bg-surface border border-divider rounded-xl px-3 py-2 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-amber/50 transition-colors"
        />
      </div>

      {/* Per-module breakdown — one card per module with its own
          score pills, then its own per-question review panel below.
          Two-module sessions render Module 1 + Module 2 stacked;
          single-module submissions fall back to a single panel. */}
      {data.modules && data.modules.length > 1 ? (
        <div className="space-y-6">
          {data.modules.map((m) => {
            const effScaled =
              m.scaledScore ??
              (m.percentage != null ? scaleSectionScore(m.percentage) : null);
            return (
              <div key={m.submissionId} className="space-y-3">
                <div className="flex items-center justify-between gap-3 bg-surface border border-divider rounded-2xl px-5 py-3">
                  <div>
                    <h2 className="text-charcoal font-semibold text-base">{m.label}</h2>
                    <p className="text-soft-mute text-xs mt-0.5">
                      {m.correctCount}/{m.totalQuestions} correct
                      {m.percentage != null && ` · ${m.percentage.toFixed(1)}%`}
                      {effScaled != null && ` · ${effScaled}/800`}
                      {" · "}{fmtTime(m.timeSpentSeconds)}
                    </p>
                  </div>
                  {m.isCurrent && (
                    <span className="text-warm-coral text-[11px] font-semibold uppercase tracking-wider">
                      Current
                    </span>
                  )}
                </div>
                <SubmissionDetailPanel
                  answers={m.answers}
                  testId={testId}
                  onToggleClassReview={handleToggleClassReview}
                  onSaveNote={handleSaveNote}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <SubmissionDetailPanel
          answers={answers}
          testId={testId}
          onToggleClassReview={handleToggleClassReview}
          onSaveNote={handleSaveNote}
        />
      )}
    </div>
  );
}
