"use client";

import { ExternalLink } from "lucide-react";
import { clsx } from "clsx";
import MathMarkdown from "@/components/MathMarkdown";
import HighlightableBlock, { type Annotation } from "@/components/tests/HighlightableBlock";

interface Choice {
  label: string;
  text: string;
}

interface Question {
  id: string;
  module_id: string;
  original_question_number: number;
  question_text: string;
  choices: Choice[];
  question_type: "Multiple Choice" | "Student Produced Response";
  has_image: boolean;
  has_table: boolean;
  source_pdf_url?: string | null;
  page_number?: number | null;
  /** "Math" or "Reading & Writing" — drives the two-column split. */
  section?: string | null;
  image_urls?: string[] | null;
  image_alts?: string[] | null;
}

// Heuristic: for R&W questions whose stems carry a long passage, find
// the LAST sentence that looks like the actual question and split
// `question_text` into { passage, stem }. Everything before the
// question sentence is treated as the passage; everything from that
// sentence onward (including its terminator) is the stem.
//
// Triggers shown to start a question stem in SAT R&W:
//   "Which choice…", "Which of the following…", "What is…",
//   "Which finding…", "The author's main purpose…", "Based on the
//   passage…", "As used in…", etc.
//
// Returns { passage: null, stem: text } when no split is warranted —
// then the renderer falls back to single-column mode.
function splitPassageAndStem(raw: string): { passage: string | null; stem: string } {
  if (!raw) return { passage: null, stem: raw };
  // Triggers are matched case-insensitive at sentence boundaries.
  const triggers = [
    "which choice",
    "which of the following",
    "which finding",
    "what is the main",
    "what is the purpose",
    "what does the",
    "what choice",
    "based on the passage",
    "based on the text",
    "as used in",
    "the author",
    "the text most strongly",
    "the passage most strongly",
    "according to the passage",
    "according to the text",
    "in the context",
  ];
  const lower = raw.toLowerCase();
  let bestStart = -1;
  for (const t of triggers) {
    let idx = lower.indexOf(t);
    while (idx !== -1) {
      const isSentenceStart = idx === 0 || /[.\n!?]\s*$/.test(raw.slice(0, idx).trimEnd().slice(-1) + " ");
      if (isSentenceStart) {
        if (idx > bestStart) bestStart = idx;
      }
      idx = lower.indexOf(t, idx + 1);
    }
  }
  // Only split when there's meaningful passage content before the trigger.
  // 200 chars is roughly two long sentences — below that the question is
  // already concise and single-column reads better.
  if (bestStart < 200) return { passage: null, stem: raw };
  // Walk back to the previous sentence terminator so the passage ends
  // cleanly instead of mid-sentence.
  let cut = bestStart;
  for (let i = bestStart - 1; i >= 0; i--) {
    const c = raw[i];
    if (c === "." || c === "!" || c === "?" || c === "\n") {
      cut = i + 1;
      break;
    }
  }
  const passage = raw.slice(0, cut).trim();
  const stem = raw.slice(cut).trim();
  if (!stem) return { passage: null, stem: raw };
  return { passage, stem };
}

// Per-anchor annotations within a single question. Keys are stable
// strings ("stem", "choice:A"…) so highlights re-bind on resume.
export type QuestionAnnotations = Record<string, Annotation[]>;

interface QuestionRendererProps {
  question: Question;
  selectedAnswer: string;
  onAnswer: (answer: string) => void;
  questionIndex: number;
  totalQuestions: number;
  /** When true, R&W highlight UX is on; Math tests pass false. */
  annotationsEnabled?: boolean;
  annotations?: QuestionAnnotations;
  onAnnotationsChange?: (next: QuestionAnnotations) => void;
  /** Bluebook "eliminate" tool — set of choice labels the student
   *  has crossed out. Crossed-out choices stay clickable to undo, but
   *  show strikethrough styling so the student can rule them out. */
  crossedOut?: Set<string>;
  onToggleCrossOut?: (label: string) => void;
}

