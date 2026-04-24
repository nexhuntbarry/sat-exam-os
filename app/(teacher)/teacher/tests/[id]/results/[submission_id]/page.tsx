"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { Check, X } from "lucide-react";
import { SubmissionDetailPanel } from "@/components/analytics/SubmissionDetailPanel";
import type { AnswerDetail } from "@/components/analytics/SubmissionDetailPanel";

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
}

interface DetailData {
  student: StudentInfo;
  submission: SubmissionInfo;
  answers: AnswerDetail[];
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

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto py-16 text-center text-soft-gray/40">Loading...</div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto py-16 text-center text-rose">{error ?? "Not found"}</div>
    );
  }

  const { student, submission, answers } = data;
  const correctCount = answers.filter((a) => a.isCorrect).length;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-soft-gray/50 text-sm flex-wrap">
        <Link href="/teacher/tests" className="hover:text-soft-gray transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${testId}/results`} className="hover:text-soft-gray transition-colors">Results</Link>
        <span>/</span>
        <span className="text-white">{student.name}</span>
      </div>

      {/* Student header */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-white">{student.name}</h1>
            <div className="text-soft-gray/50 text-sm mt-0.5">{student.email}</div>
            <div className="flex items-center gap-3 mt-1 text-sm text-soft-gray/40">
              {student.grade && <span>Grade {student.grade}</span>}
              {student.classGroup && <span>· {student.classGroup}</span>}
            </div>
          </div>
          <span className={clsx(
            "px-3 py-1 rounded-full text-sm font-medium",
            submission.status === "Submitted" ? "bg-lime-green/15 text-lime-green" :
            submission.status === "Late" ? "bg-amber/15 text-amber" :
            "bg-white/10 text-soft-gray/50"
          )}>
            {submission.status}
          </span>
        </div>
      </div>

      {/* Score summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white/3 border border-white/8 rounded-xl p-4 col-span-2 sm:col-span-1">
          <div className="text-soft-gray/40 text-xs mb-1">Score</div>
          <div className={clsx(
            "text-3xl font-bold",
            submission.percentage != null && submission.percentage >= 70 ? "text-lime-green" :
            submission.percentage != null && submission.percentage >= 50 ? "text-amber" : "text-rose"
          )}>
            {submission.percentage != null ? `${Number(submission.percentage).toFixed(1)}%` : "—"}
          </div>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-xl p-4">
          <div className="text-soft-gray/40 text-xs mb-1">Correct</div>
          <div className="text-white text-2xl font-bold flex items-center gap-1">
            <Check size={16} className="text-lime-green" />
            {submission.correctCount}/{submission.totalQuestions}
          </div>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-xl p-4">
          <div className="text-soft-gray/40 text-xs mb-1">Incorrect</div>
          <div className="text-white text-2xl font-bold flex items-center gap-1">
            <X size={16} className="text-rose" />
            {submission.totalQuestions - submission.correctCount}
          </div>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-xl p-4">
          <div className="text-soft-gray/40 text-xs mb-1">Time Spent</div>
          <div className="text-white font-semibold">{fmtTime(submission.timeSpentSeconds)}</div>
          {submission.submittedAt && (
            <div className="text-soft-gray/30 text-xs mt-1">
              {new Date(submission.submittedAt).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Per-question review */}
      <SubmissionDetailPanel
        answers={answers}
        testId={testId}
        onToggleClassReview={handleToggleClassReview}
        onSaveNote={handleSaveNote}
      />
    </div>
  );
}
