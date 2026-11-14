import Link from "next/link";
import { Presentation } from "lucide-react";
import { classReviewHref } from "@/lib/assigned-tests-view";

// "Questions & answers (Class Review)": the teacher's projector walkthrough
// of a test (app/(teacher)/teacher/tests/[id]/review). No hooks, so server
// and client pages can both use it; pass the label in the viewer's language
// (messages teacher.classReview.button). disabledReason (the admin turned
// off "Teachers can view & print questions/answers", messages
// teacherQa.off) greys it out with the reason as tooltip and helper text.
export default function ClassReviewButton({
  testId,
  label,
  disabledReason,
}: {
  testId: string;
  label: string;
  disabledReason?: string | null;
}) {
  if (disabledReason) {
    return (
      <span className="inline-flex flex-col gap-1" title={disabledReason}>
        <button
          type="button"
          disabled
          aria-disabled
          data-teacher-qa-disabled
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-light-bg text-soft-mute text-sm font-semibold cursor-not-allowed"
        >
          <Presentation size={15} aria-hidden />
          {label}
        </button>
        <span className="text-soft-mute text-[11px] max-w-[16rem]">{disabledReason}</span>
      </span>
    );
  }
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
