import { Suspense } from "react";
import QuestionBankTable from "@/components/questions/QuestionBankTable";
import PageIntro from "@/components/shared/PageIntro";

export default function QuestionsPage() {
  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <PageIntro tKey="admin.questions" />
      <h1 className="text-2xl font-bold text-charcoal">Question Bank</h1>
      <Suspense fallback={<div className="text-soft-mute text-sm">Loading...</div>}>
        <QuestionBankTable />
      </Suspense>
    </div>
  );
}
