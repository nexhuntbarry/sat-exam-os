// Server data of the review queue page and GET /api/admin/review-queue
// (Premier ticket 695b0797: open and switch groups in under a second).
//
// 1. The INDEX: every waiting question's group, live / students counts and
//    filter fields, plus the per-group counts. Building it reads every Needs
//    Review row and runs the grouping rules (3-6 s on Vercel), so it is
//    stored and served stale-while-revalidate by getQueueIndex() below: no
//    open waits for a build unless no index was ever stored (a new
//    REVIEW_QUEUE_INDEX_VERSION).
// 2. The CARDS: one page of the index (15 by default) built from fresh rows,
//    so a decision made since the index was built is never shown as waiting:
//    a row that left Needs Review or moved to another group is dropped.

import { unstable_cache } from "next/cache";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseBlobUrl } from "@/lib/blob-url";
import { getServiceClient } from "@/lib/supabase";
import { keyIsOfficial, type AutoFixRow } from "@/lib/explanation-autofix";
import { autoFixedGroup, figureProposalUrl, GROUP_BY_ID, groupRow, parseKeyDispute, REVIEW_GROUPS, type ReviewGroupId, type RowGrouping } from "@/lib/review-queue";
import { currentStored, loadProposal, proposalIsCurrent, type FigureProposal } from "@/lib/figure-compare";
import { DECIDE_SELECT } from "@/lib/review-decide";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { keySource, moduleKeyFacts, officialKeyProblem, type ModuleKeyFacts } from "@/lib/key-source";
import { groupHeadline, keyCard, plainReason } from "@/lib/review-evidence";
import { realStudentsAnswered } from "@/lib/review-auto";
import { liveQuestionIds, LIVE_FIX_TAG } from "@/lib/live-questions";
import { changedFields, liveFixWhat, loadLiveFixSnapshots, snapshotValid } from "@/lib/live-fix";
import { spotCheckStats, spotCheckLine } from "@/lib/spot-check";
import {
  applyFilters,
  decodeCursor,
  filterOptions,
  groupCounts,
  orderEntries,
  pageAfter,
  REVIEW_QUEUE_INDEX_VERSION,
  REVIEW_QUEUE_REVALIDATE_S,
  REVIEW_QUEUE_TAG,
  testNoOf,
  type QueueFilters,
  type QueueIndexEntry,
} from "@/lib/review-queue-view";
import type { GroupSummary, QueueItem, QueuePageData, QueueProposal } from "./types";

type Row = AutoFixRow & { page_number: number | null; source_pdf_url: string | null; reviewed_by: string | null; reviewed_at: string | null };
const CARD_SELECT = `${DECIDE_SELECT}, page_number, reviewed_by, reviewed_at`;

export interface QueueIndex {
  version: string;
  /** When the build started reading rows: an index started before the last change is stale. */
  startedAt: string;
  builtAt: string;
  entries: QueueIndexEntry[];
  autoFixed: Partial<Record<ReviewGroupId, number>>;
  /** Module id → its source PDF can be fetched (for the PDF page panel). */
  modulePdf: Record<string, boolean>;
  lookupErrors: string[];
  spotCheck: { line: string; paused: boolean; system: number; person: number };
}

const isLiveFixRow = (r: Pick<AutoFixRow, "parsing_notes">) => (r.parsing_notes ?? "").startsWith(LIVE_FIX_TAG);

/** groupRow, with an Approved live-test change always in the live-fix group. */
function grouping(r: AutoFixRow): RowGrouping {
  const g = groupRow(r);
  if (r.parsing_status === "Approved") return { ...g, primary: "live_fix", groups: ["live_fix", ...g.groups.filter((x) => x !== "live_fix")] };
  return g;
}

/** A row the queue still shows: Needs Review, or an Approved live-test change to confirm. */
const stillWaiting = (r: AutoFixRow) => r.parsing_status === "Needs Review" || (r.parsing_status === "Approved" && isLiveFixRow(r));

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
        cache: "no-store",
      });
      if (res.ok) return true;
    } catch {
      // try the next token
    }
  }
  return false;
}

