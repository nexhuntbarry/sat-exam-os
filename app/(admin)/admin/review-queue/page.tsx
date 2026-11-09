import Link from "next/link";
import { redirect } from "next/navigation";
import { requireQuestionReviewer } from "@/lib/rbac";
import { forbidQa } from "@/lib/qa";
import { parseBlobUrl } from "@/lib/blob-url";
import { getServiceClient } from "@/lib/supabase";
import { keyIsOfficial, type AutoFixRow } from "@/lib/explanation-autofix";
import {
  autoFixedGroup,
  figureProposalUrl,
  GROUP_BY_ID,
  groupRow,
  parseKeyDispute,
  REVIEW_GROUPS,
  type ReviewGroupId,
} from "@/lib/review-queue";
import { currentStored, loadProposal, proposalIsCurrent, type FigureProposal } from "@/lib/figure-compare";
import { DECIDE_SELECT } from "@/lib/review-decide";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { keySource, moduleKeyFacts, officialKeyProblem, type ModuleKeyFacts } from "@/lib/key-source";
import { groupHeadline, keyCard, plainReason } from "@/lib/review-evidence";
import { realStudentsAnswered } from "@/lib/review-auto";
import { liveQuestionIds, LIVE_FIX_TAG } from "@/lib/live-questions";
import { changedFields, liveFixWhat, loadLiveFixSnapshots, snapshotValid } from "@/lib/live-fix";
import { spotCheckStats, spotCheckLine } from "@/lib/spot-check";
import ReviewQueueClient from "./ReviewQueueClient";
import type { GroupSummary, QueueItem, QueueProposal } from "./types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = AutoFixRow & { page_number: number | null; source_pdf_url: string | null; reviewed_by: string | null; reviewed_at: string | null };

async function loadRows(): Promise<{ waiting: Row[]; autoFixed: Map<ReviewGroupId, number>; modules: Map<string, { name: string; pdf: boolean }>; keyFacts: Map<string, ModuleKeyFacts> }> {
  const db = getServiceClient();
  const waiting: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("questions")
      .select(`${DECIDE_SELECT}, page_number, source_pdf_url, reviewed_by, reviewed_at`)
      .eq("parsing_status", "Needs Review")
      .order("module_id")
      .order("original_question_number")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    waiting.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) break;
  }
  // Approved questions changed in a live test: their own group, at the top.
  {
    const { data, error } = await fetchAllRows<Row>((from, to) =>
      db
        .from("questions")
        .select(`${DECIDE_SELECT}, page_number, source_pdf_url, reviewed_by, reviewed_at`)
        .eq("parsing_status", "Approved")
        .ilike("parsing_notes", `${LIVE_FIX_TAG}%`)
        .order("module_id")
        .order("original_question_number")
        .order("id")
        .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>,
    );
    if (error) throw new Error(`live-fix questions: ${JSON.stringify(error)}`);
    waiting.push(...data);
  }
  const autoFixed = new Map<ReviewGroupId, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("questions")
      .select("id, parsing_status, parsing_notes")
      .eq("parsing_status", "Approved")
      .or("parsing_notes.ilike.%Explanation auto-fixed%,parsing_notes.ilike.%Figure check: matches%,parsing_notes.ilike.%System-approved%,parsing_notes.ilike.%applied by the system%,parsing_notes.ilike.%applied by auto-key%")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const g = autoFixedGroup(r as { parsing_status: string; parsing_notes: string });
      if (g) autoFixed.set(g, (autoFixed.get(g) ?? 0) + 1);
    }
    if (!data || data.length < 1000) break;
  }
  const { data: mods } = await db.from("modules").select("id, module_name, pdf_url");
  const used = new Set(waiting.map((r) => r.module_id));
  const modules = new Map(
    await Promise.all(
      (mods ?? []).map(async (m) => [
        m.id as string,
        { name: (m.module_name as string) ?? "Unknown module", pdf: used.has(m.id as string) ? await pdfReachable(m.pdf_url as string | null) : !!m.pdf_url },
      ] as const),
    ),
  );
  // The extracted-key facts of each module in the queue (lib/key-source): an
  // "official" key the AI made up isn't offered as the official answer.
  const keyRows: Array<{ module_id: string; original_question_number: number | null; question_type: string | null; official_answer: string | null; parsing_notes: string | null }> = [];
  const usedIds = [...used].filter(Boolean) as string[];
  for (let i = 0; i < usedIds.length; i += 50) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("questions")
        .select("id, module_id, original_question_number, question_type, official_answer, parsing_notes")
        .in("module_id", usedIds.slice(i, i + 50))
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      keyRows.push(...((data ?? []) as typeof keyRows));
      if (!data || data.length < 1000) break;
    }
  }
  const keyFacts = new Map(usedIds.map((id) => [id, moduleKeyFacts(keyRows.filter((r) => r.module_id === id))] as const));
  return { waiting, autoFixed, modules, keyFacts };
}

