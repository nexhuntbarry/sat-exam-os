"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { FileSearch, X } from "lucide-react";
import MathMarkdown from "@/components/MathMarkdown";
import { answersAgreeForQuestion, keyTypeProblem } from "@/lib/answer-key";

type Label = "A" | "B" | "C" | "D";
type QType = "Multiple Choice" | "Student Produced Response";

export interface ReextractProposal {
  /** Older responses may not carry it. */
  question_type?: QType;
  question_text: string;
  choices: { label: Label; text: string; image_url?: string | null }[];
  marked_answer: string | null;
  model: string;
  pages: string;
  warnings: string[];
}

interface Current {
  question_text: string;
  choices: { label: Label; text: string; image_url?: string | null }[];
  correct_answer: string | null;
  question_type?: QType | null;
}

export interface ReextractPatch {
  question_text?: string;
  /** Choice label → new text (graph choices are never in here). */
  choices?: Partial<Record<Label, string>>;
  correct_answer?: string;
  /** Switch the question type to what the PDF shows. */
  question_type?: QType;
}

const typeLabel = (t: QType | null | undefined) =>
  t === "Student Produced Response" ? "Fill-in (SPR)" : t === "Multiple Choice" ? "Multiple choice" : "not set";

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

/**
 * "Re-extract from PDF" result on the review page: the stored copy next to
 * what the PDF says, field by field. Ticked fields go into the editor; the
 * reviewer still saves. The answer is never pre-ticked: saving a new answer
 * rescores everyone who answered the question.
 */
