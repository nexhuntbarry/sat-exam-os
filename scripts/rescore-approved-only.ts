// scripts/rescore-approved-only.ts
//
// One-off repair for QA finding C-02: submit / cron / admin force-submit
// used to grade every non-Rejected question of a module, while students
// were only SHOWN the Approved ones — so Draft / Needs Review questions
// counted as wrong answers. Grading is now Approved-only
// (lib/student-exam.ts scopeToStudentQuestionSet); this script brings the
// already-graded submissions in line.
//
// For every Submitted/Late submission whose graded question set contains
// non-Approved questions, it drops those questions' UNANSWERED
// answer_records (an answered one proves the student was shown it back
// then, before a later demotion, so it stays graded) and recomputes score / correct_count / total_questions / percentage /
// scaled_score from the remaining (Approved) records. Existing is_correct
// values are kept as-is unless --regrade-answers is passed, which also
// re-evaluates each kept record with the current answersMatch (M-02).
//
// Usage:
//   npx tsx scripts/rescore-approved-only.ts                    # dry run (default)
//   npx tsx scripts/rescore-approved-only.ts --apply            # write changes
//   npx tsx scripts/rescore-approved-only.ts --regrade-answers  # dry run incl. M-02 regrade
//
// --apply first writes every answer_record it will delete to
// .omc/backups/rescore-approved-only-<timestamp>.json.

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { answersMatch } from "../lib/grade-submission";
import { scaleSectionScore } from "../lib/scoring";

