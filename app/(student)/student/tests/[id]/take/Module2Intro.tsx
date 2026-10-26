import { CheckCircle, ChevronRight } from "lucide-react";

interface Props {
  testId: string;
  testName: string;
  questionCount: number;
  /** null when the test is untimed. */
  timeLimitMinutes: number | null;
}

// Bluebook-style break between modules. Module 2's clock starts only
// when the student presses Start: the link reloads the take page with
// ?start=1, which stamps metadata.module_2_started_at. A plain link (not
// a client handler) so it works before the page has hydrated.
export default function Module2Intro({ testId, testName, questionCount, timeLimitMinutes }: Props) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-cream p-4">
      <div className="w-full max-w-md rounded-2xl border border-divider bg-surface p-6 sm:p-8 text-center shadow-sm">
        <CheckCircle size={40} className="mx-auto text-warm-coral" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-semibold text-charcoal">Module 1 submitted</h1>
        <p className="mt-1 text-sm text-soft-mute truncate">{testName}</p>
        <p className="mt-5 text-charcoal">
          Module 2 has {questionCount} {questionCount === 1 ? "question" : "questions"}
          {timeLimitMinutes != null
            ? ` and ${timeLimitMinutes} ${timeLimitMinutes === 1 ? "minute" : "minutes"}.`
            : " and no time limit."}
        </p>
        <p className="mt-2 text-sm text-soft-mute">
          {timeLimitMinutes != null
            ? "The timer starts when you press Start Module 2."
            : "Press Start Module 2 when you're ready."}
        </p>
        <a
          href={`/student/tests/${testId}/take?start=1`}
          className="mt-6 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-coral focus-visible:ring-offset-2"
        >
          Start Module 2 <ChevronRight size={16} />
        </a>
      </div>
    </div>
  );
}
