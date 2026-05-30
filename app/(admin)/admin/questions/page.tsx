import { Suspense } from "react";
import QuestionBankTable from "@/components/questions/QuestionBankTable";
import PageIntro from "@/components/shared/PageIntro";
import StatusPills from "./StatusPills";

export default function QuestionsPage() {
  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <PageIntro tKey="admin.questions" />
      <h1 className="text-2xl font-bold text-charcoal">Question Bank</h1>
      {/* Quick jump pills for the review queue. Each links to the
          table below pre-filtered to a parsing_status bucket so the
          admin can triage Draft / Needs Review without scrolling
          into the sidebar filter every time. */}
      <Suspense fallback={null}>
        <StatusPills />
      </Suspense>
      <Suspense fallback={<div className="text-soft-mute text-sm">Loading...</div>}>
        <QuestionBankTable />
      </Suspense>
    </div>
  );
}
