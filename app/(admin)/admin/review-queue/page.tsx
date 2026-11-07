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
import ReviewQueueClient from "./ReviewQueueClient";
import type { GroupSummary, QueueItem, QueueProposal } from "./types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = AutoFixRow & { page_number: number | null; source_pdf_url: string | null };

async function loadRows(): Promise<{ waiting: Row[]; autoFixed: Map<ReviewGroupId, number>; modules: Map<string, { name: string; pdf: boolean }> }> {
  const db = getServiceClient();
  const waiting: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("questions")
      .select(`${DECIDE_SELECT}, page_number, source_pdf_url`)
      .eq("parsing_status", "Needs Review")
      .order("module_id")
      .order("original_question_number")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    waiting.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) break;
  }
  const autoFixed = new Map<ReviewGroupId, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("questions")
      .select("id, parsing_status, parsing_notes")
      .eq("parsing_status", "Approved")
      .or("parsing_notes.ilike.%Explanation auto-fixed%,parsing_notes.ilike.%Figure check: matches%")
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
  return { waiting, autoFixed, modules };
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
  const { waiting, autoFixed, modules } = await loadRows();

  const groupings = new Map(waiting.map((r) => [r.id, groupRow(r)]));
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
    const dispute = parseKeyDispute(r.parsing_notes, r.correct_answer, r.official_answer);
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
    return {
      id: r.id,
      number: r.original_question_number,
      moduleId: r.module_id ?? null,
      moduleName: mod?.name ?? "Unknown module",
      section: r.section ?? null,
      questionType: r.question_type,
      key: r.correct_answer,
      official: r.official_answer,
      keyOverrulesOfficial: !!r.official_answer && !keyIsOfficial(r),
      alternative: dispute?.alternative ? { answer: dispute.alternative, source: dispute.source, ref: dispute.ref ?? null } : null,
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
        Every Needs Review question, grouped by the one thing a person still has to decide. Pick a group, then decide
        each question. After a decision the explanation is rewritten when needed, the settled notes are cleared and the
        question is approved when nothing else blocks it; otherwise it moves to its next group. A key change first shows
        which graded answers would be rescored. Questions in a live test are never demoted.
      </p>
      <ReviewQueueClient summary={summary} items={items} canWrite={forbidQa(auth) === null} initialGroup={group ?? null} />
    </div>
  );
}
