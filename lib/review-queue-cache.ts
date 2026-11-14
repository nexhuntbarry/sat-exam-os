// lib/review-queue-cache.ts
//
// Invalidation of the stored review-queue index (app/(admin)/admin/review-queue/data.ts).
// Routes that can change a question, its key, a review decision or which
// tests are live are wrapped in withQueueInvalidation (or call
// invalidateReviewQueue() themselves, e.g. inside an after() callback).
//
// The tag only expires a tiny "queue changed at" stamp (recomputing it costs
// nothing). The index itself is not tagged: a reader that sees an index
// older than the stamp still gets it at once and the index is rebuilt in the
// background (data.ts). The page builds its cards from fresh rows and drops
// rows that left the group, so a stale index can show wrong COUNTS for a
// moment but never a decided question as waiting. Writers outside a Next
// request (scripts, SQL) are covered by the index's 60 s age limit only.

import { revalidateTag } from "next/cache";
import { REVIEW_QUEUE_TAG } from "@/lib/review-queue-view";

export function invalidateReviewQueue(): void {
  try {
    // expire 0: the next read of the stamp recomputes it (a few ms), never a stale stamp.
    revalidateTag(REVIEW_QUEUE_TAG, { expire: 0 });
  } catch {
    // Outside a Next request (scripts, unit tests): nothing to revalidate here.
  }
}

/**
 * Wrap a route handler that may change questions or live tests. The index is
 * marked changed after every call, whatever the status and even when the
 * handler throws (a handler can write and then fail a later step: a 409 / 500
 * after a partial write), except a refused call (401 / 403): those are
 * answered before any write, and the cron routes are public URLs that anyone
 * can hit with a wrong secret.
 */
export function withQueueInvalidation<A extends unknown[], R extends Response>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    let res: R | undefined;
    try {
      res = await handler(...args);
      return res;
    } finally {
      if (res?.status !== 401 && res?.status !== 403) invalidateReviewQueue();
    }
  };
}
