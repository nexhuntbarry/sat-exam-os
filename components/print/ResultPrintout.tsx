import MathMarkdown from "@/components/MathMarkdown";
import { Mark, QuestionBlock, imgSrc } from "@/components/tests/PrintableTest";
import { formatDate } from "@/lib/datetime";
import type { PrintOptions, StudentResultPrintout } from "@/lib/result-printout";

// One student's printed result: a one-page summary (score, per-module
// counts, a right/wrong/blank grid), then the questions laid out exactly
// like the blank test print with the student's answer marked inline. Only
// what loadResultPrintouts let through is here (answers/explanations are
// already stripped server-side when the student may not see them).
export default function ResultPrintout({
  p,
  opts,
  first,
  src = imgSrc,
}: {
  p: StudentResultPrintout;
  opts: PrintOptions;
  first: boolean;
  src?: (url: string) => string;
}) {
  const score = p.attempt.score;
  const explanationsAtEnd = p.shows.explanations && opts.explanationsAt === "end";
  const questionsShown = p.modules.reduce((n, m) => n + m.questions.length, 0);
  const byModule = new Map<string | null, StudentResultPrintout["grid"]>();
  for (const g of p.grid) byModule.set(g.module, [...(byModule.get(g.module) ?? []), g]);
  const counts = {
    correct: p.grid.filter((g) => g.outcome === "correct").length,
    wrong: p.grid.filter((g) => g.outcome === "wrong").length,
    blank: p.grid.filter((g) => g.outcome === "blank").length,
  };

  return (
    <section className={`result-student${first ? "" : " break-before-page"}`} data-student={p.studentName}>
      {/* ── Summary page ── */}
      <div className="result-summary">
        <div className="border-b-2 border-charcoal pb-3 mb-5">
          <h1 className="print-student-name text-xl font-bold">{p.studentName}</h1>
          <p className="text-sm text-mid-gray">
            {[p.className, p.testName].filter(Boolean).join(" · ")}
          </p>
          <p className="text-sm text-mid-gray">
            Taken {p.takenAt ? formatDate(p.takenAt) : "—"}
            {p.attemptNumber > 1 ? ` · attempt ${p.attemptNumber}` : ""}
          </p>
        </div>

        <div className="flex items-end gap-8 mb-5">
          <div>
            <div className="text-xs uppercase tracking-wide text-mid-gray">SAT score</div>
            <div className="text-4xl font-bold leading-none">{score?.sat ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-mid-gray">Correct</div>
            <div className="text-xl font-semibold">{score?.modules ?? "—"}</div>
          </div>
          {p.attempt.status !== "Submitted" && p.attempt.status !== "Late" && (
            <div className="text-sm font-semibold">Not finished ({p.attempt.status})</div>
          )}
        </div>
        {score?.notes.map((n) => (
          <p key={n} className="text-xs text-mid-gray -mt-3 mb-4">{n}</p>
        ))}

        {p.shows.answers ? (
          <>
            <p className="text-sm mb-3">
              <span className="font-semibold">Key:</span> <Mark kind="picked" /> = your answer · <Mark kind="correct" /> = correct ·{" "}
              <Mark kind="wrong" /> = wrong · <Mark kind="blank" /> = left blank
              <span className="text-mid-gray"> ({counts.correct} correct · {counts.wrong} wrong · {counts.blank} blank)</span>
            </p>
            {Array.from(byModule).map(([label, cells]) => (
              <div key={label ?? "all"} className="mb-4 break-inside-avoid">
                {label && <div className="text-xs font-semibold uppercase tracking-wide mb-1">{label}</div>}
                <div className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1 text-sm">
                  {cells.map((c) => (
                    <div
                      key={c.n}
                      className={`border border-charcoal/60 rounded px-1 py-0.5 flex justify-between ${c.outcome === "correct" ? "" : "font-bold"}`}
                    >
                      <span>{c.n}</span>
                      {c.outcome && <Mark kind={c.outcome} />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {opts.mode === "short" && (
              <p className="text-sm text-mid-gray">
                {questionsShown === 0 ? "No missed questions." : `The next pages show the ${questionsShown} missed or blank question${questionsShown === 1 ? "" : "s"}.`}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm border border-charcoal p-3">
            Answers for this test haven&apos;t been released to this student, so this printout shows the score only.
          </p>
        )}
      </div>

      {/* ── Questions, as on the blank test ── */}
      {p.modules.filter((m) => m.questions.length > 0).map((m, mi) => (
        // The first module starts after the summary page. A later module
        // continues on the same page unless less than a third of it is
        // left: its heading reserves 1/3 page (kept whole, so it moves to
        // the next page when that doesn't fit) and gives the space back.
        <div key={m.label ?? mi} className={mi === 0 ? "break-before-page" : "mt-6"}>
          {m.label && (
            <div className={mi === 0 ? "" : "print-module-reserve"}>
              <h2 className="print-module-head text-sm font-bold uppercase tracking-wide border-b border-charcoal pb-1 mb-3">{m.label}</h2>
            </div>
          )}
          <ol className="space-y-4">
            {m.questions.map((q) => (
              <QuestionBlock
                key={q.id}
                n={q.n}
                withKey={false}
                src={src}
                q={{
                  id: q.id,
                  original_question_number: q.n,
                  question_text: q.text,
                  choices: q.choices,
                  question_type: q.type,
                  image_urls: q.imageUrls,
                  correct_answer: null,
                }}
                result={{
                  studentAnswer: q.studentAnswer,
                  correctAnswer: q.correctAnswer,
                  outcome: q.outcome,
                  explanation: explanationsAtEnd ? null : q.explanation,
                }}
              />
            ))}
          </ol>
        </div>
      ))}

      {explanationsAtEnd && (
        <div className="break-before-page">
          <h2 className="text-sm font-bold uppercase tracking-wide border-b border-charcoal pb-1 mb-4">Explanations</h2>
          {p.modules.map((m, mi) =>
            m.questions.filter((q) => q.explanation).map((q) => (
              <div key={`${mi}-${q.id}`} className="mb-3 text-xs break-inside-avoid">
                <span className="font-semibold">{m.label ? `${m.label} · ` : ""}Q{q.n}. </span>
                <MathMarkdown className="prose prose-sm max-w-none text-inherit text-xs [&_p]:my-0.5">{q.explanation ?? ""}</MathMarkdown>
              </div>
            )),
          )}
        </div>
      )}
    </section>
  );
}
