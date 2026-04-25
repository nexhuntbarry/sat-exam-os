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

export default async function QuestionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const question = await getQuestion(id);

  if (!question) notFound();

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
      <QuestionReviewPanel question={question} />
    </div>
  );
}
