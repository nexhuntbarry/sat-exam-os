import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getServiceClient } from "@/lib/supabase";
import QuestionReviewPanel from "@/components/questions/QuestionReviewPanel";

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
  return { nextId, prevId, pendingCount, moduleId };
}

export default async function QuestionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const question = await getQuestion(id);

  if (!question) notFound();

  const nav = await getReviewNav(
    question.module_id,
    question.id,
    question.original_question_number,
  );

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
            className="text-xs text-warm-coral hover:underline"
          >
            {question.modules.module_name}
          </Link>
        )}
      </div>
      <QuestionReviewPanel question={question} nav={nav} />
    </div>
  );
}
