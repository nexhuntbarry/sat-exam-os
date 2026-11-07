import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getServiceClient } from "@/lib/supabase";
import QuestionReviewPanel from "@/components/questions/QuestionReviewPanel";
import FigureDiff from "@/components/questions/FigureDiff";
import { getCurrentUser } from "@/lib/auth";
import { forbidQa } from "@/lib/qa";
import { figureProposalUrl } from "@/lib/review-queue";
import { currentStored, loadProposal, proposalIsCurrent } from "@/lib/figure-compare";
import { liveQuestionIds } from "@/lib/live-questions";
import { moduleKeyFacts, type ModuleKeyFacts } from "@/lib/key-source";

async function getQuestion(id: string) {
  const db = getServiceClient();
  const { data, error } = await db
    .from("questions")
    .select(`*, modules(module_name, source_name, pdf_url, section, difficulty, module_number)`)
    .eq("id", id)
    .single();
  if (error || !data) return null;
  return data;
}

// What the module's extracted answer key looks like (lib/key-source): a key
// that gives letters to fill-in questions, or that disagrees with most solved
// answers, isn't shown as an official key.
async function getModuleKeyFacts(moduleId: string | null): Promise<ModuleKeyFacts | null> {
  if (!moduleId) return null;
  const { data } = await getServiceClient()
    .from("questions")
    .select("original_question_number, question_type, official_answer, parsing_notes")
    .eq("module_id", moduleId);
  return data ? moduleKeyFacts(data) : null;
}

// Build the in-module review stepper: the pending (Draft / Needs Review)
// questions of this module in question-number order, and where the current
// one sits so the panel can offer Prev / Next / Approve&Next without the
// reviewer bouncing back to the list.
async function getReviewNav(
  moduleId: string | null,
  currentId: string,
  currentNumber: number | null,
) {
  if (!moduleId) return undefined;
  const db = getServiceClient();
  const { data } = await db
    .from("questions")
    .select("id, original_question_number")
    .eq("module_id", moduleId)
    .in("parsing_status", ["Draft", "Needs Review"])
    .order("original_question_number", { ascending: true });
  const pending = data ?? [];
  const curNum = currentNumber ?? -1;

  let nextId: string | null = null;
  let prevId: string | null = null;
  for (const row of pending) {
    if (row.id === currentId) continue;
    const n = row.original_question_number ?? -1;
    if (n < curNum) prevId = row.id; // ordered asc → keeps the closest-below
    else if (n > curNum && nextId === null) nextId = row.id; // first above
  }
  // pendingCount excludes the current question (it's about to be resolved).
  const pendingCount = pending.filter((r) => r.id !== currentId).length;

  // Nothing left after this one in the module → carry on to the next module
  // that still has pending questions (by module name, wrapping around), so
  // Next / Approve & Next keep going through the whole bank instead of
  // dropping the reviewer back at the module page.
  let nextModuleName: string | null = null;
  if (nextId === null) {
    const { data: all } = await db
      .from("questions")
      .select("id, module_id, original_question_number, modules(module_name)")
      .in("parsing_status", ["Draft", "Needs Review"])
      .neq("module_id", moduleId);
    const name = (r: { modules: unknown }) =>
      ((r.modules as { module_name?: string } | null)?.module_name ?? "");
    const others = (all ?? []).sort(
      (a, b) =>
        name(a).localeCompare(name(b)) ||
        (a.original_question_number ?? 0) - (b.original_question_number ?? 0),
    );
    if (others.length > 0) {
      const { data: cur } = await db.from("modules").select("module_name").eq("id", moduleId).maybeSingle();
      const curName = cur?.module_name ?? "";
      const pick = others.find((r) => name(r).localeCompare(curName) > 0) ?? others[0];
      nextId = pick.id;
      nextModuleName = name(pick);
    }
  }
  return { nextId, prevId, pendingCount, moduleId, nextModuleName };
}

export default async function QuestionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const question = await getQuestion(id);

  if (!question) notFound();

  // Figure check found a difference with the PDF: show both side by side —
  // for a Needs Review question, or for one in a live test (a change then
  // keeps it Approved with a [live-fix] note). Not for other Approved ones.
  const live =
    question.parsing_status === "Approved"
      ? (await liveQuestionIds(getServiceClient(), [question.id]).catch(() => new Set<string>())).has(question.id)
      : false;
  const proposalUrl = question.parsing_status === "Needs Review" || live ? figureProposalUrl(question.parsing_notes) : null;
  const proposal = proposalUrl ? await loadProposal(proposalUrl).catch(() => null) : null;
  const user = proposal ? await getCurrentUser() : null;

  const [nav, keyFacts] = await Promise.all([
    getReviewNav(question.module_id, question.id, question.original_question_number),
    getModuleKeyFacts(question.module_id),
  ]);

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/questions" className="text-soft-mute hover:text-charcoal transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-xl font-bold text-charcoal">
          Review Question
        </h1>
        {question.modules && (
          <Link
            href={`/admin/modules/${question.module_id}`}
            className="text-xs text-warm-coral-text hover:underline"
          >
            {question.modules.module_name}
          </Link>
        )}
      </div>
      {proposal && proposal.questionId === question.id && (
        <section aria-label="Figure check" className="rounded-2xl border border-status-warning/30 bg-status-warning/5 p-4">
          <h2 className="mb-2 text-sm font-semibold text-charcoal">Figure check: differs from the PDF</h2>
          <FigureDiff
            questionId={question.id}
            updatedAt={question.updated_at ?? null}
            proposal={{
              parts: proposal.parts,
              diffs: proposal.diffs,
              pages: proposal.pages,
              // The row as it is now, not as it was when compared.
              stored: currentStored(question, proposal.parts),
              pdf: proposal.pdf,
              checkMarkLeak: !!proposal.checkMarkLeak,
              stale: !proposalIsCurrent(proposal, question),
            }}
            canWrite={!!user && forbidQa(user) === null}
            liveNote={live}
            reloadOnDone
          />
        </section>
      )}
      <QuestionReviewPanel key={question.id} question={question} nav={nav} moduleKeyFacts={keyFacts} />
    </div>
  );
}
