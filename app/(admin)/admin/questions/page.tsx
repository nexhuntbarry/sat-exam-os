import { Suspense } from "react";
import Link from "next/link";
import QuestionBankTable from "@/components/questions/QuestionBankTable";
import PageIntro from "@/components/shared/PageIntro";
import StatusPills from "./StatusPills";

export default function QuestionsPage() {
  return (
    <div className="space-y-4">
      <PageIntro tKey="admin.questions" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-charcoal">Question Bank</h1>
        <div className="flex flex-wrap gap-2">
        <Link
          href="/admin/review-queue"
          className="rounded-lg border border-divider bg-surface px-3 py-1.5 text-sm font-medium text-charcoal hover:bg-light-bg"
        >
          Review queue
        </Link>
        <Link
          href="/admin/questions/key-check"
          className="rounded-lg border border-divider bg-surface px-3 py-1.5 text-sm font-medium text-charcoal hover:bg-light-bg"
        >
          Answer key check
        </Link>
        </div>
      </div>
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