/** The module PDF can be fetched (some old uploads 404), so its page can be shown. */
async function pdfReachable(url: string | null): Promise<boolean> {
  const parsed = parseBlobUrl(url);
  if (!parsed) return false;
  const tokens = [process.env.BLOB_READ_WRITE_TOKEN, process.env.PUBLIC_BLOB_READ_WRITE_TOKEN].filter((t): t is string => !!t);
  for (const token of tokens.length ? tokens : [undefined]) {
    try {
      const res = await fetch(parsed.href, {
        method: "HEAD",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
    } catch {
      // try the next token
    }
  }
  return false;
}

export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const { group } = await searchParams;
  // Same permission as the decide / preview APIs this page calls.
  const auth = await requireQuestionReviewer();
  if (auth instanceof Response) redirect("/sign-in");
  const { waiting, autoFixed, modules, keyFacts } = await loadRows();
  const db = getServiceClient();
  const ids = waiting.map((r) => r.id);
  // A failed lookup is shown on the page, never silently treated as "none".
  const lookupErrors: string[] = [];
  const [students, live, snapshots, spot] = await Promise.all([
    realStudentsAnswered(db, ids).catch(() => {
      lookupErrors.push("which students answered each question");
      return new Map<string, number>();
    }),
    liveQuestionIds(db, ids).catch(() => {
      lookupErrors.push("which questions are in a live test");
      return new Set<string>();
    }),
    loadLiveFixSnapshots(db, waiting.filter((r) => (r.parsing_notes ?? "").startsWith(LIVE_FIX_TAG)).map((r) => r.id)).catch(() => {
      lookupErrors.push("the earlier versions of live-test changes (Undo is off)");
      return new Map();
    }),
    spotCheckStats(db),
  ]);
  if (spot.error) lookupErrors.push("the spot-check results (automatic decisions are paused)");
  const reviewerIds = [...new Set(waiting.map((r) => r.reviewed_by).filter((x): x is string => !!x))];
  const reviewerName = new Map<string, string>();
  if (reviewerIds.length) {
    const { data } = await db.from("users").select("id, display_name, email").in("id", reviewerIds);
    for (const u of data ?? []) reviewerName.set(u.id as string, ((u.display_name as string | null) || (u.email as string | null) || "a reviewer") as string);
  }

  const groupings = new Map(
    waiting.map((r) => {
      const g = groupRow(r);
      // An Approved live-test change always sits in the live-fix group.
      if (r.parsing_status === "Approved") return [r.id, { ...g, primary: "live_fix" as ReviewGroupId, groups: ["live_fix" as ReviewGroupId, ...g.groups.filter((x) => x !== "live_fix")] }];
      return [r.id, g];
    }),
  );
  // Figure-check proposals (Vercel Blob), at most 6 loads at a time.
  const proposals = new Map<string, FigureProposal | null>();
  const withProposal = waiting
    .map((r) => ({ r, url: groupings.get(r.id)!.primary === "figure" ? figureProposalUrl(r.parsing_notes) : null }))
    .filter((x): x is { r: Row; url: string } => !!x.url);
  for (let i = 0; i < withProposal.length; i += 6) {
    await Promise.all(withProposal.slice(i, i + 6).map(async ({ r, url }) => proposals.set(r.id, await loadProposal(url).catch(() => null))));
  }

  const items: QueueItem[] = waiting.map((r) => {
    const g = groupings.get(r.id)!;
    // A stored "official" value that isn't from the PDF is not shown as official.
    const officialProblem = officialKeyProblem(r, keyFacts.get(r.module_id ?? "") ?? null);
    const official = officialProblem ? null : r.official_answer;
    const dispute = parseKeyDispute(r.parsing_notes, r.correct_answer, official);
    const p = proposals.get(r.id) ?? null;
    // "Stored" shows the row as it is now, not as it was when compared.
    const proposal: QueueProposal | null =
      p && p.questionId === r.id
        ? {
            parts: p.parts,
            diffs: p.diffs,
            pages: p.pages,
            stored: currentStored(r, p.parts),
            pdf: { choices: p.pdf.choices, table: p.pdf.table, imageUrls: p.pdf.imageUrls },
            checkMarkLeak: !!p.checkMarkLeak,
            stale: !proposalIsCurrent(p, r),
          }
        : null;
    const mod = modules.get(r.module_id ?? "");
    const isKey = GROUP_BY_ID[g.primary].decision === "key";
    const card = keyCard(r, official);
    const src = keySource({ ...r, reviewer_name: r.reviewed_by ? reviewerName.get(r.reviewed_by) ?? null : null }, keyFacts.get(r.module_id ?? "") ?? null);
    const rawSnap = snapshots.get(r.id) ?? null;
    // Only the version recorded for the row's current live-fix change.
    const snap = snapshotValid(rawSnap, r.parsing_notes) ? rawSnap : null;
    const liveFix =
      (r.parsing_notes ?? "").startsWith(LIVE_FIX_TAG)
        ? {
            what: liveFixWhat(r.parsing_notes) ?? "Changed while in a live test.",
            changes: changedFields(snap, r as unknown as Record<string, unknown>).map((f) => ({ field: f, before: snap!.fields[f], after: (r as unknown as Record<string, unknown>)[f] })),
            canUndo: !!snap && changedFields(snap, r as unknown as Record<string, unknown>).length > 0,
            keyBefore: snap && changedFields(snap, r as unknown as Record<string, unknown>).includes("correct_answer") ? ((snap.fields.correct_answer as string | null) ?? null) : null,
            snapshotAt: snap?.at ?? null,
          }
        : null;
    return {
      id: r.id,
      headline: isKey ? card.headline : g.primary === "live_fix" && liveFix ? liveFix.what : groupHeadline(g.primary, g.reasons),
      evidence: isKey ? card.evidence : [],
      suggestion: isKey ? card.suggestion : null,
      plainReasons: [...new Set(g.reasons.map((x) => plainReason(x.text)))],
      studentsAnswered: students.get(r.id) ?? 0,
      live: live.has(r.id),
      keySource: { label: src.label, detail: src.detail, kind: src.kind },
      liveFix,
      status: r.parsing_status ?? "Needs Review",
      number: r.original_question_number,
      moduleId: r.module_id ?? null,
      moduleName: mod?.name ?? "Unknown module",
      section: r.section ?? null,
      questionType: r.question_type,
      key: r.correct_answer,
      official,
      keyOverrulesOfficial: !!official && !keyIsOfficial(r),
      alternative: dispute?.alternative
        ? {
            answer: dispute.alternative,
            source: officialProblem && dispute.source === "official key" ? "AI-read key (not from the PDF)" : dispute.source,
            ref: dispute.ref ?? null,
          }
        : null,
      primary: g.primary,
      also: g.groups.filter((x) => x !== g.primary),
      reasons: g.reasons.map((x) => (x.text.length > 220 ? `${x.text.slice(0, 220)}…` : x.text)),
      stem: (r.question_text ?? "").slice(0, 1500),
      choices: (Array.isArray(r.choices) ? (r.choices as { label?: string; text?: string; image_url?: string | null }[]) : []).map((c) => ({
        label: c?.label ?? "?",
        text: c?.text ?? "",
        image_url: c?.image_url ?? null,
      })),
      pageNumber: r.page_number,
      hasPdf: !!mod?.pdf,
      updatedAt: r.updated_at ?? null,
      proposal,
    };
  });

  // Live tests and questions students answered first, most students first.
  items.sort((a, b) => Number(b.live) - Number(a.live) || b.studentsAnswered - a.studentsAnswered);

  const summary: GroupSummary[] = REVIEW_GROUPS.map((grp) => {
    const inGroup = items.filter((i) => i.primary === grp.id);
    const also = new Map<string, number>();
    for (const i of inGroup) for (const a of i.also) also.set(GROUP_BY_ID[a].label, (also.get(GROUP_BY_ID[a].label) ?? 0) + 1);
    return {
      id: grp.id,
      label: grp.label,
      ask: grp.ask,
      decision: grp.decision,
      waiting: inGroup.length,
      autoFixed: autoFixed.get(grp.id) ?? 0,
      alsoBlocked: [...also.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    };
  });

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
      {lookupErrors.length > 0 && (
        <p role="alert" className="rounded-lg border border-status-error/30 bg-status-error/10 px-3 py-2 text-sm text-status-error">
          Couldn&rsquo;t load {lookupErrors.join(", ")}. Student counts and &ldquo;In a live test&rdquo; labels may be missing below — reload before
          changing a key.
        </p>
      )}
      <ReviewQueueClient
        summary={summary}
        items={items}
        canWrite={forbidQa(auth) === null}
        initialGroup={group ?? null}
        spotCheck={{ line: spotCheckLine(spot), paused: spot.paused, system: spot.system, person: spot.person }}
      />
    </div>
  );
}
