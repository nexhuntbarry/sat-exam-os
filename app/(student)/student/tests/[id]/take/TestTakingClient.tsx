"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Flag } from "lucide-react";
import { clsx } from "clsx";
import TestTimer from "@/components/tests/TestTimer";
import QuestionRenderer from "@/components/tests/QuestionRenderer";
import QuestionNavigator from "@/components/tests/QuestionNavigator";
import SubmitModal from "@/components/tests/SubmitModal";

interface Question {
  id: string;
  module_id: string;
  original_question_number: number;
  question_text: string;
  choices: { label: string; text: string }[];
  question_type: "Multiple Choice" | "Student Produced Response";
  has_image: boolean;
  has_table: boolean;
  source_pdf_url?: string | null;
  page_number?: number | null;
  section: string;
  image_urls?: string[] | null;
  image_alts?: string[] | null;
}

interface Props {
  testId: string;
  submissionId: string;
  initialAnswers: Record<string, string>;
  initialMetadata: Record<string, unknown>;
  test: { id: string; name: string; timeLimitMinutes: number; dueDate: string | null };
  questions: Question[];
  timeRemainingSeconds: number;
}

const AUTO_SAVE_DEBOUNCE_MS = 3000;

export default function TestTakingClient({
  testId,
  submissionId,
  initialAnswers,
  initialMetadata,
  test,
  questions,
  timeRemainingSeconds,
}: Props) {
  const router = useRouter();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tabSwitchCount, setTabSwitchCount] = useState(
    typeof initialMetadata.tab_switches === "number" ? initialMetadata.tab_switches : 0
  );
  const [tabSwitchBannerVisible, setTabSwitchBannerVisible] = useState(false);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const tabSwitchRef = useRef(tabSwitchCount);
  tabSwitchRef.current = tabSwitchCount;

  // Auto-save debounced
  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await fetch(`/api/student/submissions/${submissionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers: answersRef.current,
            metadata: { tab_switches: tabSwitchRef.current },
          }),
        });
      } catch {
        // Silent fail — will retry on next change
      }
    }, AUTO_SAVE_DEBOUNCE_MS);
  }, [submissionId]);

  // Tab visibility tracking
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        setTabSwitchCount((c) => c + 1);
        setTabSwitchBannerVisible(true);
        scheduleSave();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [scheduleSave]);

  // Auto-dismiss tab-switch banner after 6 seconds.
  useEffect(() => {
    if (!tabSwitchBannerVisible) return;
    const t = setTimeout(() => setTabSwitchBannerVisible(false), 6000);
    return () => clearTimeout(t);
  }, [tabSwitchBannerVisible]);

  // Save on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  function handleAnswer(questionId: string, answer: string) {
    setAnswers((prev) => {
      const next = { ...prev, [questionId]: answer };
      answersRef.current = next;
      scheduleSave();
      return next;
    });
  }

  function toggleFlag(questionId: string) {
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  }

  async function handleSubmit() {
    setIsSubmitting(true);
    // Save latest answers first
    try {
      await fetch(`/api/student/submissions/${submissionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: answersRef.current,
          metadata: { tab_switches: tabSwitchRef.current },
        }),
      });
    } catch { /* ignore */ }

    try {
      const res = await fetch(`/api/student/submissions/${submissionId}/submit`, { method: "POST" });
      if (res.ok) {
        router.push(`/student/tests/${testId}/result?submission=${submissionId}`);
      } else {
        setIsSubmitting(false);
        setShowSubmitModal(false);
      }
    } catch {
      setIsSubmitting(false);
      setShowSubmitModal(false);
    }
  }

  function handleTimerExpire() {
    handleSubmit();
  }

  const currentQuestion = questions[currentIndex];
  const answeredCount = questions.filter((q) => answers[q.id] && answers[q.id].trim() !== "").length;
  const questionIds = questions.map((q) => q.id);

  return (
    <div className="flex flex-col h-screen bg-cream">
      {tabSwitchBannerVisible && (
        <div
          role="status"
          aria-live="polite"
          className="shrink-0 bg-warm-amber/15 border-b border-warm-amber/30 text-warm-amber-dark text-sm px-4 py-2 text-center"
        >
          Tab switch recorded ({tabSwitchCount}). Stay on this tab during the test.
        </div>
      )}
      {/* Top bar */}
      <div className="shrink-0 border-b border-divider px-4 sm:px-6 py-3 flex items-center justify-between gap-3 overflow-x-hidden">
        <div className="font-semibold text-charcoal truncate text-sm md:text-base">{test.name}</div>

        <div className="flex items-center gap-4">
          <span className="text-soft-mute text-sm hidden sm:block">
            {currentIndex + 1} / {questions.length}
          </span>
          <TestTimer initialSeconds={timeRemainingSeconds} onExpire={handleTimerExpire} />
          <button
            onClick={() => setShowSubmitModal(true)}
            className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
          >
            Submit
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="max-w-3xl mx-auto p-4 sm:p-6">
          {currentQuestion ? (
            <div className="space-y-6">
              <QuestionRenderer
                question={currentQuestion}
                selectedAnswer={answers[currentQuestion.id] ?? ""}
                onAnswer={(ans) => handleAnswer(currentQuestion.id, ans)}
                questionIndex={currentIndex}
                totalQuestions={questions.length}
              />

              {/* Flag button */}
              <button
                onClick={() => toggleFlag(currentQuestion.id)}
                className={clsx(
                  "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                  flagged.has(currentQuestion.id)
                    ? "bg-status-warning/15 text-status-warning"
                    : "bg-light-bg text-soft-mute hover:text-charcoal hover:bg-light-bg"
                )}
              >
                <Flag size={12} />
                {flagged.has(currentQuestion.id) ? "Flagged for Review" : "Flag for Review"}
              </button>
            </div>
          ) : (
            <div className="py-16 text-center text-soft-mute">No questions found.</div>
          )}
        </div>
      </div>

      {/* Prev / Next */}
      <div className="shrink-0 border-t border-divider px-6 py-3 flex items-center justify-between">
        <button
          onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          disabled={currentIndex === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider transition-colors text-sm disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={16} /> Previous
        </button>

        <span className="text-soft-mute text-xs">
          {answeredCount}/{questions.length} answered
        </span>

        <button
          onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
          disabled={currentIndex === questions.length - 1}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider transition-colors text-sm disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next <ChevronRight size={16} />
        </button>
      </div>

      {/* Question navigator */}
      <QuestionNavigator
        totalQuestions={questions.length}
        currentIndex={currentIndex}
        answers={answers}
        questionIds={questionIds}
        flagged={flagged}
        onNavigate={setCurrentIndex}
        onToggleFlag={toggleFlag}
      />

      {/* Submit modal */}
      {showSubmitModal && (
        <SubmitModal
          totalQuestions={questions.length}
          answeredCount={answeredCount}
          isSubmitting={isSubmitting}
          onConfirm={handleSubmit}
          onCancel={() => setShowSubmitModal(false)}
        />
      )}
    </div>
  );
}
