import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getQaTestIds, onSide } from "@/lib/qa";
import { scopeToStudentQuestionSet } from "@/lib/student-exam";
import { formatDate } from "@/lib/datetime";
import PrintableTest, { type PrintModule, type PrintQuestion } from "@/components/tests/PrintableTest";
import PrintPreview from "@/components/print/PrintPreview";
import { printPageCss } from "@/lib/print-page-css";

export const dynamic = "force-dynamic";

// GET /print/tests/<id>            → blank copy of the test
// GET /print/tests/<id>?key=1      → same copy with the answer key
// Admin only. Prints exactly the question set a student is shown and graded
// on (Approved only, same scoping as the take page). An adaptive test prints
// Module 1 and both Module 2 variants, since a student gets one or the other.
// A full-length SAT prints R&W, then a "Section 2: Math" divider, then Math.
const TEST_COLUMNS =
  "id, test_name, module_id, module_2_id, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, question_ids";

interface PrintTestRow {
  id: string;
  test_name: string;
  module_id: string | null;
  module_2_id: string | null;
  is_adaptive: boolean | null;
  module_1_id: string | null;
  module_2_easy_id: string | null;
  module_2_hard_id: string | null;
  question_ids: string[] | null;
}

/** The modules of one (section) test in print order. */
function printSlots(test: PrintTestRow): { moduleId: string | null; label: string | null }[] {
  if (test.is_adaptive) {
    return [
      { moduleId: test.module_1_id, label: "Module 1" },
      { moduleId: test.module_2_easy_id, label: "Module 2 · Easier" },
      { moduleId: test.module_2_hard_id, label: "Module 2 · Harder" },
    ];
  }
  return test.module_2_id
    ? [
        { moduleId: test.module_id, label: "Module 1" },
        { moduleId: test.module_2_id, label: "Module 2" },
      ]
    : [{ moduleId: test.module_id, label: null }];
}

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
    .select(`${TEST_COLUMNS}, test_kind`)
    .eq("id", id)
    .maybeSingle();
  if (!test) notFound();

  // A full-length SAT prints its two hidden sections in exam order: R&W
  // (Module 1, Module 2 Easier/Harder), a "Section 2: Math" divider page,
  // then Math. Labels carry the section, so the header shows it once.
  let parts: { test: PrintTestRow; sectionLabel: string | null; dividerBefore: string | null }[] = [
    { test: test as PrintTestRow, sectionLabel: null, dividerBefore: null },
  ];
  if (test.test_kind === "full_length") {
    const { data: kids } = await db
      .from("tests")
      .select(`${TEST_COLUMNS}, section_order`)
      .eq("parent_test_id", id)
      .order("section_order", { ascending: true });
    const rows = (kids ?? []) as (PrintTestRow & { section_order: number | null })[];
    parts = [
      { order: 1, sectionLabel: "Reading and Writing", dividerBefore: null },
      { order: 2, sectionLabel: "Math", dividerBefore: "Section 2: Math" },
    ].flatMap((p) => {
      const child = rows.find((r) => r.section_order === p.order);
      return child ? [{ test: child, sectionLabel: p.sectionLabel, dividerBefore: p.dividerBefore }] : [];
    });
  }
  // A full-length test missing a section can't be printed as an exam.
  if (parts.length === 0) notFound();

  const modules: PrintModule[] = [];
  for (const part of parts) {
    let first = true;
    for (const slot of printSlots(part.test)) {
      if (!slot.moduleId) continue;
      const [{ data: mod }, { data: questions }] = await Promise.all([
        db.from("modules").select("section").eq("id", slot.moduleId).maybeSingle(),
        scopeToStudentQuestionSet(
          db
            .from("questions")
            .select("id, original_question_number, question_text, choices, question_type, image_urls, correct_answer")
            .eq("module_id", slot.moduleId),
          part.test,
        ).order("original_question_number", { ascending: true }),
      ]);
      modules.push({
        label: part.sectionLabel ? [part.sectionLabel, slot.label ?? "Module 1"].join(" · ") : slot.label,
        section: part.sectionLabel ? null : ((mod?.section as string | null) ?? null),
        questions: (questions ?? []) as PrintQuestion[],
        ...(first && part.dividerBefore ? { dividerBefore: part.dividerBefore } : {}),
      });
      first = false;
    }
  }

  return (
    <PrintPreview
      title={`${test.test_name} — ${withKey ? "with answer key" : "blank test"}`}
      pageCss={printPageCss({ header: { text: test.test_name } })}
      options={[
        {
          param: "key",
          label: "Version",
          value: withKey ? "1" : "",
          choices: [
            { value: "", label: "Blank test" },
            { value: "1", label: "With answer key" },
          ],
        },
      ]}
    >
      <PrintableTest
        testName={test.test_name}
        modules={modules}
        withKey={withKey}
        generatedOn={formatDate(new Date().toISOString())}
      />
    </PrintPreview>
  );
}