const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REGRADE = process.argv.includes("--regrade-answers");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type Sub = {
  id: string;
  test_id: string;
  student_id: string;
  module_id: string | null;
  status: string;
  correct_count: number | null;
  total_questions: number | null;
  percentage: number | string | null;
  scaled_score: number | null;
};
type Test = {
  id: string;
  test_name: string;
  module_id: string | null;
  question_ids: string[] | null;
  is_adaptive: boolean | null;
};
type Question = { id: string; parsing_status: string; correct_answer: string | null };
type Rec = {
  id: string;
  submission_id: string;
  question_id: string;
  student_answer: string | null;
  correct_answer: string | null;
  is_correct: boolean;
};

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`mode: ${APPLY ? "APPLY" : "dry run"}${REGRADE ? " + regrade answers" : ""}`);

  const subs = await fetchAll<Sub>((a, b) =>
    db
      .from("submissions")
      .select("id, test_id, student_id, module_id, status, correct_count, total_questions, percentage, scaled_score")
      .in("status", ["Submitted", "Late"])
      .order("id")
      .range(a, b),
  );
  const testIds = Array.from(new Set(subs.map((s) => s.test_id)));
  const tests = await fetchAll<Test>((a, b) =>
    db.from("tests").select("id, test_name, module_id, question_ids, is_adaptive").in("id", testIds).range(a, b),
  );
  const testById = new Map(tests.map((t) => [t.id, t]));

  // Graded module per submission, and each module's questions.
  const moduleIds = Array.from(
    new Set(
      subs
        .map((s) => s.module_id ?? testById.get(s.test_id)?.module_id ?? null)
        .filter((x): x is string => Boolean(x)),
    ),
  );
  const questions = await fetchAll<Question & { module_id: string }>((a, b) =>
    db
      .from("questions")
      .select("id, module_id, parsing_status, correct_answer")
      .in("module_id", moduleIds)
      .order("id")
      .range(a, b),
  );
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const questionsByModule = new Map<string, Question[]>();
  for (const q of questions) {
    const list = questionsByModule.get(q.module_id) ?? [];
    list.push(q);
    questionsByModule.set(q.module_id, list);
  }

  let affected = 0;
  let changed = 0;
  const backup: Rec[] = [];
  const touched: string[] = [];
  const perTest = new Map<string, number>();

  for (const sub of subs) {
    const test = testById.get(sub.test_id);
    const moduleId = sub.module_id ?? test?.module_id ?? null;
    if (!test || !moduleId) continue;

    // The set the student was graded on before (non-Rejected, plus the
    // legacy question_ids subset) vs the Approved-only set they saw.
    let scope = (questionsByModule.get(moduleId) ?? []).filter((q) => q.parsing_status !== "Rejected");
    if (!test.is_adaptive && Array.isArray(test.question_ids) && test.question_ids.length > 0) {
      const ids = new Set(test.question_ids);
      scope = scope.filter((q) => ids.has(q.id));
    }
    const hasNonApproved = scope.some((q) => q.parsing_status !== "Approved");
    if (!hasNonApproved && !REGRADE) continue;

    const { data: recs, error } = await db
      .from("answer_records")
      .select("id, submission_id, question_id, student_answer, correct_answer, is_correct")
      .eq("submission_id", sub.id);
    if (error) throw new Error(`answer_records ${sub.id}: ${error.message}`);
    const records = (recs ?? []) as Rec[];

    // A question's status today isn't necessarily its status when the
    // student sat the test (questions get demoted to Needs Review after
    // audits). An ANSWERED record proves the student was shown it, so it
    // stays graded; only unanswered non-Approved records are dropped.
    const isApproved = (r: Rec) => questionById.get(r.question_id)?.parsing_status === "Approved";
    const answered = (r: Rec) => r.student_answer != null && String(r.student_answer).trim() !== "";
    const drop = records.filter((r) => !isApproved(r) && !answered(r));
    const keep = records.filter((r) => isApproved(r) || answered(r));
    const keptSeen = records.filter((r) => !isApproved(r) && answered(r)).length;
    const regraded = keep.map((r) => {
      if (!REGRADE) return { rec: r, isCorrect: r.is_correct };
      const key = questionById.get(r.question_id)?.correct_answer ?? r.correct_answer;
      return { rec: r, isCorrect: answersMatch(r.student_answer, key) };
    });
    const flips = regraded.filter((x) => x.isCorrect !== x.rec.is_correct);
    if (drop.length === 0 && flips.length === 0) continue;
    affected++;
    perTest.set(test.test_name, (perTest.get(test.test_name) ?? 0) + 1);

    const total = keep.length;
    const correct = regraded.filter((x) => x.isCorrect).length;
    const percentage = total > 0 ? Math.round((correct / total) * 100 * 10) / 10 : 0;
    const scaled = total > 0 ? scaleSectionScore(percentage) : null;
    const beforePct = sub.percentage != null ? Number(sub.percentage) : null;

    const differs =
      sub.correct_count !== correct ||
      sub.total_questions !== total ||
      beforePct !== percentage ||
      sub.scaled_score !== scaled;
    if (differs) changed++;

    console.log(
      `${sub.id} [${sub.status}] ${test.test_name.slice(0, 40)}: ` +
        `${sub.correct_count}/${sub.total_questions} ${beforePct}% (${sub.scaled_score}) → ` +
        `${correct}/${total} ${percentage}% (${scaled})` +
        `  drop ${drop.length} unanswered non-approved record(s)` +
        (keptSeen ? `, keep ${keptSeen} answered (seen)` : "") +
        (REGRADE ? `, ${flips.length} regrade flip(s)` : ""),
    );

    if (!APPLY) continue;

    backup.push(...drop);
    touched.push(sub.id);
    for (const x of flips) {
      const { error: fErr } = await db
        .from("answer_records")
        .update({ is_correct: x.isCorrect })
        .eq("id", x.rec.id);
      if (fErr) throw new Error(`regrade ${x.rec.id}: ${fErr.message}`);
    }
  }

  console.log(`\nsubmissions scanned: ${subs.length}`);
  console.log(`submissions affected: ${affected} (score changes: ${changed})`);
  for (const [name, n] of perTest) console.log(`  ${n.toString().padStart(4)}  ${name}`);

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to write.");
    return;
  }

  // Back up before deleting anything.
  mkdirSync(".omc/backups", { recursive: true });
  const backupPath = `.omc/backups/rescore-approved-only-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nbacked up ${backup.length} answer_records to ${backupPath}`);

  for (let i = 0; i < backup.length; i += 200) {
    const ids = backup.slice(i, i + 200).map((r) => r.id);
    const { error } = await db.from("answer_records").delete().in("id", ids);
    if (error) throw new Error(`delete answer_records: ${error.message}`);
  }

  // Recompute every affected submission from its now-final record set.
  let written = 0;
  for (const id of touched) {
    const { data: recs } = await db.from("answer_records").select("is_correct").eq("submission_id", id);
    const total = recs?.length ?? 0;
    const correct = (recs ?? []).filter((r) => r.is_correct).length;
    const percentage = total > 0 ? Math.round((correct / total) * 100 * 10) / 10 : 0;
    const scaled = total > 0 ? scaleSectionScore(percentage) : null;
    const sub = subs.find((s) => s.id === id);
    const beforePct = sub?.percentage != null ? Number(sub.percentage) : null;
    if (
      sub &&
      sub.correct_count === correct &&
      sub.total_questions === total &&
      beforePct === percentage &&
      sub.scaled_score === scaled
    ) {
      continue;
    }
    const { error } = await db
      .from("submissions")
      .update({
        score: correct,
        correct_count: correct,
        total_questions: total,
        percentage,
        scaled_score: scaled,
      })
      .eq("id", id);
    if (error) throw new Error(`update submission ${id}: ${error.message}`);
    written++;
  }
  console.log(`updated ${written} submission(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
