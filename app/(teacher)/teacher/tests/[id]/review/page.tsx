import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Presentation } from "lucide-react";
import ReviewQuestionCard, { type ReviewQuestion } from "@/components/tests/ReviewQuestionCard";

// Teacher class-review walkthrough — the projector view for going over a
// test with students. Shows every question with its choices, figures,
// correct answer, and explanation. Uses the same ReviewQuestionCard as the
// student review so the two never drift. No per-student data here: this
// screen is shown to the whole class, so who-got-what-wrong lives on the
// private Question Analytics page instead.
async function getTeacherReview(testId: string, teacherId: string) {
  const db = getServiceClient();

  const { data: assignment } = await db
    .from("test_assignments")
    .select("test_id, teacher_ids")
    .eq("test_id", testId)
    .single();
  if (!assignment) return null;
  const teacherIds: string[] = assignment.teacher_ids ?? [];
  if (!teacherIds.includes(teacherId)) return null;

  const { data: test } = await db
    .from("tests")
    .select(
      "id, test_name, module_id, module_2_id, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, question_ids",
    )
    .eq("id", testId)
    .single();
  if (!test) return null;

  const moduleIds = test.is_adaptive
    ? [test.module_1_id, test.module_2_easy_id, test.module_2_hard_id].filter((x): x is string => Boolean(x))
    : [test.module_id, test.module_2_id].filter((x): x is string => Boolean(x));
  if (moduleIds.length === 0) return { test, sections: [] };

  let qquery = db
    .from("questions")
    .select(
      "id, module_id, original_question_number, question_text, choices, question_type, correct_answer, explanation, has_image, has_table, image_urls, image_alts, page_number, source_pdf_url, modules!inner(module_name, section, module_number)",
    )
    .in("module_id", moduleIds)
    .neq("parsing_status", "Rejected")
    .order("original_question_number", { ascending: true });
  if (!test.is_adaptive && Array.isArray(test.question_ids) && test.question_ids.length > 0) {
    qquery = qquery.in("id", test.question_ids);
  }
  const { data: questions } = await qquery;

  type Section = { moduleId: string; title: string; questions: NonNullable<typeof questions> };
  const groups = new Map<string, Section>();
  for (const q of questions ?? []) {
    const mod = q.modules as unknown as { module_name: string; section: string; module_number: number | null } | null;
    let label = mod?.module_name ?? "Module";
    if (test.is_adaptive) {
      if (q.module_id === test.module_1_id) label = `Module 1 — ${mod?.module_name ?? ""}`;
      else if (q.module_id === test.module_2_easy_id) label = `Module 2 · Easy — ${mod?.module_name ?? ""}`;
      else if (q.module_id === test.module_2_hard_id) label = `Module 2 · Hard — ${mod?.module_name ?? ""}`;
    } else if (test.module_2_id) {
      if (q.module_id === test.module_id) label = `Module 1 — ${mod?.module_name ?? ""}`;
      else if (q.module_id === test.module_2_id) label = `Module 2 — ${mod?.module_name ?? ""}`;
    }
    if (!groups.has(q.module_id)) groups.set(q.module_id, { moduleId: q.module_id, title: label, questions: [] });
    groups.get(q.module_id)!.questions.push(q);
  }
  return { test, sections: Array.from(groups.values()) };
}

export default async function TeacherTestReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const { id } = await params;
  const data = await getTeacherReview(id, user.userId);
  if (!data) notFound();
  const { test, sections } = data;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${test.id}`} className="hover:text-charcoal transition-colors">{test.test_name}</Link>
        <span>/</span>
        <span className="text-charcoal">Class review</span>
      </div>

      <div className="rounded-2xl border border-warm-coral/20 bg-warm-coral/5 px-4 py-3 flex items-start gap-3">
        <Presentation size={18} className="text-warm-coral mt-0.5 shrink-0" />
        <div>
          <h1 className="text-charcoal font-bold text-base">{test.test_name} — class review</h1>
          <p className="text-soft-mute text-xs mt-0.5">
            Projector walkthrough: every question with choices, figures, the correct answer,
            and the explanation. To see which students missed each question, use{" "}
            <Link href={`/teacher/tests/${test.id}/analytics`} className="text-warm-coral hover:underline">
              Question Analytics
            </Link>.
          </p>
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="bg-surface border border-divider rounded-2xl p-12 text-center text-soft-mute text-sm">
          No questions in this test.
        </div>
      ) : (
        sections.map((section) => (
          <section key={section.moduleId} className="space-y-4">
            <h2 className="text-charcoal font-semibold text-lg">{section.title}</h2>
            <div className="space-y-4">
              {section.questions.map((q) => (
                <ReviewQuestionCard key={q.id} question={q as unknown as ReviewQuestion} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
