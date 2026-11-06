import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getQaTestIds, onSide } from "@/lib/qa";
import { scopeToStudentQuestionSet } from "@/lib/student-exam";
import { formatDate } from "@/lib/datetime";
import PrintableTest, { type PrintModule, type PrintQuestion } from "@/components/tests/PrintableTest";

export const dynamic = "force-dynamic";

// GET /print/tests/<id>            → blank copy of the test
// GET /print/tests/<id>?key=1      → same copy with the answer key
// Admin only. Prints exactly the question set a student is shown and graded
// on (Approved only, same scoping as the take page). An adaptive test prints
// Module 1 and both Module 2 variants, since a student gets one or the other.
export default async function PrintTestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ key?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "admin") redirect(user.role === "teacher" ? "/teacher" : "/student");

  const { id } = await params;
  const withKey = (await searchParams).key === "1";
  if (!onSide(id, await getQaTestIds(), user.isQa)) notFound();

  const db = getServiceClient();
  const { data: test } = await db
    .from("tests")
    .select("id, test_name, module_id, module_2_id, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, question_ids")
    .eq("id", id)
    .maybeSingle();
  if (!test) notFound();

  const slots: { moduleId: string | null; label: string | null }[] = test.is_adaptive
    ? [
        { moduleId: test.module_1_id, label: "Module 1" },
        { moduleId: test.module_2_easy_id, label: "Module 2 · Easier" },
        { moduleId: test.module_2_hard_id, label: "Module 2 · Harder" },
      ]
    : test.module_2_id
      ? [
          { moduleId: test.module_id, label: "Module 1" },
          { moduleId: test.module_2_id, label: "Module 2" },
        ]
      : [{ moduleId: test.module_id, label: null }];

  const modules: PrintModule[] = [];
  for (const slot of slots) {
    if (!slot.moduleId) continue;
    const [{ data: mod }, { data: questions }] = await Promise.all([
      db.from("modules").select("section").eq("id", slot.moduleId).maybeSingle(),
      scopeToStudentQuestionSet(
        db
          .from("questions")
          .select("id, original_question_number, question_text, choices, question_type, image_urls, correct_answer")
          .eq("module_id", slot.moduleId),
        test,
      ).order("original_question_number", { ascending: true }),
    ]);
    modules.push({
      label: slot.label,
      section: (mod?.section as string | null) ?? null,
      questions: (questions ?? []) as PrintQuestion[],
    });
  }

  return (
    <PrintableTest
      testName={test.test_name}
      modules={modules}
      withKey={withKey}
      generatedOn={formatDate(new Date().toISOString())}
    />
  );
}