export default function ReextractPanel({
  current,
  proposal,
  onApply,
  onClose,
}: {
  current: Current;
  proposal: ReextractProposal;
  onApply: (patch: ReextractPatch) => void;
  onClose: () => void;
}) {
  type Row = { key: string; label: string; now: string; pdf: string; imageChoice?: boolean };
  const rows: Row[] = [{ key: "question_text", label: "Question text", now: current.question_text, pdf: proposal.question_text }];
  for (const c of proposal.choices) {
    const now = current.choices.find((x) => x.label === c.label);
    rows.push({
      key: `choice:${c.label}`,
      label: `Choice ${c.label}`,
      now: now?.text ?? "",
      pdf: c.text,
      imageChoice: !!(c.image_url || now?.image_url),
    });
  }
  const differs = rows.filter((r) => !r.imageChoice && !same(r.now, r.pdf));
  // Answers compare as values (7/2 = 3.5, rounding as the stem asks), not text.
  const answerDiffers =
    !!proposal.marked_answer &&
    !same(proposal.marked_answer, current.correct_answer) &&
    !answersAgreeForQuestion(proposal.marked_answer, current.correct_answer, proposal.question_text);
  const pdfType = proposal.question_type ?? null;
  const typeDiffers = !!pdfType && !!current.question_type && pdfType !== current.question_type;
  // Does the SAVED key fit the type the PDF shows? (e.g. a letter key on a fill-in question)
  const keyProblem = keyTypeProblem({
    question_type: pdfType ?? current.question_type,
    correct_answer: current.correct_answer,
    question_text: current.question_text,
    choices: pdfType === "Student Produced Response" ? [] : current.choices,
  });
  const diffCount = differs.length + (answerDiffers ? 1 : 0) + (typeDiffers ? 1 : 0) + (keyProblem && !answerDiffers ? 1 : 0);

  const [picked, setPicked] = useState<Set<string>>(
    () => new Set([...differs.map((r) => r.key), ...(typeDiffers ? ["type"] : [])]),
  );
  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  function apply() {
    const patch: ReextractPatch = {};
    for (const r of differs) {
      if (!picked.has(r.key)) continue;
      if (r.key === "question_text") patch.question_text = r.pdf;
      else (patch.choices ??= {})[r.key.slice(7) as Label] = r.pdf;
    }
    if (answerDiffers && picked.has("answer")) patch.correct_answer = proposal.marked_answer!;
    if (typeDiffers && picked.has("type") && pdfType) patch.question_type = pdfType;
    onApply(patch);
  }

  const count = [...picked].filter((k) =>
    k === "answer" ? answerDiffers : k === "type" ? typeDiffers : differs.some((r) => r.key === k),
  ).length;

  return (
    <section
      aria-label="Re-extracted from the PDF"
      className="rounded-2xl border border-status-info/30 bg-status-info/[0.04] p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-charcoal">
            <FileSearch size={15} className="text-status-info" />
            Re-extracted from the PDF (page {proposal.pages})
          </h3>
          <p className="mt-0.5 text-xs text-soft-mute">
            {diffCount === 0
              ? "Matches the saved copy. Nothing to change."
              : `${diffCount} difference${diffCount === 1 ? "" : "s"}. Tick what to use, then Apply. Nothing is saved until you click Save.`}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-soft-mute hover:bg-light-bg hover:text-charcoal">
          <X size={16} />
        </button>
      </div>

      {proposal.warnings.length > 0 && (
        <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
          Check carefully: {proposal.warnings.join("; ")}.
        </p>
      )}

      <div className="space-y-2">
        {pdfType && (
          <div className={clsx("rounded-xl border bg-surface p-3", typeDiffers ? "border-status-warning/40" : "border-divider")}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-charcoal">
                Question type in the PDF: {typeLabel(pdfType)}
                <span className="font-normal text-soft-mute"> · saved: {typeLabel(current.question_type)}</span>
              </span>
              {typeDiffers ? (
                <label className="flex items-center gap-1.5 text-xs text-charcoal">
                  <input type="checkbox" checked={picked.has("type")} onChange={() => toggle("type")} />
                  Use {typeLabel(pdfType)}
                </label>
              ) : (
                <span className="text-[11px] text-soft-mute">Same as saved</span>
              )}
            </div>
          </div>
        )}
        {keyProblem && (
          <p role="alert" className="rounded-lg border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
            The saved answer key doesn&rsquo;t fit {pdfType ? "the type the PDF shows" : "the question type"}: {keyProblem.reason}.
          </p>
        )}
        {rows.map((r) => {
          const diff = differs.includes(r);
          return (
            <div key={r.key} className={clsx("rounded-xl border bg-surface p-3", diff ? "border-status-info/30" : "border-divider")}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-charcoal">{r.label}</span>
                {r.imageChoice ? (
                  <span className="text-[11px] text-soft-mute">Graph choice, image kept</span>
                ) : diff ? (
                  <label className="flex items-center gap-1.5 text-xs text-charcoal">
                    <input type="checkbox" checked={picked.has(r.key)} onChange={() => toggle(r.key)} />
                    Use the PDF version
                  </label>
                ) : (
                  <span className="text-[11px] text-soft-mute">Same as saved</span>
                )}
              </div>
              {diff && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-soft-mute">Saved now</p>
                    {r.now.trim() ? (
                      <MathMarkdown className="prose prose-sm max-w-none text-mid-gray [&_p]:my-0.5">{r.now}</MathMarkdown>
                    ) : (
                      <span className="text-sm italic text-soft-mute">Empty</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-status-info">From the PDF</p>
                    <MathMarkdown className="prose prose-sm max-w-none text-charcoal [&_p]:my-0.5">{r.pdf}</MathMarkdown>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {proposal.marked_answer && (
          <div className={clsx("rounded-xl border bg-surface p-3", answerDiffers ? "border-status-warning/40" : "border-divider")}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-charcoal">
                Answer marked in the PDF: {proposal.marked_answer}
                <span className="font-normal text-soft-mute"> · saved: {current.correct_answer ?? "none"}</span>
              </span>
              {answerDiffers ? (
                <label className="flex items-center gap-1.5 text-xs text-charcoal">
                  <input type="checkbox" checked={picked.has("answer")} onChange={() => toggle("answer")} />
                  Use {proposal.marked_answer}
                </label>
              ) : (
                <span className="text-[11px] text-soft-mute">Same as saved</span>
              )}
            </div>
            {answerDiffers && (
              <p className="mt-1 text-[11px] text-status-warning">
                Saving a new answer rescores every student who answered this question.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-charcoal hover:bg-light-bg">
          Close
        </button>
        {(differs.length > 0 || answerDiffers || typeDiffers) && (
          <button
            type="button"
            onClick={apply}
            disabled={count === 0}
            className="rounded-lg bg-status-info px-3 py-1.5 text-sm font-semibold text-white hover:bg-status-info/90 disabled:opacity-50"
          >
            Apply {count} to the editor
          </button>
        )}
      </div>
    </section>
  );
}
