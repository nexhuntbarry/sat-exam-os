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

  if (loading) return <div className="max-w-4xl mx-auto py-16 text-center text-soft-gray/40">Loading...</div>;
  if (!data) return <div className="max-w-4xl mx-auto py-16 text-center text-rose">Not found.</div>;

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
      <div className="flex items-center gap-2 text-soft-gray/50 text-sm flex-wrap">
        <Link href="/teacher/tests" className="hover:text-soft-gray transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${testId}/analytics`} className="hover:text-soft-gray transition-colors">Analytics</Link>
        <span>/</span>
        <span className="text-white">Q{question.questionNumber}</span>
      </div>

      {/* Question header */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-5 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-soft-gray/40 text-sm font-mono">Q{question.questionNumber}</span>
            {question.domain && (
              <span className="text-soft-gray/50 text-xs bg-white/5 px-2 py-0.5 rounded">{question.domain}</span>
            )}
            {question.skill && (
              <span className="text-soft-gray/50 text-xs bg-white/5 px-2 py-0.5 rounded">{question.skill}</span>
            )}
            {question.difficulty && (
              <span className={clsx(
                "text-xs font-medium px-2 py-0.5 rounded",
                question.difficulty === "Easy" ? "bg-lime-green/10 text-lime-green" :
                question.difficulty === "Medium" ? "bg-amber/10 text-amber" :
                "bg-rose/10 text-rose"
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
                ? "bg-electric-blue/20 text-electric-blue border border-electric-blue/30"
                : "bg-white/5 text-soft-gray/50 border border-white/10 hover:border-electric-blue/20 hover:text-electric-blue"
            )}
          >
            <BookOpen size={14} />
            {classReview ? "Marked for class review" : "Mark for class review"}
          </button>
        </div>
        <p className="text-soft-gray/80 leading-relaxed">{question.questionText}</p>
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
                    ? "bg-lime-green/8 border-lime-green/20"
                    : "bg-white/2 border-white/6"
                )}
              >
                <span className={clsx(
                  "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
                  isCorrect ? "bg-lime-green text-deep-navy" : "bg-white/10 text-soft-gray/50"
                )}>
                  {ch.letter}
                </span>
                <div className="flex-1">
                  <p className={isCorrect ? "text-lime-green" : "text-soft-gray/70"}>{ch.text}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 bg-white/5 rounded-full h-1.5 max-w-48 overflow-hidden">
                      <div
                        className={clsx("h-full rounded-full", isCorrect ? "bg-lime-green" : "bg-electric-blue/50")}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-soft-gray/40 text-xs">{count} ({pct.toFixed(0)}%)</span>
                  </div>
                </div>
                {isCorrect && <Check size={16} className="text-lime-green flex-shrink-0 mt-0.5" />}
              </div>
            );
          })}
        </div>
      )}

      {/* Stats + chart */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
          <h2 className="text-white font-semibold mb-4">Class Response Distribution</h2>
          <ResponseDistributionChart data={pieData} totalStudents={stats.totalSubmissions} />
        </div>
        <div className="bg-white/3 border border-white/8 rounded-2xl p-5 space-y-4">
          <h2 className="text-white font-semibold">Stats</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-soft-gray/50">Correct rate</span>
              <span className={clsx(
                "font-bold",
                Number(correctRate) >= 70 ? "text-lime-green" :
                Number(correctRate) >= 40 ? "text-amber" : "text-rose"
              )}>{correctRate}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft-gray/50">Correct answer</span>
              <span className="text-lime-green font-bold">{question.correctAnswer}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft-gray/50">Total submissions</span>
              <span className="text-white">{stats.totalSubmissions}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft-gray/50">Left blank</span>
              <span className="text-white">{stats.blankCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-soft-gray/50">Avg time</span>
              <span className="text-white">{fmtTime(stats.avgTimeSeconds)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Explanation */}
      {question.explanation && (
        <div className="bg-lime-green/5 border border-lime-green/10 rounded-2xl p-5">
          <div className="text-lime-green font-semibold text-sm mb-2">Explanation</div>
          <p className="text-soft-gray/70 text-sm leading-relaxed">{question.explanation}</p>
        </div>
      )}

      {/* Wrong / Right students */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {wrongStudents.length > 0 && (
          <div className="bg-rose/5 border border-rose/10 rounded-2xl p-5">
            <h3 className="text-rose font-semibold mb-3 text-sm">Got it wrong ({wrongStudents.length})</h3>
            <div className="space-y-2">
              {wrongStudents.map((s) => {
                const subId = submissionByStudent[s.id];
                return (
                  <div key={s.id} className="flex items-center justify-between text-sm">
                    <div>
                      <div className="text-soft-gray/80">{s.display_name}</div>
                      <div className="text-soft-gray/40 text-xs">{s.email}</div>
                    </div>
                    {subId && (
                      <Link
                        href={`/teacher/tests/${testId}/results/${subId}`}
                        className="text-electric-blue text-xs hover:underline"
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
          <div className="bg-lime-green/5 border border-lime-green/10 rounded-2xl p-5">
            <h3 className="text-lime-green font-semibold mb-3 text-sm">Got it right ({rightStudents.length})</h3>
            <div className="space-y-2">
              {rightStudents.map((s) => (
                <div key={s.id} className="flex items-center text-sm gap-2">
                  <Check size={12} className="text-lime-green flex-shrink-0" />
                  <span className="text-soft-gray/70">{s.display_name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Teacher notes */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-5 space-y-3">
        <h2 className="text-white font-semibold">Private Note</h2>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={handleSaveNote}
          placeholder="Add a private note about this question..."
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-soft-gray/80 placeholder:text-soft-gray/20 focus:outline-none focus:border-electric-blue/40 resize-none"
        />
        <p className="text-soft-gray/30 text-xs">Saves automatically when you click away.</p>
      </div>
    </div>
  );
}
