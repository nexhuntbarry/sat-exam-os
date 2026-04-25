"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { QuestionAnalyticsRow } from "@/components/analytics/QuestionAnalyticsRow";
import { StatCard } from "@/components/analytics/StatCard";
import type { QuestionAnalyticsData } from "@/components/analytics/QuestionAnalyticsRow";

interface Summary {
  hardestQuestion: { questionNumber: number; correctRate: number } | null;
  easiestQuestion: { questionNumber: number; correctRate: number } | null;
  mostFlaggedQuestion: { questionNumber: number; flaggedCount: number } | null;
  avgClassScore: number | null;
  totalSubmissions: number;
}

interface AnalyticsData {
  questions: QuestionAnalyticsData[];
  summary: Summary | null;
}

type SortField = "questionNumber" | "correctRate" | "flaggedCount" | "avgTimeSeconds";

export default function QuestionAnalyticsPage() {
  const params = useParams<{ id: string }>();
  const testId = params.id;

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortField, setSortField] = useState<SortField>("correctRate");
  const [sortAsc, setSortAsc] = useState(true);
  const [domainFilter, setDomainFilter] = useState("all");
  const [difficultyFilter, setDifficultyFilter] = useState("all");

  useEffect(() => {
    fetch(`/api/teacher/tests/${testId}/analytics`)
      .then((r) => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [testId]);

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
          questions: prev.questions.map((q) =>
            q.questionId === questionId ? { ...q, classReview: !current } : q
          ),
        };
      });
    },
    [testId]
  );

  if (loading) {
    return <div className="max-w-5xl mx-auto py-16 text-center text-soft-mute">Loading analytics...</div>;
  }

  if (!data) {
    return <div className="max-w-5xl mx-auto py-16 text-center text-status-error">Failed to load analytics.</div>;
  }

  const { questions, summary } = data;

  // Derive filter options
  const domains = ["all", ...Array.from(new Set(questions.map((q) => q.domain ?? "").filter(Boolean)))];
  const difficulties = ["all", "Easy", "Medium", "Hard"];

  // Filter
  const filtered = questions.filter((q) => {
    if (domainFilter !== "all" && q.domain !== domainFilter) return false;
    if (difficultyFilter !== "all" && q.difficulty !== difficultyFilter) return false;
    return true;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let av: number, bv: number;
    if (sortField === "correctRate") {
      av = a.totalSubmissions > 0 ? a.correctCount / a.totalSubmissions : 0;
      bv = b.totalSubmissions > 0 ? b.correctCount / b.totalSubmissions : 0;
    } else if (sortField === "flaggedCount") {
      av = a.flaggedCount;
      bv = b.flaggedCount;
    } else if (sortField === "avgTimeSeconds") {
      av = a.avgTimeSeconds ?? 0;
      bv = b.avgTimeSeconds ?? 0;
    } else {
      av = a.questionNumber;
      bv = b.questionNumber;
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortAsc ? cmp : -cmp;
  });

  // Class-review questions
  const toTeach = questions.filter((q) => q.classReview);

  const selectCls = "bg-light-bg border border-divider rounded-lg px-3 py-1.5 text-sm text-charcoal focus:outline-none focus:border-warm-coral/50";

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-soft-mute text-sm flex-wrap">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${testId}/results`} className="hover:text-charcoal transition-colors">Results</Link>
        <span>/</span>
        <span className="text-charcoal">Question Analytics</span>
      </div>

      <h1 className="text-2xl font-bold text-charcoal">Question-Level Analytics</h1>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="Avg Class Score"
            value={summary.avgClassScore != null ? `${summary.avgClassScore.toFixed(1)}%` : "—"}
            color="emerald"
          />
          <StatCard
            label="Hardest Question"
            value={summary.hardestQuestion ? `Q${summary.hardestQuestion.questionNumber}` : "—"}
            sub={summary.hardestQuestion ? `${summary.hardestQuestion.correctRate.toFixed(0)}% correct` : undefined}
            color="rose"
          />
          <StatCard
            label="Easiest Question"
            value={summary.easiestQuestion ? `Q${summary.easiestQuestion.questionNumber}` : "—"}
            sub={summary.easiestQuestion ? `${summary.easiestQuestion.correctRate.toFixed(0)}% correct` : undefined}
            color="lime"
          />
          <StatCard
            label="Most Flagged"
            value={summary.mostFlaggedQuestion ? `Q${summary.mostFlaggedQuestion.questionNumber}` : "—"}
            sub={summary.mostFlaggedQuestion ? `${summary.mostFlaggedQuestion.flaggedCount} flags` : undefined}
            color="amber"
          />
        </div>
      )}

      {/* To-Teach panel */}
      {toTeach.length > 0 && (
        <div className="bg-warm-coral/5 border border-warm-coral/20 rounded-2xl p-5">
          <h2 className="text-warm-coral font-semibold mb-3">To Teach in Class ({toTeach.length})</h2>
          <div className="flex flex-wrap gap-2">
            {toTeach.map((q) => (
              <Link
                key={q.questionId}
                href={`/teacher/tests/${testId}/analytics/${q.questionId}`}
                className="px-3 py-1.5 bg-warm-coral/15 border border-warm-coral/20 rounded-lg text-warm-coral text-sm hover:bg-warm-coral/25 transition-colors"
              >
                Q{q.questionNumber}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Filters + sort */}
      <div className="flex flex-wrap items-center gap-3">
        <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} className={selectCls}>
          {domains.map((d) => (
            <option key={d} value={d}>{d === "all" ? "All Domains" : d}</option>
          ))}
        </select>
        <select value={difficultyFilter} onChange={(e) => setDifficultyFilter(e.target.value)} className={selectCls}>
          {difficulties.map((d) => (
            <option key={d} value={d}>{d === "all" ? "All Difficulties" : d}</option>
          ))}
        </select>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-soft-mute text-sm">Sort by:</span>
          <select
            value={sortField}
            onChange={(e) => setSortField(e.target.value as SortField)}
            className={selectCls}
          >
            <option value="questionNumber">Question #</option>
            <option value="correctRate">Correct Rate</option>
            <option value="flaggedCount">Most Flagged</option>
            <option value="avgTimeSeconds">Avg Time</option>
          </select>
          <button
            onClick={() => setSortAsc((v) => !v)}
            className="px-3 py-1.5 bg-light-bg border border-divider rounded-lg text-sm text-mid-gray hover:text-charcoal transition-colors"
          >
            {sortAsc ? "↑ Asc" : "↓ Desc"}
          </button>
        </div>
      </div>

      {/* Question rows */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {/* Table header */}
        <div className="px-5 py-3 border-b border-divider flex items-center gap-4 text-soft-mute text-xs font-medium">
          <div className="w-4" />
          <div className="w-8">Q#</div>
          <div className="flex-1">Question</div>
          <div className="w-20 text-right">Correct %</div>
          <div className="w-36 hidden md:block text-center">Distribution</div>
          <div className="w-16 text-center hidden sm:block">Flagged</div>
          <div className="w-20 text-center">Review</div>
        </div>
        {sorted.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">No questions match the current filters.</div>
        ) : (
          sorted.map((q) => (
            <QuestionAnalyticsRow
              key={q.questionId}
              q={q}
              onToggleClassReview={handleToggleClassReview}
            />
          ))
        )}
      </div>
    </div>
  );
}
