import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getQaTestIds, onSide } from "@/lib/qa";
import { orderToQuestionIds, scopeToStudentQuestionSet } from "@/lib/student-exam";
import { formatDate } from "@/lib/datetime";
import PrintableTest, { type PrintModule, type PrintQuestion } from "@/components/tests/PrintableTest";
import PrintPreview from "@/components/print/PrintPreview";
import { printPageCss } from "@/lib/print-page-css";
import { watermarkOn, watermarkOption } from "@/lib/print-watermark";
import { teacherQaGate } from "@/lib/teacher-qa";
import { FL_ALL_SECTIONS, flSectionScope } from "@/lib/full-length-score";

export const dynamic = "force-dynamic";

// GET /print/tests/<id>            → blank copy of the test
// GET /print/tests/<id>?key=1      → same copy with the answer key
//   &explain=inline | end           → plus explanations under each question / all at the end
//                                     (explanations give the answers away, so they turn the key on)
//   &wm=0                           → no watermark (admins only; teachers always get it)
// Admins; and teachers who can open the test (getTeacherTestAccess, the
// Questions & answers page's rule) while the admin's "Teachers can view &
// print questions/answers" switch is on (lib/teacher-qa) — a single-subject
// teacher gets only their section of a full-length SAT. Students never.
// Prints exactly the question set a student is shown and graded
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
  searchParams: Promise<{ key?: string; explain?: string; wm?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "admin" && user.role !== "teacher") redirect("/student");

  const { id } = await params;
  const sp = await searchParams;
  const explain = sp.explain === "inline" || sp.explain === "end" ? sp.explain : null;
  const withKey = sp.key === "1" || explain != null;
  const watermark = watermarkOn(user.role, sp.wm);
  if (!onSide(id, await getQaTestIds(), user.isQa)) notFound();

  const db = getServiceClient();
  if (user.role === "teacher") {
    const { decision } = await teacherQaGate(db, user, id);
    if (decision === "no-access") notFound();
    if (decision === "off") {
      const t = await getTranslations("teacherQa");
      return (
        <div className="max-w-lg mx-auto px-4 py-16 text-center space-y-4">
          <p data-teacher-qa-off className="text-charcoal font-semibold">{t("off")}</p>
          <Link href={`/teacher/tests/${id}`} className="text-sm text-warm-coral-text hover:underline">
            {t("backToTest")}
          </Link>
        </div>
      );
    }
  }
  // A failed read shows an error, never a printout with modules missing.
  const loadFailed = async (what: string, error: { message?: string }) => {
    console.error(`[print/tests] ${what} lookup failed for ${id}:`, error);
    const t = await getTranslations("teacherQa");
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center space-y-2">
        <p role="alert" className="text-status-error font-semibold">{t("printLoadFailed")}</p>
      </div>
    );
  };
  const { data: test, error: testError } = await db
    .from("tests")
    .select(`${TEST_COLUMNS}, test_kind`)
    .eq("id", id)
    .maybeSingle();
  if (testError) return loadFailed("test", testError);
  if (!test) notFound();

  // A full-length SAT prints its two hidden sections in exam order: R&W
  // (Module 1, Module 2 Easier/Harder), a "Section 2: Math" divider page,
  // then Math. Labels carry the section, so the header shows it once.
  let parts: { test: PrintTestRow; sectionLabel: string | null; dividerBefore: string | null }[] = [
    { test: test as PrintTestRow, sectionLabel: null, dividerBefore: null },
  ];
  if (test.test_kind === "full_length") {
    const { data: kids, error: kidsError } = await db
      .from("tests")
      .select(`${TEST_COLUMNS}, section_order`)
      .eq("parent_test_id", id)
      .order("section_order", { ascending: true });
    if (kidsError) return loadFailed("sections", kidsError);
    const rows = (kids ?? []) as (PrintTestRow & { section_order: number | null })[];
    const rwChild = rows.find((r) => r.section_order === 1) ?? null;
    const mathChild = rows.find((r) => r.section_order === 2) ?? null;
    // A single-subject teacher prints only their own section (the Questions
    // & answers page's rule); the Math divider only follows R&W.
    const scope =
      user.role === "admin"
        ? FL_ALL_SECTIONS
        : await flSectionScope(db, user, { rw: rwChild?.id ?? null, math: mathChild?.id ?? null });
    const withRw = Boolean(rwChild && scope.rw);
    parts = [
      ...(rwChild && scope.rw ? [{ test: rwChild, sectionLabel: "Reading and Writing", dividerBefore: null }] : []),
      ...(mathChild && scope.math
        ? [{ test: mathChild, sectionLabel: "Math", dividerBefore: withRw ? "Section 2: Math" : null }]
        : []),
    ];
  }
  // A full-length test missing a section can't be printed as an exam.
  if (parts.length === 0) notFound();

  const modules: PrintModule[] = [];
  for (const part of parts) {
    let first = true;
    for (const slot of printSlots(part.test)) {
      if (!slot.moduleId) continue;
      const [{ data: mod, error: modError }, { data: questions, error: qError }] = await Promise.all([
        db.from("modules").select("section").eq("id", slot.moduleId).maybeSingle(),
        scopeToStudentQuestionSet(
          db
            .from("questions")
            .select(
              `id, original_question_number, question_text, choices, question_type, image_urls, correct_answer${explain ? ", explanation" : ""}`,
            ),
          part.test,
          slot.moduleId,
        ).order("original_question_number", { ascending: true }),
      ]);
      if (modError || qError) return loadFailed("module questions", (modError ?? qError)!);
      modules.push({
        // Full-length: the section shows as its SubjectTag, the label is the module.
        label: part.sectionLabel ? slot.label ?? "Module 1" : slot.label,
        section: part.sectionLabel ?? ((mod?.section as string | null) ?? null),
        questions: orderToQuestionIds((questions ?? []) as unknown as PrintQuestion[], part.test, slot.moduleId, (q) => q.id),
        ...(first && part.dividerBefore ? { dividerBefore: part.dividerBefore } : {}),
      });
      first = false;
    }
  }

  const t = await getTranslations("teacherQa");
  return (
    <PrintPreview
      title={`${test.test_name} — ${withKey ? "with answer key" : "blank test"}${explain ? " + explanations" : ""}`}
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
          // Explanations include the answers: the key is on while they are.
          ...(explain ? { disabledReason: t("explainForcesKey") } : {}),
        },
        {
          param: "explain",
          label: t("explanationsWithKey"),
          value: explain ?? "",
          choices: [
            { value: "", label: t("explainOff") },
            { value: "inline", label: t("explainInline") },
            { value: "end", label: t("explainEnd") },
          ],
        },
        ...(user.role === "admin" ? [watermarkOption(watermark)] : []),
      ]}
      watermark={watermark}
    >
      <PrintableTest
        testName={test.test_name}
        modules={modules}
        withKey={withKey}
        explanations={explain}
        generatedOn={formatDate(new Date().toISOString())}
      />
    </PrintPreview>
  );
}