export default function QuestionRenderer({
  question,
  selectedAnswer,
  onAnswer,
  questionIndex,
  totalQuestions,
  annotationsEnabled = false,
  annotations,
  onAnnotationsChange,
  crossedOut,
  onToggleCrossOut,
}: QuestionRendererProps) {
  const isMultipleChoice = question.question_type === "Multiple Choice";
  void questionIndex;
  void totalQuestions;

  // R&W passages get the Bluebook two-column layout: passage on the
  // left, stem + choices on the right. Math (and short R&W stems)
  // stay single column.
  const isRW = (question.section ?? "").toLowerCase().includes("reading");
  const split = isRW ? splitPassageAndStem(question.question_text) : { passage: null, stem: question.question_text };
  const passageText = split.passage;
  const stemText = split.stem;

  function annosFor(anchor: string): Annotation[] {
    return annotations?.[anchor] ?? [];
  }
  function setAnnosFor(anchor: string, list: Annotation[]) {
    if (!onAnnotationsChange) return;
    const next: QuestionAnnotations = { ...(annotations ?? {}) };
    if (list.length === 0) {
      delete next[anchor];
    } else {
      next[anchor] = list;
    }
    onAnnotationsChange(next);
  }

  // Layout body — single-column for Math / short R&W; two-column for
  // long R&W passages so the passage stays parked on the left while the
  // student works the stem + choices on the right.
  const body = (
    <>
      {/* Visual flags — image/table indicators stay so students know
          to scroll for the figure. */}
      {(question.has_image || question.has_table) && (
        <div>
          <span className="px-2 py-1 rounded-full bg-status-warning/15 text-status-warning text-xs font-medium inline-flex items-center gap-1">
            {question.has_image ? "Has Image" : "Has Table"}
          </span>
        </div>
      )}

      {/* Question stem (or whole text when there's no passage split) */}
      <HighlightableBlock
        anchor="stem"
        annotations={annosFor("stem")}
        onChange={(list) => setAnnosFor("stem", list)}
        enabled={annotationsEnabled}
      >
        <MathMarkdown className="prose prose-base max-w-none text-charcoal leading-relaxed [&_p]:my-2">
          {stemText}
        </MathMarkdown>
      </HighlightableBlock>

      {/* Inline PDF page — primary path for any question flagged with a
          visual element. The serverless image cropper is too fragile, so we
          render the original PDF page directly via iframe + #page=N. */}
      {(question.has_image || question.has_table) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-soft-mute text-xs uppercase tracking-wide font-medium">
              Source figure · Page {question.page_number ?? 1}
            </p>
            <a
              href={`/api/modules/${question.module_id}/page/${question.page_number ?? 1}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-warm-coral hover:underline"
            >
              Open in new tab <ExternalLink size={12} />
            </a>
          </div>
          <iframe
            src={`/api/modules/${question.module_id}/page/${question.page_number ?? 1}`}
            className="w-full h-[480px] rounded-xl border border-divider bg-white"
            title={`Question figure (PDF page ${question.page_number ?? 1})`}
          />
        </div>
      )}

      {/* Optional fallback — extracted crops still rendered when present, as
          an enhancement to the inline PDF view. */}
      {question.image_urls && question.image_urls.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {question.image_urls.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={`/api/blob-image?u=${encodeURIComponent(url)}`}
              alt={question.image_alts?.[i] ?? "Question image"}
              className="max-w-full md:max-w-lg rounded-xl border border-divider bg-white"
            />
          ))}
        </div>
      )}

      {/* Answer area */}
      {isMultipleChoice ? (
        <div className="space-y-3">
          {(question.choices ?? []).map((choice) => {
            const isSelected = selectedAnswer === choice.label;
            const isCrossed = crossedOut?.has(choice.label) ?? false;
            const choiceAnchor = `choice:${choice.label}`;
            return (
              <div
                key={choice.label}
                className={clsx(
                  "flex items-stretch gap-2 rounded-xl border transition-all",
                  isSelected && !isCrossed
                    ? "border-warm-coral bg-warm-coral/10"
                    : "border-divider bg-surface",
                )}
              >
                <button
                  // Bluebook treats crossed-out as "don't pick this".
                  // Clicking the body of a crossed choice un-crosses it
                  // and selects it; clicking when not crossed selects.
                  onClick={() => {
                    if (annotationsEnabled) {
                      const sel = window.getSelection?.();
                      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                        return;
                      }
                    }
                    if (isCrossed && onToggleCrossOut) {
                      onToggleCrossOut(choice.label);
                    }
                    onAnswer(choice.label);
                  }}
                  className={clsx(
                    "flex-1 flex items-start gap-3 p-4 text-left transition-all text-charcoal",
                    isCrossed && "line-through opacity-50 hover:opacity-70",
                    !isCrossed && "hover:bg-light-bg",
                  )}
                >
                  <span
                    className={clsx(
                      "shrink-0 w-8 h-8 rounded-full border-2 flex items-center justify-center text-sm font-bold transition-colors",
                      isSelected && !isCrossed
                        ? "border-warm-coral bg-warm-coral text-white"
                        : "border-charcoal/40 text-charcoal",
                    )}
                  >
                    {choice.label}
                  </span>
                  <HighlightableBlock
                    anchor={choiceAnchor}
                    annotations={annosFor(choiceAnchor)}
                    onChange={(list) => setAnnosFor(choiceAnchor, list)}
                    enabled={annotationsEnabled}
                    className="flex-1"
                  >
                    <MathMarkdown className="prose prose-sm max-w-none text-inherit leading-relaxed pt-1 [&_p]:my-0">
                      {choice.text}
                    </MathMarkdown>
                  </HighlightableBlock>
                </button>

                {/* Eliminate / un-eliminate toggle on the right edge.
                    Mirrors Bluebook's "ABC̶" cross-out tool — students
                    rule out wrong choices then pick from what's left. */}
                {onToggleCrossOut && (
                  <button
                    onClick={() => onToggleCrossOut(choice.label)}
                    title={isCrossed ? `Restore choice ${choice.label}` : `Eliminate choice ${choice.label}`}
                    aria-label={isCrossed ? `Restore choice ${choice.label}` : `Eliminate choice ${choice.label}`}
                    className={clsx(
                      "px-3 shrink-0 flex items-center justify-center text-xs font-bold border-l transition-colors",
                      isCrossed
                        ? "text-warm-coral border-warm-coral/30 bg-warm-coral/10 hover:bg-warm-coral/15"
                        : "text-mid-gray border-divider hover:bg-light-bg hover:text-charcoal",
                    )}
                  >
                    {isCrossed ? "Undo" : <span className="line-through">ABC</span>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-soft-mute text-sm">Your Answer</label>
          <input
            type="text"
            value={selectedAnswer}
            onChange={(e) => onAnswer(e.target.value)}
            placeholder="Enter your answer (e.g. 3, 1/2, 0.5)"
            className="w-full max-w-xs px-4 py-3 rounded-xl bg-surface border border-divider text-charcoal placeholder-soft-mute focus:outline-none focus:border-warm-coral/60 focus:bg-surface transition-colors"
          />
          <p className="text-soft-mute text-xs">
            For fractions, you may enter as decimal (0.5) or fraction (1/2). Both are accepted.
          </p>
        </div>
      )}
    </>
  );

  if (passageText) {
    // Bluebook R&W layout: passage left, question + choices right,
    // both vertically scrollable independently when content overflows.
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
        <div className="lg:border-r lg:border-divider lg:pr-6">
          <p className="text-soft-mute text-xs uppercase tracking-wider font-medium mb-2">
            Passage
          </p>
          <HighlightableBlock
            anchor="passage"
            annotations={annosFor("passage")}
            onChange={(list) => setAnnosFor("passage", list)}
            enabled={annotationsEnabled}
          >
            <MathMarkdown className="prose prose-base max-w-none text-charcoal leading-relaxed [&_p]:my-2">
              {passageText}
            </MathMarkdown>
          </HighlightableBlock>
        </div>
        <div className="space-y-5">{body}</div>
      </div>
    );
  }

  return <div className="space-y-5">{body}</div>;
}
