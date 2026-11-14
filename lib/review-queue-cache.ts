// lib/review-queue-cache.ts
//
// Invalidation of the cached review-queue index (app/(admin)/admin/review-queue/data.ts).
// Every route that changes a question, its key or a review decision calls
// invalidateReviewQueue() after the write. "max" = stale-while-revalidate:
// the next queue request still gets the old index at once and the new one
// is built in the background (the page drops rows that changed meanwhile,
// so a stale index never shows a decided question as waiting).

import { revalidateTag } from "next/cache";
import { REVIEW_QUEUE_TAG } from "@/lib/review-queue-view";

export function invalidateReviewQueue(): void {
  try {
    revalidateTag(REVIEW_QUEUE_TAG, "max");
  } catch {
    // Outside a Next request (scripts, unit tests): nothing is cached there;
    // the index's 60 s revalidate covers writers that can't reach this.
  }
}

/**
 * Wrap a route handler that changes questions: after a successful response
 * (status < 400, i.e. after the write) the queue index is revalidated.
 */
export function withQueueInvalidation<A extends unknown[], R extends Response>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const res = await handler(...args);
    if (res.status < 400) invalidateReviewQueue();
    return res;
  };
}