type KeyRow = { module_id: string; original_question_number: number | null; question_type: string | null; official_answer: string | null; parsing_notes: string | null };

/** The extracted-key facts of these modules (lib/key-source): one paged query. */
async function loadKeyFacts(db: SupabaseClient, moduleIds: string[]): Promise<Map<string, ModuleKeyFacts>> {
  const ids = [...new Set(moduleIds.filter(Boolean))];
  const rows: KeyRow[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await fetchAllRows<KeyRow>((from, to) =>
      db
        .from("questions")
        .select("id, module_id, original_question_number, question_type, official_answer, parsing_notes")
        .in("module_id", ids.slice(i, i + 50))
        .order("id")
        .range(from, to) as unknown as PromiseLike<{ data: KeyRow[] | null; error: unknown }>,
    );
    if (error) throw new Error(`key facts: ${JSON.stringify(error)}`);
    rows.push(...data);
  }
  const byModule = new Map<string, KeyRow[]>();
  for (const r of rows) byModule.set(r.module_id, [...(byModule.get(r.module_id) ?? []), r]);
  return new Map(ids.map((id) => [id, moduleKeyFacts(byModule.get(id) ?? [])] as const));
}

// ── 1. Index ─────────────────────────────────────────────────────────

/** Build the index from the database (seconds). Read-only. */
export async function buildQueueIndex(db: SupabaseClient = getServiceClient()): Promise<QueueIndex> {
  const startedAt = new Date().toISOString();
  const lookupErrors: string[] = [];
  const page = <T,>(q: (from: number, to: number) => unknown) => fetchAllRows<T>(q as (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>);
  const [nr, lf, fixed, mods] = await Promise.all([
    page<AutoFixRow>((from, to) =>
      db.from("questions").select(DECIDE_SELECT).eq("parsing_status", "Needs Review").order("module_id").order("original_question_number").order("id").range(from, to),
    ),
    // Approved questions changed in a live test: their own group, at the top.
    page<AutoFixRow>((from, to) =>
      db.from("questions").select(DECIDE_SELECT).eq("parsing_status", "Approved").ilike("parsing_notes", `${LIVE_FIX_TAG}%`).order("module_id").order("original_question_number").order("id").range(from, to),
    ),
    page<{ id: string; parsing_status: string; parsing_notes: string }>((from, to) =>
      db
        .from("questions")
        .select("id, parsing_status, parsing_notes")
        .eq("parsing_status", "Approved")
        .or("parsing_notes.ilike.%Explanation auto-fixed%,parsing_notes.ilike.%Figure check: matches%,parsing_notes.ilike.%System-approved%,parsing_notes.ilike.%applied by the system%,parsing_notes.ilike.%applied by auto-key%")
        .order("id")
        .range(from, to),
    ),
    db.from("modules").select("id, module_name, pdf_url"),
  ]);
  if (nr.error) throw new Error(`needs-review questions: ${JSON.stringify(nr.error)}`);
  if (lf.error) throw new Error(`live-fix questions: ${JSON.stringify(lf.error)}`);
  if (fixed.error) throw new Error(`auto-fixed questions: ${JSON.stringify(fixed.error)}`);
  if (mods.error) throw new Error(`modules: ${mods.error.message}`);
  const rows = [...nr.data, ...lf.data];
  const ids = rows.map((r) => r.id);

  const autoFixed: Partial<Record<ReviewGroupId, number>> = {};
  for (const r of fixed.data) {
    const g = autoFixedGroup(r);
    if (g) autoFixed[g] = (autoFixed[g] ?? 0) + 1;
  }

  const groupings = new Map(rows.map((r) => [r.id, grouping(r)] as const));
  const keyModules = rows.filter((r) => GROUP_BY_ID[groupings.get(r.id)!.primary].decision === "key").map((r) => r.module_id ?? "");
  const usedModules = [...new Set(rows.map((r) => r.module_id).filter((x): x is string => !!x))];
  const modInfo = new Map((mods.data ?? []).map((m) => [m.id as string, { name: (m.module_name as string) ?? "Unknown module", pdfUrl: (m.pdf_url as string | null) ?? null }] as const));

  // A failed lookup is shown on the page, never silently treated as "none".
  const [students, live, spot, keyFacts, pdfOk] = await Promise.all([
    realStudentsAnswered(db, ids).catch(() => {
      lookupErrors.push("which students answered each question");
      return new Map<string, number>();
    }),
    liveQuestionIds(db, ids).catch(() => {
      lookupErrors.push("which questions are in a live test");
      return new Set<string>();
    }),
    spotCheckStats(db),
    loadKeyFacts(db, keyModules).catch(() => {
      lookupErrors.push("the answer-key facts of each module");
      return new Map<string, ModuleKeyFacts>();
    }),
    Promise.all(usedModules.map(async (id) => [id, await pdfReachable(modInfo.get(id)?.pdfUrl ?? null)] as const)),
  ]);
  if (spot.error) lookupErrors.push("the spot-check results (automatic decisions are paused)");

  const entries: QueueIndexEntry[] = rows.map((r) => {
    const g = groupings.get(r.id)!;
    let strong: string | null = null;
    if (GROUP_BY_ID[g.primary].decision === "key") {
      const facts = keyFacts.get(r.module_id ?? "") ?? null;
      const official = officialKeyProblem(r, facts) ? null : r.official_answer;
      const s = keyCard(r, official ?? null).suggestion;
      strong = s?.strong && s.answer !== r.correct_answer ? s.answer : null;
    }
    const name = modInfo.get(r.module_id ?? "")?.name ?? "Unknown module";
    return {
      id: r.id,
      primary: g.primary,
      also: g.groups.filter((x) => x !== g.primary),
      status: r.parsing_status ?? "Needs Review",
      live: live.has(r.id),
      students: students.get(r.id) ?? 0,
      moduleId: r.module_id ?? null,
      moduleName: name,
      testNo: testNoOf(name),
      section: r.section ?? null,
      number: r.original_question_number ?? null,
      key: r.correct_answer ?? null,
      strong,
    };
  });

  return {
    version: REVIEW_QUEUE_INDEX_VERSION,
    startedAt,
    builtAt: new Date().toISOString(),
    entries,
    autoFixed,
    modulePdf: Object.fromEntries(pdfOk),
    lookupErrors,
    spotCheck: { line: spotCheckLine(spot), paused: spot.paused, system: spot.system, person: spot.person },
  };
}

// Why not unstable_cache for the index itself: on Vercel its data cache
// doesn't serve stale. Once the tag is revalidated (even with "max") or the
// revalidate time has passed, the next request rebuilds the index while the
// admin waits (3-6 s, measured on prod); `next start` serves stale, so this
// only shows on Vercel. The page and the API are also bundled separately, and
// unstable_cache keys on the function's source text, so each kept its own
// copy and built it again.
//
// So the index is stored in app_settings (one row, the key/value table that
// already holds spot-check results and live-fix snapshots; no schema change),
// shared by every instance and deploy, plus this instance's copy in memory.
// A reader always gets the newest one it has at once. If it was built before
// the last change, or is older than REVIEW_QUEUE_REVALIDATE_S, it is rebuilt
// in after() and stored for the next request. Only an open with no stored
// index at all (a new REVIEW_QUEUE_INDEX_VERSION) waits for a build.

const STORE_KEY = `review_queue_index:${REVIEW_QUEUE_INDEX_VERSION}`;

/** When the queue last changed: recomputed (Date.now()) on the first read after a writer revalidates REVIEW_QUEUE_TAG. */
const changedAt = unstable_cache(async () => Date.now(), ["review-queue-changed-at"], { tags: [REVIEW_QUEUE_TAG] });

let memo: QueueIndex | null = null;
let rebuilding: Promise<QueueIndex> | null = null;

const newer = (a: QueueIndex | null, b: QueueIndex) => (a && Date.parse(a.startedAt) >= Date.parse(b.startedAt) ? a : b);
const isFresh = (index: QueueIndex, changed: number) => {
  const started = Date.parse(index.startedAt);
  return started >= changed && Date.now() - started < REVIEW_QUEUE_REVALIDATE_S * 1000;
};

async function readStored(): Promise<QueueIndex | null> {
  const { data, error } = await getServiceClient().from("app_settings").select("value").eq("key", STORE_KEY).maybeSingle();
  if (error) {
    console.error("[review-queue] stored index read failed:", error.message);
    return null;
  }
  const index = (data?.value ?? null) as QueueIndex | null;
  return index?.version === REVIEW_QUEUE_INDEX_VERSION && typeof index.startedAt === "string" ? index : null;
}

/** Build now (one build per instance at a time). An index with failed lookups is returned but never stored. */
function rebuild(): Promise<QueueIndex> {
  rebuilding ??= (async () => {
    const t0 = Date.now();
    const index = await buildQueueIndex();
    const bytes = JSON.stringify(index).length;
    console.log(`[review-queue] index built: ${index.entries.length} questions, ${(bytes / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`);
    if (index.lookupErrors.length === 0) {
      memo = newer(memo, index);
      const { error } = await getServiceClient().from("app_settings").upsert({ key: STORE_KEY, value: index, updated_at: index.builtAt });
      if (error) console.error("[review-queue] storing the index failed:", error.message);
    }
    return index;
  })().finally(() => {
    rebuilding = null;
  });
  return rebuilding;
}

/** Background refresh: adopt a fresh index another instance stored, else build one. */
async function refresh(changed: number): Promise<void> {
  const stored = await readStored();
  if (stored) memo = newer(memo, stored);
  if (memo && isFresh(memo, changed)) return;
  await rebuild();
}

/** The newest index at once (stale-while-revalidate); waits for a build only when none was ever stored. */
export async function getQueueIndex(): Promise<QueueIndex> {
  const [changed, current] = await Promise.all([changedAt().catch(() => Date.now()), memo ?? readStored()]);
  if (!current) return rebuild();
  memo = newer(memo, current);
  if (!isFresh(memo, changed)) {
    after(() => refresh(changed).catch((e) => console.error("[review-queue] background rebuild failed:", e)));
  }
  return memo;
}

// ── 2. Cards ─────────────────────────────────────────────────────────

/**
 * Cards for `entries`, in their order, from fresh rows. `group`: drop a row
 * whose fresh grouping isn't this group any more (it was decided or changed
 * since the index was built). Rows that left the queue are always dropped
 * unless `keepAll` (one card asked for by id, e.g. after an Undo).
 */
export async function buildCards(
  entries: QueueIndexEntry[],
  index: Pick<QueueIndex, "modulePdf">,
  opts: { group?: ReviewGroupId | null; keepAll?: boolean; db?: SupabaseClient } = {},
): Promise<QueueItem[]> {
  if (entries.length === 0) return [];
  const db = opts.db ?? getServiceClient();
  const ids = entries.map((e) => e.id);
  const fetched: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from("questions").select(CARD_SELECT).in("id", ids.slice(i, i + 100));
    if (error) throw new Error(`queue cards: ${error.message}`);
    fetched.push(...((data ?? []) as unknown as Row[]));
  }
  const byId = new Map(fetched.map((r) => [r.id, r] as const));
  const rows: { r: Row; e: QueueIndexEntry; g: RowGrouping }[] = [];
  for (const e of entries) {
    const r = byId.get(e.id);
    if (!r) continue;
    if (!opts.keepAll && !stillWaiting(r)) continue;
    const g = grouping(r);
    if (opts.group && !opts.keepAll && g.primary !== opts.group) continue;
    rows.push({ r, e, g });
  }

  const keyMods = rows.filter((x) => GROUP_BY_ID[x.g.primary].decision === "key").map((x) => x.r.module_id ?? "");
  const reviewerIds = [...new Set(rows.map((x) => x.r.reviewed_by).filter((x): x is string => !!x))];
  const liveFixIds = rows.filter((x) => isLiveFixRow(x.r)).map((x) => x.r.id);
  const proposalUrls = rows
    .map((x) => ({ id: x.r.id, url: x.g.primary === "figure" ? figureProposalUrl(x.r.parsing_notes) : null }))
    .filter((x): x is { id: string; url: string } => !!x.url);
  const lookupErrors: string[] = [];
  const pageIds = rows.map((x) => x.r.id);
  const [keyFacts, reviewers, snapshots, proposals, liveNow, studentsNow] = await Promise.all([
    keyMods.length ? loadKeyFacts(db, keyMods) : Promise.resolve(new Map<string, ModuleKeyFacts>()),
    reviewerIds.length
      ? db
          .from("users")
          .select("id, display_name, email")
          .in("id", reviewerIds)
          .then(({ data }) => new Map((data ?? []).map((u) => [u.id as string, ((u.display_name as string | null) || (u.email as string | null) || "a reviewer") as string] as const)))
      : Promise.resolve(new Map<string, string>()),
    liveFixIds.length
      ? loadLiveFixSnapshots(db, liveFixIds).catch(() => {
          lookupErrors.push("live-fix snapshots");
          return new Map();
        })
      : Promise.resolve(new Map()),
    // Figure-check proposals (Vercel Blob), at most 6 loads at a time.
    (async () => {
      const out = new Map<string, FigureProposal | null>();
      for (let i = 0; i < proposalUrls.length; i += 6) {
        await Promise.all(proposalUrls.slice(i, i + 6).map(async ({ id, url }) => out.set(id, await loadProposal(url).catch(() => null))));
      }
      return out;
    })(),
    // Live / students answered as of now, not as of the cached index (a test
    // published or a student answering since): the labels a key decision
    // leans on. A failed lookup falls back to the index's values.
    pageIds.length ? liveQuestionIds(db, pageIds).catch(() => null) : Promise.resolve(new Set<string>()),
    pageIds.length ? realStudentsAnswered(db, pageIds).catch(() => null) : Promise.resolve(new Map<string, number>()),
  ]);

  return rows.map(({ r, e, g }) => {
    // A stored "official" value that isn't from the PDF is not shown as official.
    const facts = keyFacts.get(r.module_id ?? "") ?? null;
    const officialProblem = officialKeyProblem(r, facts);
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
    const isKey = GROUP_BY_ID[g.primary].decision === "key";
    const card = keyCard(r, official);
    const src = keySource({ ...r, reviewer_name: r.reviewed_by ? reviewers.get(r.reviewed_by) ?? null : null }, facts);
    const rawSnap = snapshots.get(r.id) ?? null;
    // Only the version recorded for the row's current live-fix change.
    const snap = snapshotValid(rawSnap, r.parsing_notes) ? rawSnap : null;
    const rec = r as unknown as Record<string, unknown>;
    const changed = snap ? changedFields(snap, rec) : [];
    const liveFix = isLiveFixRow(r)
      ? {
          what: liveFixWhat(r.parsing_notes) ?? "Changed while in a live test.",
          changes: changed.map((f) => ({ field: f, before: snap!.fields[f], after: rec[f] })),
          canUndo: !!snap && changed.length > 0,
          keyBefore: snap && changed.includes("correct_answer") ? ((snap.fields.correct_answer as string | null) ?? null) : null,
          snapshotAt: snap?.at ?? null,
        }
      : null;
    return {
      id: r.id,
      headline: isKey ? card.headline : g.primary === "live_fix" && liveFix ? liveFix.what : groupHeadline(g.primary, g.reasons),
      evidence: isKey ? card.evidence : [],
      suggestion: isKey ? card.suggestion : null,
      plainReasons: [...new Set(g.reasons.map((x) => plainReason(x.text)))],
      studentsAnswered: studentsNow ? studentsNow.get(r.id) ?? 0 : e.students,
      live: liveNow ? liveNow.has(r.id) : e.live,
      keySource: { label: src.label, detail: src.detail, kind: src.kind },
      liveFix,
      status: r.parsing_status ?? "Needs Review",
      number: r.original_question_number,
      moduleId: r.module_id ?? null,
      moduleName: e.moduleName,
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
      hasPdf: !!index.modulePdf[r.module_id ?? ""],
      updatedAt: r.updated_at ?? null,
      proposal,
    };
  });
}

