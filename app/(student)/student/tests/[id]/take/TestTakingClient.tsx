"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  Calculator,
  BookOpen,
  X,
  Eye,
  EyeOff,
  MoreHorizontal,
  Grid3x3,
} from "lucide-react";
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
  test: {
    id: string;
    name: string;
    timeLimitMinutes: number;
    dueDate: string | null;
    moduleLabel: string | null;
    desmosEnabled: boolean;
    formulaSheetUrl: string | null;
    /** When true, R&W highlight UX is enabled on the stem. */
    annotationsEnabled: boolean;
  };
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
  const [activeAid, setActiveAid] = useState<"desmos" | "formula" | null>(null);
  const hasAids = test.desmosEnabled || !!test.formulaSheetUrl;
  // Bluebook-style controls: toggleable timer, navigator overlay, per-
  // question crossed-out choices ("eliminate" tool).
  const [timerHidden, setTimerHidden] = useState(false);
  const [showNavigator, setShowNavigator] = useState(false);
  const [crossedOut, setCrossedOut] = useState<Record<string, Set<string>>>({});
  const toggleCrossOut = useCallback((questionId: string, label: string) => {
    setCrossedOut((prev) => {
      const next = { ...prev };
      const set = new Set(next[questionId] ?? []);
      if (set.has(label)) set.delete(label);
      else set.add(label);
      next[questionId] = set;
      return next;
    });
  }, []);

  // Per-question highlight annotations, keyed by question id.
  // Restored from initialMetadata.annotations on resume; persisted via
  // the same auto-save channel as answers/tab_switches.
  type QuestionAnnos = Record<string, Record<string, { start: number; end: number; note?: string }[]>>;
  const initialAnnotations: QuestionAnnos =
    (initialMetadata.annotations as QuestionAnnos | undefined) ?? {};
  const [annotations, setAnnotations] = useState<QuestionAnnos>(initialAnnotations);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const tabSwitchRef = useRef(tabSwitchCount);
  tabSwitchRef.current = tabSwitchCount;
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

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
            metadata: {
            tab_switches: tabSwitchRef.current,
            annotations: annotationsRef.current,
          },
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

  // Keyboard shortcuts — Bluebook-style: A/B/C/D selects the choice,
  // N/Right/Enter advances, P/Left goes back, F toggles flag, Esc
  // closes any open overlay. We ignore key events when the focus is
  // inside an input/textarea (so SPR typing isn't intercepted).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const q = questions[currentIndex];
      if (!q) return;
      const isMcq = q.question_type === "Multiple Choice";

      if (e.key === "Escape") {
        if (showNavigator) setShowNavigator(false);
        else if (showSubmitModal) setShowSubmitModal(false);
        return;
      }
      if (isMcq && /^[a-dA-D]$/.test(e.key)) {
        const label = e.key.toUpperCase();
        if (q.choices.some((c) => c.label === label)) {
          handleAnswer(q.id, label);
          e.preventDefault();
        }
        return;
      }
      if (e.key === "n" || e.key === "N" || e.key === "ArrowRight" || e.key === "Enter") {
        if (currentIndex < questions.length - 1) {
          setCurrentIndex((i) => Math.min(questions.length - 1, i + 1));
          e.preventDefault();
        }
        return;
      }
      if (e.key === "p" || e.key === "P" || e.key === "ArrowLeft") {
        if (currentIndex > 0) {
          setCurrentIndex((i) => Math.max(0, i - 1));
          e.preventDefault();
        }
        return;
      }
      if (e.key === "f" || e.key === "F") {
        toggleFlag(q.id);
        e.preventDefault();
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // handleAnswer is defined later in the component but reading the
    // latest closure value through state is sufficient for shortcut
    // intent — the answer is committed via setAnswers anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, questions, showNavigator, showSubmitModal]);

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
    // Inline-save the latest answers + metadata into the submit
    // request itself instead of doing a separate PATCH first. One
    // round trip instead of two — was the dominant cause of the
    // ~1-minute submit lag students reported.
    try {
      const res = await fetch(`/api/student/submissions/${submissionId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: answersRef.current,
          metadata: {
            tab_switches: tabSwitchRef.current,
            annotations: annotationsRef.current,
          },
        }),
      });
      if (res.ok) {
        // Adaptive flow: the submit endpoint creates the Module 2 row
        // and returns its id. Send the student back into /take so the
        // server picks up the new In-Progress submission and renders
        // Module 2 questions.
        const payload = await res.json().catch(() => null);
        const nextId = payload?.data?.nextSubmissionId as string | undefined;
        if (nextId) {
          router.push(`/student/tests/${testId}/take`);
          router.refresh();
        } else {
          router.push(`/student/tests/${testId}/result?submission=${submissionId}`);
        }
      } else {
        setIsSubmitting(false);
        setShowSubmitModal(false);
      }
    } catch {
      setIsSubmitting(false);
      setShowSubmitModal(false);
    }
  }

  const [autoSubmitting, setAutoSubmitting] = useState(false);

  function handleTimerExpire() {
    setAutoSubmitting(true);
    handleSubmit();
  }

  const currentQuestion = questions[currentIndex];
  const answeredCount = questions.filter((q) => answers[q.id] && answers[q.id].trim() !== "").length;
  const questionIds = questions.map((q) => q.id);

  return (
    <div className="flex flex-col h-screen bg-cream">
      {autoSubmitting && (
        <div
          role="alert"
          aria-live="assertive"
          className="shrink-0 bg-status-warning text-white text-sm px-4 py-2 text-center font-medium"
        >
          ⏱ Time&rsquo;s up — submitting your test automatically. Please wait…
        </div>
      )}
      {tabSwitchBannerVisible && (
        <div
          role="status"
          aria-live="polite"
          className="shrink-0 bg-warm-amber/15 border-b border-warm-amber/30 text-warm-amber-dark text-sm px-4 py-2 text-center"
        >
          Tab switch recorded ({tabSwitchCount}). Stay on this tab during the test.
        </div>
      )}
      {/* Bluebook-style top bar: title + module on the left, timer
          centered (with hide toggle), tool buttons + Submit on the
          right. Mirrors College Board's digital SAT chrome so students
          who've used the real Bluebook app feel at home. */}
      <div className="shrink-0 border-b border-divider px-4 sm:px-6 py-2.5 grid grid-cols-3 items-center gap-3 overflow-x-hidden bg-cream">
        {/* Left: title + module pill */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="font-semibold text-charcoal truncate text-sm md:text-base">{test.name}</div>
          {test.moduleLabel && (
            <span className="shrink-0 px-2 py-0.5 rounded-full bg-warm-coral/10 text-warm-coral text-xs font-medium">
              {test.moduleLabel}
            </span>
          )}
        </div>

        {/* Center: timer w/ hide toggle. Bluebook shows the timer big
            in the middle and gives students a single click to obscure
            it for the "I don't want to look at the clock right now"
            case — useful for anxious test-takers. */}
        <div className="flex items-center justify-center gap-2">
          {timerHidden ? (
            <button
              onClick={() => setTimerHidden(false)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-light-bg text-mid-gray hover:text-charcoal text-sm font-medium"
            >
              <Eye size={14} /> Show Timer
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <TestTimer initialSeconds={timeRemainingSeconds} onExpire={handleTimerExpire} />
              <button
                onClick={() => setTimerHidden(true)}
                className="text-soft-mute hover:text-charcoal p-1"
                aria-label="Hide timer"
                title="Hide timer"
              >
                <EyeOff size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Right: tool buttons + Submit */}
        <div className="flex items-center justify-end gap-2">
          {test.desmosEnabled && (
            <button
              onClick={() => setActiveAid((a) => (a === "desmos" ? null : "desmos"))}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                activeAid === "desmos"
                  ? "bg-warm-coral text-white"
                  : "bg-warm-coral/10 text-warm-coral hover:bg-warm-coral/15",
              )}
              title="Desmos calculator"
            >
              <Calculator size={13} /> Calculator
            </button>
          )}
          {test.formulaSheetUrl && (
            <button
              onClick={() => setActiveAid((a) => (a === "formula" ? null : "formula"))}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                activeAid === "formula"
                  ? "bg-warm-coral text-white"
                  : "bg-warm-coral/10 text-warm-coral hover:bg-warm-coral/15",
              )}
              title="Formula reference sheet"
            >
              <BookOpen size={13} /> Reference
            </button>
          )}
          <button
            onClick={() => setShowSubmitModal(true)}
            className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
          >
            Submit
          </button>
        </div>
      </div>

      {/* Main + optional Math aids side panel.
          The aid panel is a true split (not a modal) so the student can
          work the calculator and read the question side-by-side, like
          the digital SAT. We size it 40% on wide screens and let it
          float full-screen on narrow ones via the modal overlay below. */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className={clsx(
          "flex-1 overflow-y-auto overflow-x-hidden",
          activeAid && "hidden md:block",
        )}>
        <div className="max-w-3xl mx-auto p-4 sm:p-6">
          {currentQuestion ? (
            <div className="space-y-6">
              {/* Question header: number on the left, "Mark for Review"
                  on the right (Bluebook places the flag toggle inline
                  with the question header, not below the choices). */}
              <div className="flex items-center justify-between border-b border-divider pb-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-charcoal text-cream text-sm font-bold">
                    {currentIndex + 1}
                  </span>
                  <span className="text-soft-mute text-sm">of {questions.length}</span>
                </div>
                <button
                  onClick={() => toggleFlag(currentQuestion.id)}
                  className={clsx(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                    flagged.has(currentQuestion.id)
                      ? "bg-status-warning/15 text-status-warning hover:bg-status-warning/25"
                      : "text-mid-gray hover:text-warm-coral hover:bg-warm-coral/10",
                  )}
                  aria-pressed={flagged.has(currentQuestion.id)}
                >
                  <Flag
                    size={15}
                    className={flagged.has(currentQuestion.id) ? "fill-status-warning/40" : ""}
                  />
                  {flagged.has(currentQuestion.id) ? "Marked for Review" : "Mark for Review"}
                </button>
              </div>

              <QuestionRenderer
                question={currentQuestion}
                selectedAnswer={answers[currentQuestion.id] ?? ""}
                onAnswer={(ans) => handleAnswer(currentQuestion.id, ans)}
                questionIndex={currentIndex}
                totalQuestions={questions.length}
                annotationsEnabled={test.annotationsEnabled}
                annotations={annotations[currentQuestion.id] ?? {}}
                crossedOut={crossedOut[currentQuestion.id] ?? new Set()}
                onToggleCrossOut={(label) => toggleCrossOut(currentQuestion.id, label)}
                onAnnotationsChange={(next) => {
                  setAnnotations((prev) => {
                    const merged = { ...prev };
                    if (Object.keys(next).length === 0) {
                      delete merged[currentQuestion.id];
                    } else {
                      merged[currentQuestion.id] = next;
                    }
                    annotationsRef.current = merged;
                    scheduleSave();
                    return merged;
                  });
                }}
              />
            </div>
          ) : (
            <div className="py-16 text-center text-soft-mute">No questions found.</div>
          )}
        </div>
        </div>

        {activeAid && hasAids && (
          <div className="flex flex-col w-full md:w-[42%] lg:w-[40%] border-l border-divider bg-surface min-h-0">
            <div className="shrink-0 flex items-center justify-between border-b border-divider px-3 py-2">
              <div className="flex items-center gap-1.5 text-charcoal text-sm font-semibold">
                {activeAid === "desmos" ? (
                  <><Calculator size={14} className="text-warm-coral" /> Desmos calculator</>
                ) : (
                  <><BookOpen size={14} className="text-warm-coral" /> Formula reference</>
                )}
              </div>
              <button
                onClick={() => setActiveAid(null)}
                className="text-soft-mute hover:text-charcoal p-1"
                aria-label="Close panel"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto bg-light-bg">
              {activeAid === "desmos" ? (
                <iframe
                  src="https://www.desmos.com/calculator"
                  title="Desmos calculator"
                  className="w-full h-full border-0"
                  allow="clipboard-read; clipboard-write"
                />
              ) : test.formulaSheetUrl ? (
                <img
                  src={
                    // Vercel Blob URLs are private by default and require an
                    // auth header to fetch. Route them through the existing
                    // /api/blob-image proxy so <img> works without exposing
                    // the read-token to the client.
                    test.formulaSheetUrl.includes(".blob.vercel-storage.com")
                      ? `/api/blob-image?u=${encodeURIComponent(test.formulaSheetUrl)}`
                      : test.formulaSheetUrl
                  }
                  alt="Formula reference sheet"
                  className="w-full h-auto"
                />
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* Bluebook bottom bar: Back / center pill that opens the
          navigator overlay / Next. Centered "Question N of M" mirrors
          the official app and gives students an obvious tap target to
          jump anywhere in the section. */}
      <div className="shrink-0 border-t border-divider px-6 py-3 grid grid-cols-3 items-center gap-3 bg-cream">
        <div className="flex justify-start">
          <button
            onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-charcoal text-cream hover:bg-charcoal/90 transition-colors text-sm font-semibold disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} /> Back
          </button>
        </div>

        <div className="flex justify-center">
          <button
            onClick={() => setShowNavigator((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-charcoal/20 bg-surface text-charcoal hover:border-charcoal/40 text-sm font-semibold"
            aria-expanded={showNavigator}
          >
            <Grid3x3 size={14} />
            Question {currentIndex + 1} of {questions.length}
            <span className="text-soft-mute text-xs ml-1">({answeredCount} done)</span>
          </button>
        </div>

        <div className="flex justify-end">
          {currentIndex === questions.length - 1 ? (
            <button
              onClick={() => setShowSubmitModal(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-warm-coral text-white hover:bg-warm-coral-dark transition-colors text-sm font-semibold"
            >
              Review &amp; Submit <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-charcoal text-cream hover:bg-charcoal/90 transition-colors text-sm font-semibold"
            >
              Next <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Question navigator overlay — toggled from the bottom-bar pill.
          Bluebook shows this as a small popover above the pill; we use
          a centered modal-style sheet for clearer focus. */}
      {showNavigator && (
        <div
          className="fixed inset-0 z-40 bg-black/30 flex items-end sm:items-center justify-center"
          onClick={() => setShowNavigator(false)}
        >
          <div
            className="bg-cream rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl shadow-2xl max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-divider">
              <h2 className="text-charcoal font-semibold">Question Navigator</h2>
              <button
                onClick={() => setShowNavigator(false)}
                className="text-soft-mute hover:text-charcoal p-1"
                aria-label="Close navigator"
              >
                <X size={16} />
              </button>
            </div>
            <QuestionNavigator
              totalQuestions={questions.length}
              currentIndex={currentIndex}
              answers={answers}
              questionIds={questionIds}
              flagged={flagged}
              onNavigate={(i) => {
                setCurrentIndex(i);
                setShowNavigator(false);
              }}
              onToggleFlag={toggleFlag}
            />
            <div className="px-5 py-3 border-t border-divider flex justify-end">
              <button
                onClick={() => {
                  setShowNavigator(false);
                  setShowSubmitModal(true);
                }}
                className="px-4 py-2 rounded-xl bg-warm-coral text-white text-sm font-semibold hover:bg-warm-coral-dark"
              >
                Go to Review Page
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit modal — Bluebook-style "Check Your Work" review page
          when grid data is supplied (default for in-test submit). */}
      {showSubmitModal && (
        <SubmitModal
          totalQuestions={questions.length}
          answeredCount={answeredCount}
          isSubmitting={isSubmitting}
          onConfirm={handleSubmit}
          onCancel={() => setShowSubmitModal(false)}
          questionIds={questionIds}
          answers={answers}
          flagged={flagged}
          onJumpTo={(i) => {
            setCurrentIndex(i);
            setShowSubmitModal(false);
          }}
        />
      )}
    </div>
  );
}
