import { Suspense } from "react";
import QuestionBankTable from "@/components/questions/QuestionBankTable";

export default function QuestionsPage() {
  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold text-white">Question Bank</h1>
      <Suspense fallback={<div className="text-soft-gray/40 text-sm">Loading...</div>}>
        <QuestionBankTable />
      </Suspense>
    </div>
  );
}
