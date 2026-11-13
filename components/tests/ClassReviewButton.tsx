import Link from "next/link";
import { Presentation } from "lucide-react";
import { classReviewHref } from "@/lib/assigned-tests-view";

// "Questions & answers (Class Review)": the teacher's projector walkthrough
// of a test (app/(teacher)/teacher/tests/[id]/review). No hooks, so server
// and client pages can both use it; pass the label in the viewer's language
// (messages teacher.classReview.button).
export default function ClassReviewButton({ testId, label }: { testId: string; label: string }) {
  return (
    <Link
      href={classReviewHref(testId)}
      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-warm-coral text-white text-sm font-semibold hover:bg-warm-coral-dark transition-colors"
    >
      <Presentation size={15} aria-hidden />
      {label}
    </Link>
  );
}
