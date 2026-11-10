import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth";
import { getQaUserIds, onSide } from "@/lib/qa";
import { getServiceClient } from "@/lib/supabase";
import { asParentRows, expandWithChildren, fullLengthLinks, hideChildTests } from "@/lib/full-length";
import { getTeacherTestScope, seesAllStudents } from "@/lib/teacher-access";
import { formatDate } from "@/lib/datetime";
import PageIntro from "@/components/shared/PageIntro";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
} from "@/components/ui/data-table";

// Question Analysis: pick a test, then see each of its questions in order
// (app/(teacher)/teacher/tests/[id]/analytics). The old cross-test
// "hardest questions" ranking was replaced by this (Barry, 2026-11-06).
async function getTests(teacherId: string, role: string, isQa: boolean) {
  const db = getServiceClient();
  // Same test set and student scope as the rest of the teacher area.
  const scope = await getTeacherTestScope(db, { userId: teacherId, role, isQa });
  if (scope.testIds.size === 0) return [];
  const ids = Array.from(scope.testIds);
  const flLinks = await fullLengthLinks(db);

  const [{ data: tests }, { data: rawSubs }, qaUsers] = await Promise.all([
    hideChildTests(db.from("tests").select("id, test_name, created_at").in("id", ids), new Set(flLinks.parentOf.keys())),
    db
      .from("submissions")
      .select("id, test_id, student_id, session_id, submitted_at, status, attempt_number, adaptive_track")
      .in("test_id", expandWithChildren(ids, flLinks))
      .in("status", ["Submitted", "Late"]),
    getQaUserIds(),
  ]);
  // A full-length SAT's rows are on its children: one attempt under the parent.
  const subs = asParentRows(rawSubs ?? [], flLinks);

  const attempts = new Map<string, Set<string>>();
  const lastSubmitted = new Map<string, string>();
  for (const s of subs ?? []) {
    if (!onSide(s.student_id, qaUsers, isQa)) continue;
    if (!seesAllStudents(scope, s.test_id) && !scope.myStudentIds.has(s.student_id)) continue;
    // Attempts, not module rows (two-module attempts share a session_id).
    const set = attempts.get(s.test_id) ?? new Set<string>();
    set.add((s.session_id as string | null) ?? (s.id as string));
    attempts.set(s.test_id, set);
    const at = s.submitted_at as string | null;
    if (at && at > (lastSubmitted.get(s.test_id) ?? "")) lastSubmitted.set(s.test_id, at);
  }

  return (tests ?? [])
    .map((t) => ({
      id: t.id as string,
      name: t.test_name as string,
      submitted: attempts.get(t.id)?.size ?? 0,
      lastSubmitted: lastSubmitted.get(t.id) ?? null,
      createdAt: t.created_at as string,
    }))
    .sort(
      (a, b) =>
        (b.lastSubmitted ?? "").localeCompare(a.lastSubmitted ?? "") || b.createdAt.localeCompare(a.createdAt),
    );
}

export default async function TeacherAnalysisPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const [tests, t] = await Promise.all([
    getTests(user.userId, user.role ?? "", user.isQa),
    getTranslations("teacherAnalysis"),
  ]);

  if (tests.length === 0) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center space-y-6">
        <PageIntro tKey="teacher.analysis" />
        <div className="inline-flex p-5 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
          <BarChart2 size={36} className="text-warm-coral-text" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>
          <p className="text-soft-mute text-sm">{t("emptyBody")}</p>
        </div>
        <Link
          href="/teacher/teaching-mode"
          className="inline-block px-5 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold transition-colors"
        >
          {t("createCta")}
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageIntro tKey="teacher.analysis" />
      <div>
        <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>
        <p className="text-soft-mute text-sm mt-1">{t("subtitleLong")}</p>
      </div>
      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main">{t("colTest")}</Th>
            <Th className="text-right">{t("colSubmitted")}</Th>
            <Th>{t("colLastSubmitted")}</Th>
            <Th kind="actions"><span className="sr-only">{t("open")}</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {tests.map((test) => (
            <DataRow key={test.id}>
              <Td kind="main">
                <Link href={`/teacher/tests/${test.id}/analytics`} className="block truncate text-charcoal font-medium hover:underline">
                  {test.name}
                </Link>
              </Td>
              <Td className="text-right">{test.submitted}</Td>
              <Td>{test.lastSubmitted ? formatDate(test.lastSubmitted) : "—"}</Td>
              <Td kind="actions">
                <Link
                  href={`/teacher/tests/${test.id}/analytics`}
                  className="text-warm-coral-text text-sm font-medium hover:underline whitespace-nowrap"
                >
                  {t("open")} →
                </Link>
              </Td>
            </DataRow>
          ))}
        </tbody>
      </DataTable>
    </div>
  );
}
