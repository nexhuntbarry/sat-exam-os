import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { forbidQa } from "@/lib/qa";
import { parseFilters, parseLimit } from "@/lib/review-queue-view";
import { loadQueuePage } from "@/app/(admin)/admin/review-queue/data";

export const dynamic = "force-dynamic";
// A cold index build (first request after a deploy) reads the whole queue.
export const maxDuration = 60;

// GET /api/admin/review-queue?group=&cursor=&limit=15&module=&test=&subject=&live=1
// GET /api/admin/review-queue?id=<question id>        (one card, any group)
//
// The review queue page's data: counts per group (under the filters) and one
// page of cards of the group. Same permission as the page and the decide /
// preview APIs. The question bank is shared, so QA reviewers see the same
// queue; they can't change it (canWrite false, and decide refuses them).
export async function GET(req: Request) {
  const auth = await requireQuestionReviewer();
  if (auth instanceof NextResponse) return auth;
  const p = new URL(req.url).searchParams;
  const id = p.get("id");
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  try {
    const data = await loadQueuePage({
      group: p.get("group"),
      filters: parseFilters(p),
      cursor: p.get("cursor"),
      limit: parseLimit(p.get("limit")),
      id,
    });
    return NextResponse.json({ ...data, canWrite: forbidQa(auth) === null }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("[review-queue] load failed:", e);
    return NextResponse.json({ error: "Couldn't load the review queue. Try again." }, { status: 500 });
  }
}
