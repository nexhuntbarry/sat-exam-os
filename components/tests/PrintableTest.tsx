import MathMarkdown from "@/components/MathMarkdown";
import { answerCandidates } from "@/lib/grade-submission";

export interface PrintQuestion {
  id: string;
  original_question_number: number;
  question_text: string;
  choices: { label: string; text: string; image_url?: string | null }[] | null;
  question_type: string;
  image_urls?: string[] | null;
  correct_answer: string | null;
}

export interface PrintModule {
  /** "Module 1", "Module 2 · Easier"…; null for a single-module test. */
  label: string | null;
  section: string | null;
  questions: PrintQuestion[];
}

export const imgSrc = (url: string) => `/api/blob-image?u=${encodeURIComponent(url)}`;

// A paper copy of a test: every module, every question as the student sees
// it. withKey marks the correct choice / answer on each question and adds an
// answer key table at the end of each module. Each module starts on a new
// page and a question never splits across pages. Shown through
// PrintPreview (app/(print)/print/tests/[id]).
export default function PrintableTest({
  testName,
  modules,
  withKey,
  generatedOn,
}: {
  testName: string;
  modules: PrintModule[];
  withKey: boolean;
  generatedOn: string;
}) {
  return (
    <div className="bg-white text-charcoal">
      {modules.map((m, mi) => (
        <section key={mi} className={mi > 0 ? "break-before-page pt-2" : ""}>
          <div className="border-b-2 border-charcoal pb-2 mb-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold">{testName}</h1>
                <p className="text-sm text-mid-gray">
                  {[m.section, m.label, `${m.questions.length} questions`].filter(Boolean).join(" · ")}
                </p>
              </div>
              {withKey ? (
                <span className="shrink-0 px-2.5 py-1 rounded-md border-2 border-charcoal text-xs font-bold uppercase tracking-wide">
                  Answer key
                </span>
              ) : (
                <div className="shrink-0 text-sm space-y-2 pt-1">
                  <div>Name ______________________</div>
                  <div>Date ______________________</div>
                </div>
              )}
            </div>
          </div>

          {m.questions.length === 0 && (
            <p className="text-sm text-soft-mute">No approved questions in this module yet.</p>
          )}

          <ol className="space-y-4">
            {m.questions.map((q, qi) => (
              <QuestionBlock key={q.id} q={q} n={qi + 1} withKey={withKey} />
            ))}
          </ol>

          {withKey && m.questions.length > 0 && (
            <div className="break-inside-avoid mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide mb-2">
                Answer key{m.label ? ` · ${m.label}` : ""}
              </h2>
              <div className="grid grid-cols-4 gap-x-4 gap-y-1 text-sm border-t border-divider pt-2">
                {m.questions.map((q, qi) => (
                  <div key={q.id} className="flex gap-2">
                    <span className="w-6 text-right text-mid-gray">{qi + 1}.</span>
                    <span className="font-semibold">{answerCandidates(q.correct_answer).join(" or ") || "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      ))}

      <p className="mt-6 text-xs text-soft-mute">Printed {generatedOn}</p>
    </div>
  );
}

/** A student's answer laid over the question (result printout). */
export interface QuestionResultMarks {
  studentAnswer: string | null;
  /** null = the student may not see the answer key. */
  correctAnswer: string | null;
  outcome: "correct" | "wrong" | "blank" | null;
  /** Shown under the question when set. */
  explanation?: string | null;
}

// Marks drawn as SVG, not ✓/✗/● characters: the server's headless browser
// has almost no fonts, and paper must not rely on colour (B&W printers).
export type MarkKind = "correct" | "wrong" | "blank" | "picked";
const MARK_LABEL: Record<MarkKind, string> = { correct: "correct", wrong: "wrong", blank: "blank", picked: "your answer" };
export function Mark({ kind, size = 12 }: { kind: MarkKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" role="img" aria-label={MARK_LABEL[kind]} className="inline-block align-[-1px]">
      {kind === "correct" && <path d="M2 6.5 L5 9.5 L10.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />}
      {kind === "wrong" && <path d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />}
      {kind === "blank" && <path d="M2.5 6 L9.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" />}
      {kind === "picked" && <circle cx="6" cy="6" r="4" fill="currentColor" />}
    </svg>
  );
}
const sameLetter = (a: string | null | undefined, b: string) => (a ?? "").trim().toUpperCase() === b.trim().toUpperCase();

export function QuestionBlock({
  q,
  n,
  withKey,
  result,
  src = imgSrc,
}: {
  q: PrintQuestion;
  n: number;
  withKey: boolean;
  result?: QuestionResultMarks;
  /** Image URL for a stored blob URL (default: the authenticated proxy). */
  src?: (url: string) => string;
}) {
  const choices = Array.isArray(q.choices) ? q.choices : [];
  const keys = result ? answerCandidates(result.correctAnswer) : answerCandidates(q.correct_answer);
  const showKey = result ? result.correctAnswer != null : withKey;
  const isMC = q.question_type === "Multiple Choice";
  const hasGraphChoices = choices.some((c) => c.image_url);
  const hasFigure = (q.image_urls?.length ?? 0) > 0;
  // Short choices (numbers, single words) sit side by side to save paper.
  const longest = Math.max(0, ...choices.map((c) => (c.text.includes("\n") ? 999 : c.text.replace(/\$[^$]*\$/g, (m) => "x".repeat(Math.ceil(m.length / 2))).length)));
  const marked = withKey; // the answer key's "✓ Correct" label needs room
  const choiceCols = hasGraphChoices ? 1 : longest <= 12 ? (marked ? 2 : 4) : longest <= 32 && !marked ? 2 : 1;
  return (
    // Block layout (not flex) so a long stem/passage can flow across a page
    // break; only the figure (kept with its stem) and the choice list are
    // kept whole (lib/print-page-css).
    <li className="print-question relative pl-9">
      <span className="absolute left-0 top-0.5 flex flex-col items-center gap-0.5">
        <span className="w-6 h-6 rounded bg-charcoal text-white text-xs font-bold flex items-center justify-center">{n}</span>
        {result?.outcome && (
          <span className="text-sm font-bold leading-none" aria-label={result.outcome}>
            <Mark kind={result.outcome} size={13} />
          </span>
        )}
      </span>
      <div className="space-y-2">
        {/* A figure stays on the same page as its (short) stem and is never
            cut; a long passage flows and only the figure is kept whole. */}
        <div className={hasFigure && q.question_text.length < 700 ? "print-keep space-y-2" : "space-y-2"}>
          <MathMarkdown className="print-stem prose prose-sm max-w-none text-charcoal leading-normal [&_p]:my-1">
            {q.question_text}
          </MathMarkdown>
          {hasFigure && (
            <div className="print-figure flex flex-wrap gap-3">
              {q.image_urls!.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={url}
                  src={src(url)}
                  alt={`Figure ${i + 1} for question ${n}`}
                  className="max-w-full max-h-80"
                />
              ))}
            </div>
          )}
        </div>

        {isMC ? (
          // Graph answer choices: a 2-column grid so each graph prints at a
          // readable size (≥1.6in wide) instead of whatever its crop was.
          <ul
            className={`print-choices break-inside-avoid ${
              hasGraphChoices ? "grid grid-cols-2 gap-x-6 gap-y-3" : choiceCols === 4 ? "grid grid-cols-4 gap-x-4 gap-y-1" : choiceCols === 2 ? "grid grid-cols-2 gap-x-6 gap-y-1" : "space-y-1"
            }`}
          >
            {choices.map((c) => {
              const correct = showKey && keys.some((k) => sameLetter(k, c.label));
              const picked = !!result && sameLetter(result.studentAnswer, c.label);
              return (
                <li key={c.label} className={`flex items-start gap-2 break-inside-avoid ${correct ? "font-semibold" : ""}`}>
                  <span
                    className={`shrink-0 w-5 h-5 rounded-full border-2 text-[10px] font-bold flex items-center justify-center ${
                      correct && !result ? "bg-charcoal border-charcoal text-white" : picked ? "border-charcoal" : "border-charcoal/50"
                    }`}
                  >
                    {c.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    {c.text && (
                      <MathMarkdown className="prose prose-sm max-w-none text-inherit [&_p]:my-0">{c.text}</MathMarkdown>
                    )}
                    {c.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={src(c.image_url)}
                        alt={`Choice ${c.label} for question ${n}`}
                        className="mt-1 w-full min-w-[1.6in] max-w-[3in] max-h-[3in] object-contain object-left"
                      />
                    )}
                  </div>
                  {result ? (
                    // Compact marks (legend on the summary page): ● your answer, ✓ correct.
                    (picked || correct) && (
                      <span className="shrink-0 flex items-center gap-1 pt-0.5" aria-label={[picked && "your answer", correct && "correct"].filter(Boolean).join(", ")}>
                        {picked && <Mark kind="picked" />}
                        {correct && <Mark kind="correct" size={14} />}
                      </span>
                    )
                  ) : (
                    correct && <span className="shrink-0 text-xs font-bold pt-1">✓ Correct</span>
                  )}
                </li>
              );
            })}
            {result && result.studentAnswer == null && (
              <li className="text-xs font-semibold col-span-full"><Mark kind="blank" /> No answer given</li>
            )}
          </ul>
        ) : result ? (
          <p className="text-sm">
            <span className="font-semibold">Your answer:</span> {result.studentAnswer ?? "(blank)"}
            {result.correctAnswer != null && (
              <>
                {" · "}
                <span className="font-semibold">Correct:</span> {keys.join(" or ") || result.correctAnswer}
                {result.outcome && <span className="font-bold"> <Mark kind={result.outcome} /></span>}
              </>
            )}
          </p>
        ) : withKey ? (
          <p className="text-sm">
            <span className="font-semibold">Answer:</span> {keys.join(" or ") || "—"}
          </p>
        ) : (
          <p className="text-sm pt-1">Answer: ________________</p>
        )}

        {result?.explanation && (
          <div className="text-xs text-charcoal border-l-2 border-charcoal/40 pl-3 break-inside-avoid">
            <span className="font-semibold">Explanation: </span>
            <MathMarkdown className="prose prose-sm max-w-none text-inherit text-xs [&_p]:my-0.5 inline">{result.explanation}</MathMarkdown>
          </div>
        )}
      </div>
    </li>
  );
}
