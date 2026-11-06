import MathMarkdown from "@/components/MathMarkdown";
import PrintButton from "@/components/analytics/PrintButton";
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

const imgSrc = (url: string) => `/api/blob-image?u=${encodeURIComponent(url)}`;

// A paper copy of a test: every module, every question as the student sees
// it. withKey marks the correct choice / answer on each question and adds an
// answer key table at the end of each module. Each module starts on a new
// page and a question never splits across pages.
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
    <div className="max-w-3xl mx-auto p-6 print:p-0 print:max-w-none bg-white text-charcoal">
      <div className="no-print flex items-center justify-between gap-4 mb-6 p-4 rounded-xl bg-light-bg border border-divider">
        <p className="text-sm text-mid-gray">
          {withKey ? "Test with answer key" : "Blank test"} · use your browser&apos;s print dialog to print or save as PDF.
        </p>
        <PrintButton label="Print" />
      </div>

      {modules.map((m, mi) => (
        <section key={mi} className={mi > 0 ? "break-before-page pt-2" : ""}>
          <header className="border-b-2 border-charcoal pb-3 mb-5">
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
          </header>

          {m.questions.length === 0 && (
            <p className="text-sm text-soft-mute">No approved questions in this module yet.</p>
          )}

          <ol className="space-y-6">
            {m.questions.map((q, qi) => (
              <QuestionBlock key={q.id} q={q} n={qi + 1} withKey={withKey} />
            ))}
          </ol>

          {withKey && m.questions.length > 0 && (
            <div className="break-inside-avoid mt-8">
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

      <p className="mt-10 text-xs text-soft-mute">Printed {generatedOn}</p>
    </div>
  );
}

function QuestionBlock({ q, n, withKey }: { q: PrintQuestion; n: number; withKey: boolean }) {
  const choices = Array.isArray(q.choices) ? q.choices : [];
  const keys = answerCandidates(q.correct_answer);
  const isMC = q.question_type === "Multiple Choice";
  return (
    <li className="break-inside-avoid flex gap-3">
      <span className="shrink-0 w-7 h-7 rounded-md bg-charcoal text-white text-sm font-bold flex items-center justify-center">
        {n}
      </span>
      <div className="flex-1 min-w-0 space-y-3">
        <MathMarkdown className="prose prose-sm max-w-none text-charcoal leading-relaxed [&_p]:my-1.5">
          {q.question_text}
        </MathMarkdown>

        {q.image_urls && q.image_urls.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {q.image_urls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={url} src={imgSrc(url)} alt={`Figure ${i + 1}`} className="max-w-full max-h-80" />
            ))}
          </div>
        )}

        {isMC ? (
          <ul className="space-y-1.5">
            {choices.map((c) => {
              const correct = withKey && keys.some((k) => k.toUpperCase() === c.label.toUpperCase());
              return (
                <li key={c.label} className={`flex items-start gap-2.5 ${correct ? "font-semibold" : ""}`}>
                  <span
                    className={`shrink-0 w-6 h-6 rounded-full border-2 text-xs font-bold flex items-center justify-center ${
                      correct ? "bg-charcoal border-charcoal text-white" : "border-charcoal/50"
                    }`}
                  >
                    {c.label}
                  </span>
                  <div className="flex-1 min-w-0 pt-0.5">
                    {c.text && (
                      <MathMarkdown className="prose prose-sm max-w-none text-inherit [&_p]:my-0">{c.text}</MathMarkdown>
                    )}
                    {c.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imgSrc(c.image_url)} alt={`Choice ${c.label}`} className="max-w-full max-h-56 mt-1" />
                    )}
                  </div>
                  {correct && <span className="shrink-0 text-xs font-bold pt-1">✓ Correct</span>}
                </li>
              );
            })}
          </ul>
        ) : withKey ? (
          <p className="text-sm">
            <span className="font-semibold">Answer:</span> {keys.join(" or ") || "—"}
          </p>
        ) : (
          <p className="text-sm pt-2">Answer: ________________</p>
        )}
      </div>
    </li>
  );
}
