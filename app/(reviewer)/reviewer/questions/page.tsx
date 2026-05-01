import { Suspense } from "react";
import QuestionBankTable from "@/components/questions/QuestionBankTable";

export default function ReviewerQuestionsPage() {
  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="rounded-xl border border-warm-coral/15 bg-warm-coral-soft/40 px-4 py-3">
        <p className="text-xs font-semibold text-warm-coral-dark uppercase tracking-wider mb-1">
          Question Review
        </p>
        <p className="text-sm text-mid-gray leading-relaxed">
          Review the AI-parsed question bank. Approve, reject, or resolve mismatches against the
          official answer key. Changes here are visible to every student who takes a test using
          these questions.
        </p>
      </div>
      <h1 className="text-2xl font-bold text-charcoal">Question Bank</h1>
      <Suspense fallback={<div className="text-soft-mute text-sm">Loading...</div>}>
        <QuestionBankTable />
      </Suspense>
    </div>
  );
}
