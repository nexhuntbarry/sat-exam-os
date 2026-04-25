"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { Check, BookOpen } from "lucide-react";
import { ResponseDistributionChart } from "@/components/analytics/ResponseDistributionChart";

interface QuestionDetail {
  id: string;
  questionNumber: number;
  questionText: string;
  choices: Array<{ letter: string; text: string }>;
  correctAnswer: string;
  explanation: string | null;
  difficulty: string | null;
  domain: string | null;
  skill: string | null;
}

interface Stats {
  totalSubmissions: number;
  correctCount: number;
  wrongCount: number;
  blankCount: number;
  avgTimeSeconds: number | null;
  choiceDistribution: Record<string, number>;
}

interface StudentEntry {
  id: string;
  display_name: string;
  email: string;
}

interface WrongStudentSubmission {
  submissionId: string;
  studentId: string;
}

interface DetailData {
  question: QuestionDetail;
  stats: Stats;
  wrongStudents: StudentEntry[];
  rightStudents: StudentEntry[];
  wrongStudentSubmissions: WrongStudentSubmission[];
  classReview: boolean;
  privateNote: string;
}

function fmtTime(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default function QuestionDetailPage() {
  const params = useParams<{ id: string; question_id: string }>();
  const testId = params.id;
  const questionId = params.question_id;

  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");

  useEffect(() => {
    fetch(`/api/teacher/tests/${testId}/analytics/${questionId}`)
      .then((r) => r.json())
      .then((json) => {
        setData(json);
        setNote(json.privateNote ?? "");
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [testId, questionId]);

  const handleToggleClassReview = useCallback(async () => {
    if (!data) return;
    const next = !data.classReview;
    await fetch(`/api/teacher/tests/${testId}/questions/${questionId}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note_type: "class_review", note_body: String(next) }),
    });
    setData((prev) => prev ? { ...prev, classReview: next } : prev);
  }, [data, testId, questionId]);

  const handleSaveNote = useCallback(async () => {
    await fetch(`/api/teacher/tests/${testId}/questions/${questionId}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note_type: "private_note", note_body: note }),
    });
  }, [testId, questionId, note]);

  if (loading) return <div className="max-w-4xl mx-auto py-16 text-center text-soft-mute">Loading...</div>;
  if (!data) return <div className="max-w-4xl mx-auto py-16 text-center text-status-error">Not found.</div>;

  const { question, stats, wrongStudents, rightStudents, wrongStudentSubmissions, classReview } = data;

  const submissionByStudent: Record<string, string> = {};
  for (const ws of wrongStudentSubmissions) {
    submissionByStudent[ws.studentId] = ws.submissionId;
  }

  const pieData = [...(question.choices.map((c) => ({
    label: c.letter,
    count: stats.choiceDistribution[c.letter] ?? 0,
    isCorrect: c.letter === question.correctAnswer,
  }))), {
    label: "blank",
    count: stats.blankCount,
    isCorrect: false,
  }].filter((d) => d.count > 0);

  const correctRate = stats.totalSubmissions > 0
    ? ((stats.correctCount / stats.totalSubmissions) * 100).toFixed(1)
    : "0";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-soft-mute text-sm flex-wrap">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${testId}/analytics`} className="hover:text-charcoal transition-colors">Analytics</Link>
        <span>/</span>
        <span className="text-charcoal">Q{question.questionNumber}</span>
      </div>

      {/* Question header */}
      <div className="bg-surface border border-divider rounded-2xl p-5 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-soft-mute text-sm font-mono">Q{question.questionNumber}</span>
            {question.domain && (
              <span className="text-soft-mute text-xs bg-light-bg px-2 py-0.5 rounded">{question.domain}</span>
            )}
            {question.skill && (
              <span className="text-soft-mute text-xs bg-light-bg px-2 py-0.5 rounded">{question.skill}</span>
            )}
            {question.difficulty && (
              <span className={clsx(
                "text-xs font-medium px-2 py-0.5 rounded",
                question.difficulty === "Easy" ? "bg-warm-amber/10 text-warm-amber" :
                question.difficulty === "Medium" ? "bg-status-warning/10 text-status-warning" :
                "bg-status-error/10 text-status-error"
              )}>
                {question.difficulty}
              </span>
            )}
          </div>
          <button
            onClick={handleToggleClassReview}
            className={clsx(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              classReview
                ? "bg-warm-coral/20 text-warm-coral border border-warm-coral/30"
                : "bg-light-bg text-soft-mute border border-divider hover:border-warm-coral/20 hover:text-warm-coral"
            )}
          >
            <BookOpen size={14} />
            {classReview ? "Marked for class review" : "Mark for class review"}
          </button>
        </div>
        <p className="text-charcoal leading-relaxed">{question.questionText}</p>
      </div>

      {/* Choices */}
      {question.choices.length > 0 && (
        <div className="space-y-2">
          {question.choices.map((ch) => {
            const isCorrect = ch.letter === question.correctAnswer;
            const count = stats.choiceDistribution[ch.letter] ?? 0;
            const pct = stats.totalSubmissions > 0 ? (count / stats.totalSubmissions) * 100 : 0;
            return (
              <div
                key={ch.letter}
                className={clsx(
                  "flex items-start gap-3 px-4 py-3 rounded-xl border text-sm",
                  isCorrect
                    ? "bg-warm-amber/8 border-warm-amber/20"
                    : "bg-light-bg/60 border-divider"
                )}
              >
                <span className={clsx(
                  "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
                  isCorrect ? "bg-warm-amber text-charcoal" : "bg-light-bg text-soft-mute"
                )}>
                  {ch.letter}
                </span>
                <div className="flex-1">
                  <p className={isCorrect ? "text-warm-amber" : "text-mid-gray"}>{ch.text}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 bg-light-bg rounded-full h-1.5 max-w-48 overflow-hidden">
                      <div
                        className={clsx("h-full rounded-full", isCorrect ? "bg-warm-amber" : "bg-warm-coral/50")}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-soft-mute text-xs">{count} ({pct.toFixed(0)}%)</span>
                  </div>
                </div>
                {isCorrect && <Check size={16} className="text-warm-amber flex-shrink-0 mt-0.5" />}
              </div>
            );
          })}
        </div>
      )}

      {/* Stats + chart */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <h2 className="text-charcoal font-semibold mb-4">Class Response Distribution</h2>
          <ResponseDistributionChart data={pieData} totalStudents={stats.totalSubmissions} />
        </div>
        <div className="bg-surface border border-divider rounded-2xl p-5 space-y-4">
          <h2 className="text-charcoal font-semibold">Stats</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-soft-mute">Correct rate</span>
              <span className={clsx(
                "font-bold",
                Number(correctRate) >= 70 ? "text-warm-amber" :
                Number(correctRate) >= 40 ? "text-status-warning" : "text-status-error"
              )}>{correctRate}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft-mute">Correct answer</span>
              <span className="text-warm-amber font-bold">{question.correctAnswer}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft-mute">Total submissions</span>
              <span className="text-charcoal">{stats.totalSubmissions}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft-mute">Left blank</span>
              <span className="text-charcoal">{stats.blankCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft-mute">Avg time</span>
              <span className="text-charcoal">{fmtTime(stats.avgTimeSeconds)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Explanation */}
      {question.explanation && (
        <div className="bg-warm-amber/5 border border-warm-amber/10 rounded-2xl p-5">
          <div className="text-warm-amber font-semibold text-sm mb-2">Explanation</div>
          <p className="text-mid-gray text-sm leading-relaxed">{question.explanation}</p>
        </div>
      )}

      {/* Wrong / Right students */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {wrongStudents.length > 0 && (
          <div className="bg-status-error/5 border border-status-error/20 rounded-2xl p-5">
            <h3 className="text-status-error font-semibold mb-3 text-sm">Got it wrong ({wrongStudents.length})</h3>
            <div className="space-y-2">
              {wrongStudents.map((s) => {
                const subId = submissionByStudent[s.id];
                return (
                  <div key={s.id} className="flex items-center justify-between text-sm">
                    <div>
                      <div className="text-charcoal">{s.display_name}</div>
                      <div className="text-soft-mute text-xs">{s.email}</div>
                    </div>
                    {subId && (
                      <Link
                        href={`/teacher/tests/${testId}/results/${subId}`}
                        className="text-warm-coral text-xs hover:underline"
                      >
                        View
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {rightStudents.length > 0 && (
          <div className="bg-warm-amber/5 border border-warm-amber/10 rounded-2xl p-5">
            <h3 className="text-warm-amber font-semibold mb-3 text-sm">Got it right ({rightStudents.length})</h3>
            <div className="space-y-2">
              {rightStudents.map((s) => (
                <div key={s.id} className="flex items-center text-sm gap-2">
                  <Check size={12} className="text-warm-amber flex-shrink-0" />
                  <span className="text-mid-gray">{s.display_name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Teacher notes */}
      <div className="bg-surface border border-divider rounded-2xl p-5 space-y-3">
        <h2 className="text-charcoal font-semibold">Private Note</h2>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={handleSaveNote}
          placeholder="Add a private note about this question..."
          className="w-full bg-light-bg border border-divider rounded-lg px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/20 focus:outline-none focus:border-warm-coral/40 resize-none"
        />
        <p className="text-soft-mute text-xs">Saves automatically when you click away.</p>
      </div>
    </div>
  );
}
