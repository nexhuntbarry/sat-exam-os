import Link from "next/link";
import { redirect } from "next/navigation";
import { requireQuestionReviewer } from "@/lib/rbac";
import { forbidQa } from "@/lib/qa";
import { DEFAULT_LIMIT, parseFilters } from "@/lib/review-queue-view";
import { loadQueuePage } from "./data";
import ReviewQueueClient from "./ReviewQueueClient";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The grouping of the whole queue is cached (./data.ts); this renders the
// counts and the first page of cards only. Group switches, filters and the
// next pages come from GET /api/admin/review-queue without a page reload.
export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  // Same permission as the decide / preview APIs this page calls.
  const auth = await requireQuestionReviewer();
  if (auth instanceof Response) redirect("/sign-in");
  const filters = parseFilters(sp);
  const group = typeof sp.group === "string" ? sp.group : null;
  const data = await loadQueuePage({ group, filters, cursor: null, limit: DEFAULT_LIMIT });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-soft-mute">
        <Link href="/admin/questions" className="hover:text-charcoal">Question Bank</Link>
        <span>/</span>
        <span className="text-charcoal">Review queue</span>
      </div>
      <h1 className="text-2xl font-bold text-charcoal">Review queue</h1>
      <p className="max-w-3xl text-sm text-mid-gray">
        The system settles what it can on its own: questions that pass every check are approved, and in modules with no
        answer key a key is set when the code solve and a second independent solve agree (unless students already
        answered it). What is left needs one decision each. A key change first shows whose answers would be rescored.
        Questions in a live test are never pulled; changes to them are listed first for a Confirm or Undo.
      </p>
      {data.lookupErrors.length > 0 && (
        <p role="alert" className="rounded-lg border border-status-error/30 bg-status-error/10 px-3 py-2 text-sm text-status-error">
          Couldn&rsquo;t load {data.lookupErrors.join(", ")}. Student counts and &ldquo;In a live test&rdquo; labels may be missing below — reload before
          changing a key.
        </p>
      )}
      <ReviewQueueClient initial={data} filters={filters} canWrite={forbidQa(auth) === null} />
    </div>
  );
}