// ── 3. One request: counts + one page ────────────────────────────────

export interface QueuePageRequest {
  group: string | null;
  filters: QueueFilters;
  cursor: string | null;
  limit: number;
  /** One question by id (any group, even decided): the card after an Undo. */
  id?: string | null;
}

export async function loadQueuePage(req: QueuePageRequest): Promise<QueuePageData> {
  const index = await getQueueIndex();
  const filtered = applyFilters(index.entries, req.filters);
  const counts = groupCounts(filtered);
  const labelOf = (id: ReviewGroupId) => GROUP_BY_ID[id]?.label ?? id;
  const summary: GroupSummary[] = REVIEW_GROUPS.map((grp) => {
    const c = counts[grp.id];
    return {
      id: grp.id,
      label: grp.label,
      ask: grp.ask,
      decision: grp.decision,
      waiting: c?.waiting ?? 0,
      autoFixed: index.autoFixed[grp.id] ?? 0,
      alsoBlocked: Object.entries(c?.also ?? {})
        .map(([g, n]) => ({ label: labelOf(g as ReviewGroupId), count: n as number }))
        .sort((a, b) => b.count - a.count),
    };
  });
  const firstWaiting = summary.find((g) => g.waiting > 0)?.id ?? summary[0].id;
  const group = (summary.find((g) => g.id === req.group)?.id ?? firstWaiting) as ReviewGroupId;
  const liveFixes = filtered.filter((e) => e.status === "Approved").length;
  const base = {
    group,
    summary,
    totals: { waiting: filtered.length - liveFixes, liveFixes, fixed: Object.values(index.autoFixed).reduce((n, x) => n + (x ?? 0), 0) },
    strongByModule: counts[group]?.strongByModule ?? {},
    byModule: counts[group]?.byModule ?? {},
    filterOptions: filterOptions(index.entries),
    lookupErrors: index.lookupErrors,
    spotCheck: index.spotCheck,
    builtAt: index.builtAt,
  };

  if (req.id) {
    let entry = index.entries.find((e) => e.id === req.id) ?? null;
    if (!entry) {
      // Not waiting any more (e.g. approved, then undone): live / students looked up now.
      const db = getServiceClient();
      const { data } = await db.from("questions").select("id, module_id, section, original_question_number, correct_answer, parsing_status").eq("id", req.id).maybeSingle();
      if (!data) return { ...base, items: [], nextCursor: null };
      const [live, students] = await Promise.all([liveQuestionIds(db, [req.id]).catch(() => new Set([req.id!])), realStudentsAnswered(db, [req.id]).catch(() => new Map<string, number>())]);
      const mod = index.entries.find((e) => e.moduleId === data.module_id);
      entry = {
        id: data.id as string,
        primary: group,
        also: [],
        status: (data.parsing_status as string) ?? "Needs Review",
        live: live.has(req.id),
        students: students.get(req.id) ?? 0,
        moduleId: (data.module_id as string | null) ?? null,
        moduleName: mod?.moduleName ?? "Module",
        testNo: mod?.testNo ?? null,
        section: (data.section as string | null) ?? null,
        number: (data.original_question_number as number | null) ?? null,
        key: (data.correct_answer as string | null) ?? null,
        strong: null,
      };
    }
    return { ...base, items: await buildCards([entry], index, { keepAll: true }), nextCursor: null };
  }

  const perModule = GROUP_BY_ID[group].decision === "key";
  const ordered = orderEntries(filtered.filter((e) => e.primary === group), perModule);
  const { entries, nextCursor } = pageAfter(ordered, decodeCursor(req.cursor), req.limit);
  return { ...base, items: await buildCards(entries, index, { group }), nextCursor };
}
