import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Eye } from "lucide-react";
import { clsx } from "clsx";
import MathMarkdown from "@/components/MathMarkdown";

// Class-walkthrough review of a test. Shows every question + correct
// answer + explanation regardless of whether the student took the
// test. Gated on tests.review_unlocked, so the teacher controls access.
async function getReviewData(testId: string, studentId: string) {
  const db = getServiceClient();

  // Verify the student is assigned to this test (direct or via class).
  const { data: assignment } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids")
    .eq("test_id", testId)
    .single();
  if (!assignment) return null;

  const { data: membership } = await db
    .from("class_group_members")
    .select("class_group_id")
    .eq("student_id", studentId);
  const cgIds: string[] = (membership ?? []).map((m) => m.class_group_id);
  const sIds: string[] = assignment.student_ids ?? [];
  const cgAssigned: string[] = assignment.class_group_ids ?? [];
  const hasAccess = sIds.includes(studentId) || cgIds.some((c) => cgAssigned.includes(c));
  if (!hasAccess) return null;

  const { data: test } = await db
    .from("tests")
    .select(
      "id, test_name, status, review_unlocked, module_id, module_2_id, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, question_ids",
    )
    .eq("id", testId)
    .single();
  if (!test || !test.review_unlocked) return null;

  // Modules to show in the walkthrough:
  //  - adaptive: Module 1 + both Module 2 tracks (teacher can flip
  //    between either one in class)
  //  - non-adaptive 2-module: Module 1 then Module 2
  //  - legacy single-module: just module_id
  const moduleIds = test.is_adaptive
    ? [test.module_1_id, test.module_2_easy_id, test.module_2_hard_id].filter(
        (x): x is string => Boolean(x),
      )
    : [test.module_id, test.module_2_id].filter((x): x is string => Boolean(x));

  if (moduleIds.length === 0) {
    return { test, sections: [] };
  }

  let qquery = db
    .from("questions")
    .select(
      "id, module_id, original_question_number, question_text, choices, question_type, correct_answer, explanation, modules!inner(module_name, section, module_number)",
    )
    .in("module_id", moduleIds)
    .neq("parsing_status", "Rejected")
    .order("original_question_number", { ascending: true });

  if (
    !test.is_adaptive &&
    test.question_ids &&
    Array.isArray(test.question_ids) &&
    test.question_ids.length > 0
  ) {
    qquery = qquery.in("id", test.question_ids);
  }

  const { data: questions } = await qquery;

  // Group by module so the page reads as Module 1 / Module 2 ... for
  // adaptive tests; non-adaptive collapses to a single group.
  type Section = {
    moduleId: string;
    title: string;
    questions: NonNullable<typeof questions>;
  };
  const groups = new Map<string, Section>();
  for (const q of questions ?? []) {
    const mod = q.modules as unknown as
      | { module_name: string; section: string; module_number: number | null }
      | null;
    const key = q.module_id;
    let label = mod?.module_name ?? "Module";
    if (test.is_adaptive) {
      if (q.module_id === test.module_1_id) label = `Module 1 — ${mod?.module_name ?? ""}`;
      else if (q.module_id === test.module_2_easy_id) label = `Module 2 · Easy — ${mod?.module_name ?? ""}`;
      else if (q.module_id === test.module_2_hard_id) label = `Module 2 · Hard — ${mod?.module_name ?? ""}`;
    } else if (test.module_2_id) {
      if (q.module_id === test.module_id) label = `Module 1 — ${mod?.module_name ?? ""}`;
      else if (q.module_id === test.module_2_id) label = `Module 2 — ${mod?.module_name ?? ""}`;
    }
    if (!groups.has(key)) {
      groups.set(key, { moduleId: key, title: label, questions: [] });
    }
    groups.get(key)!.questions.push(q);
  }

  return { test, sections: Array.from(groups.values()) };
}

export default async function StudentTestReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const data = await getReviewData(id, user.userId);
  if (!data) notFound();

  const { test, sections } = data;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/student/tests" className="hover:text-charcoal transition-colors">My Tests</Link>
        <span>/</span>
        <Link href={`/student/tests/${test.id}`} className="hover:text-charcoal transition-colors">{test.test_name}</Link>
        <span>/</span>
        <span className="text-charcoal">Class review</span>
      </div>

      <div className="rounded-2xl border border-warm-amber/30 bg-warm-amber/10 px-4 py-3 flex items-start gap-3">
        <Eye size={18} className="text-warm-amber mt-0.5 shrink-0" />
        <div>
          <h1 className="text-charcoal font-bold text-base">{test.test_name} — class review</h1>
          <p className="text-soft-mute text-xs mt-0.5">
            Your teacher unlocked the answer key for this test. Read along during class
            review. The view will close again when the teacher locks it.
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
                <div
                  key={q.id}
                  className="bg-surface border border-divider rounded-2xl p-5 space-y-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full bg-warm-coral/15 text-warm-coral text-xs font-semibold">
                      Q{q.original_question_number}
                    </span>
                    {q.question_type === "Student Produced Response" && (
                      <span className="text-soft-mute text-xs">SPR</span>
                    )}
                  </div>
                  <MathMarkdown className="prose prose-sm max-w-none text-charcoal leading-relaxed [&_p]:my-1.5">
                    {q.question_text}
                  </MathMarkdown>

                  {Array.isArray(q.choices) && q.choices.length > 0 && (
                    <div className="space-y-1.5">
                      {(q.choices as Array<{ label: string; text: string }>).map((c) => {
                        const isCorrect = c.label === q.correct_answer;
                        return (
                          <div
                            key={c.label}
                            className={clsx(
                              "flex items-start gap-2.5 p-2.5 rounded-lg text-sm",
                              isCorrect
                                ? "bg-status-success/10 border border-status-success/30 text-charcoal"
                                : "text-mid-gray",
                            )}
                          >
                            <span className="font-semibold shrink-0">{c.label}.</span>
                            <MathMarkdown className="prose prose-sm max-w-none text-inherit [&_p]:my-0">
                              {c.text}
                            </MathMarkdown>
                            {isCorrect && (
                              <span className="ml-auto text-status-success text-xs font-bold">
                                Correct
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {q.question_type === "Student Produced Response" && (
                    <div className="text-xs text-soft-mute">
                      Correct answer:{" "}
                      <span className="text-status-success font-semibold">
                        {q.correct_answer ?? "—"}
                      </span>
                    </div>
                  )}

                  {q.explanation && (
                    <div className="rounded-lg border border-warm-coral/15 bg-warm-coral/5 p-3">
                      <div className="text-warm-coral text-xs font-medium mb-1">
                        Explanation
                      </div>
                      <MathMarkdown className="prose prose-sm max-w-none text-mid-gray [&_p]:my-1 [&_p]:leading-relaxed">
                        {q.explanation}
                      </MathMarkdown>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
