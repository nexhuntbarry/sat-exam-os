import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { StatCard } from "@/components/analytics/StatCard";
import {
  CrossTestQuestionTable,
  type CrossTestQuestionRow,
} from "@/components/analytics/CrossTestQuestionTable";
import PageIntro from "@/components/shared/PageIntro";

interface DomainAgg {
  domain: string;
  attempts: number;
  correct: number;
  errorRatePct: number;
}

async function getCrossTestAnalysis(teacherId: string, role: string) {
  const db = getServiceClient();

  // 1. Teacher's assignments
  let assignmentsQuery = db
    .from("test_assignments")
    .select("test_id, teacher_ids");

  if (role !== "admin") {
    assignmentsQuery = assignmentsQuery.contains(
      "teacher_ids",
      JSON.stringify([teacherId])
    );
  }

  const { data: assignments } = await assignmentsQuery;
  if (!assignments || assignments.length === 0) {
    return null;
  }
  const testIds = assignments.map((a) => a.test_id);

  // 2. Test metadata + which question_ids each test uses (or fall back to module_id)
  const { data: tests } = await db
    .from("tests")
    .select("id, test_name, module_id, question_ids");
  const teacherTests = (tests ?? []).filter((t) => testIds.includes(t.id));

  const testNameMap = new Map<string, string>(
    teacherTests.map((t) => [t.id, t.test_name])
  );

  // 3. Submitted/Late submissions only
  const { data: submissions } = await db
    .from("submissions")
    .select("id, test_id")
    .in("test_id", testIds)
    .in("status", ["Submitted", "Late"]);

  const subList = submissions ?? [];
  if (subList.length === 0) {
    return {
      empty: true as const,
      totals: { tests: testIds.length, submissions: 0, uniqueQuestions: 0 },
      testOptions: teacherTests
        .map((t) => ({ id: t.id, name: t.test_name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  const subIds = subList.map((s) => s.id);
  const subToTestMap = new Map<string, string>(subList.map((s) => [s.id, s.test_id]));

  // 4. Answer records
  const { data: answerRecords } = await db
    .from("answer_records")
    .select("submission_id, question_id, student_answer, is_correct")
    .in("submission_id", subIds);

  const ars = answerRecords ?? [];

  // Aggregate per-question: counts + which tests it appeared in
  const perQ = new Map<
    string,
    {
      total: number;
      correct: number;
      wrong: number;
      blank: number;
      choiceDist: Record<string, number>;
      testIds: Set<string>;
    }
  >();

  for (const ar of ars) {
    const qid = ar.question_id;
    let e = perQ.get(qid);
    if (!e) {
      e = { total: 0, correct: 0, wrong: 0, blank: 0, choiceDist: {}, testIds: new Set() };
      perQ.set(qid, e);
    }
    e.total++;
    if (ar.is_correct) e.correct++;
    else if (!ar.student_answer) e.blank++;
    else e.wrong++;

    const choice = ar.student_answer ?? "blank";
    e.choiceDist[choice] = (e.choiceDist[choice] ?? 0) + 1;

    const tid = subToTestMap.get(ar.submission_id);
    if (tid) e.testIds.add(tid);
  }

  const questionIds = Array.from(perQ.keys());
  if (questionIds.length === 0) {
    return {
      empty: true as const,
      totals: { tests: testIds.length, submissions: subList.length, uniqueQuestions: 0 },
      testOptions: teacherTests
        .map((t) => ({ id: t.id, name: t.test_name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // 5. Question metadata
  const { data: questions } = await db
    .from("questions")
    .select(
      "id, original_question_number, question_text, correct_answer, difficulty, domain"
    )
    .in("id", questionIds);

  const qMetaMap = new Map<
    string,
    {
      number: number | null;
      text: string;
      correctAnswer: string | null;
      difficulty: string | null;
      domain: string | null;
    }
  >();
  for (const q of questions ?? []) {
    qMetaMap.set(q.id, {
      number: q.original_question_number,
      text: q.question_text,
      correctAnswer: q.correct_answer,
      difficulty: q.difficulty,
      domain: q.domain,
    });
  }

  // Build rows
  const rows: CrossTestQuestionRow[] = [];
  for (const [qid, agg] of perQ.entries()) {
    const meta = qMetaMap.get(qid);
    if (!meta) continue;

    const errorRatePct =
      agg.total > 0 ? ((agg.wrong + agg.blank) / agg.total) * 100 : 0;

    const correct = meta.correctAnswer ?? "";
    let mostSelectedWrong: string | null = null;
    let maxCount = 0;
    for (const [choice, cnt] of Object.entries(agg.choiceDist)) {
      if (choice === correct || choice === "blank") continue;
      if (cnt > maxCount) {
        maxCount = cnt;
        mostSelectedWrong = choice;
      }
    }

    const testsArr = Array.from(agg.testIds).map((tid) => ({
      testId: tid,
      testName: testNameMap.get(tid) ?? "(unknown)",
    }));

    rows.push({
      questionId: qid,
      questionNumber: meta.number,
      textPreview: meta.text.slice(0, 280),
      domain: meta.domain,
      difficulty: meta.difficulty,
      totalAttempts: agg.total,
      correctCount: agg.correct,
      wrongCount: agg.wrong,
      blankCount: agg.blank,
      errorRatePct,
      mostSelectedWrong,
      testIdForLink: testsArr[0]?.testId ?? "",
      testsAppearingIn: testsArr,
    });
  }

  // Domain aggregation
  const domainMap = new Map<string, { attempts: number; correct: number }>();
  for (const r of rows) {
    const d = r.domain ?? "(uncategorised)";
    const cur = domainMap.get(d) ?? { attempts: 0, correct: 0 };
    cur.attempts += r.totalAttempts;
    cur.correct += r.correctCount;
    domainMap.set(d, cur);
  }
  const domainAggs: DomainAgg[] = Array.from(domainMap.entries())
    .map(([domain, v]) => ({
      domain,
      attempts: v.attempts,
      correct: v.correct,
      errorRatePct: v.attempts > 0 ? ((v.attempts - v.correct) / v.attempts) * 100 : 0,
    }))
    .sort((a, b) => b.errorRatePct - a.errorRatePct);

  return {
    empty: false as const,
    totals: {
      tests: testIds.length,
      submissions: subList.length,
      uniqueQuestions: rows.length,
    },
    rows,
    domainAggs,
    testOptions: teacherTests
      .map((t) => ({ id: t.id, name: t.test_name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export default async function TeacherAnalysisPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const [data, t] = await Promise.all([
    getCrossTestAnalysis(user.userId, user.role ?? ""),
    getTranslations("teacherAnalysis"),
  ]);

  if (!data) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center space-y-6">
        <PageIntro tKey="teacher.analysis" />
        <div className="inline-flex p-5 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
          <BarChart2 size={36} className="text-warm-coral" />
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

  if (data.empty) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageIntro tKey="teacher.analysis" />
        <div>
          <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>
          <p className="text-soft-mute text-sm mt-1">{t("subtitleShort")}</p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl py-16 text-center text-soft-mute text-sm">
          {t("noSubmissions")}
        </div>
      </div>
    );
  }

  const { rows, domainAggs, testOptions, totals } = data;

  // Top-level metrics
  const overallAttempts = rows.reduce((s, r) => s + r.totalAttempts, 0);
  const overallCorrect = rows.reduce((s, r) => s + r.correctCount, 0);
  const overallErrorPct =
    overallAttempts > 0 ? ((overallAttempts - overallCorrect) / overallAttempts) * 100 : 0;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <PageIntro tKey="teacher.analysis" />
      <div>
        <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>
        <p className="text-soft-mute text-sm mt-1">{t("subtitleLong")}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label={t("stats.tests")} value={totals.tests} color="default" />
        <StatCard label={t("stats.submissions")} value={totals.submissions} color="lime" />
        <StatCard
          label={t("stats.uniqueQuestions")}
          value={totals.uniqueQuestions}
          color="blue"
        />
        <StatCard
          label={t("stats.overallErrorRate")}
          value={`${overallErrorPct.toFixed(1)}%`}
          color={overallErrorPct >= 50 ? "rose" : overallErrorPct >= 30 ? "amber" : "emerald"}
        />
      </div>

      {/* Worst domains */}
      <section className="space-y-3">
        <h2 className="text-charcoal font-semibold text-lg">{t("worstDomains")}</h2>
        <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
          {domainAggs.length === 0 ? (
            <div className="py-8 text-center text-soft-mute text-sm">
              {t("noDomainData")}
            </div>
          ) : (
            <div className="divide-y divide-divider">
              {domainAggs.map((d) => (
                <div key={d.domain} className="px-5 py-3 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-charcoal text-sm font-medium truncate">
                      {d.domain}
                    </div>
                    <div className="text-soft-mute text-xs">
                      {t("domainAttempts", {
                        attempts: d.attempts,
                        correct: d.correct,
                      })}
                    </div>
                  </div>
                  <div className="w-48 bg-light-bg rounded-full h-2 overflow-hidden">
                    <div
                      className={
                        d.errorRatePct >= 50
                          ? "h-full bg-status-error"
                          : d.errorRatePct >= 30
                            ? "h-full bg-status-warning"
                            : "h-full bg-warm-amber"
                      }
                      style={{ width: `${Math.min(100, d.errorRatePct)}%` }}
                    />
                  </div>
                  <div className="w-16 text-right text-charcoal text-sm font-semibold">
                    {d.errorRatePct.toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Hardest questions overall */}
      <section className="space-y-3">
        <h2 className="text-charcoal font-semibold text-lg">{t("hardestOverall")}</h2>
        <CrossTestQuestionTable rows={rows} testOptions={testOptions} />
      </section>
    </div>
  );
}
