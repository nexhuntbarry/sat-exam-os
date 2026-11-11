import type { Metadata } from "next";
import NoTranslate from "@/components/tests/NoTranslate";

// The test pages (start, exam, break, result) opt out of browser machine
// translation: Chrome's auto-translate rewrites the DOM behind React and
// crashed the exam ("Question 1 failed to render", insertBefore
// NotFoundError). The SAT is taken in English anyway.
export const metadata: Metadata = { other: { google: "notranslate" } };

export default function StudentTestLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <NoTranslate />
      <div translate="no" className="contents">{children}</div>
    </>
  );
}
