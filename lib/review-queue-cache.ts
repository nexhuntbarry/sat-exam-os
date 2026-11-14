// lib/review-queue-cache.ts
//
// Invalidation of the cached review-queue index (app/(admin)/admin/review-queue/data.ts).
// Routes that can change a question, its key, a review decision or which
// tests are live are wrapped in withQueueInvalidation (or call
// invalidateReviewQueue() themselves, e.g. inside an after() callback).
// "max" = stale-while-revalidate: the next queue request still gets the old
// index at once and a new one is built in the background. The page builds
// its cards from fresh rows and drops rows that left the group, so a stale
// index can show wrong COUNTS for a moment but never a decided question as
// waiting. Writers outside a Next request (scripts, SQL) are covered by the
// index's 60 s revalidate only.

import { revalidateTag } from "next/cache";
import { REVIEW_QUEUE_TAG } from "@/lib/review-queue-view";

export function invalidateReviewQueue(): void {
  try {
    revalidateTag(REVIEW_QUEUE_TAG, "max");
  } catch {
    // Outside a Next request (scripts, unit tests): nothing to revalidate here.
  }
}

/**
 * Wrap a route handler that may change questions or live tests. The index is
 * revalidated after EVERY call, whatever the status and even when the
 * handler throws: a handler can write and then fail a later step (a 409 / 500
 * after a partial write), and an extra background rebuild is cheap.
 */
export function withQueueInvalidation<A extends unknown[], R extends Response>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } finally {
      invalidateReviewQueue();
    }
  };
}
