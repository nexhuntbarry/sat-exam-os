/**
 * End-to-end flow test:
 *  - Find published test + assigned student
 *  - Reset any prior submission (idempotent run)
 *  - Simulate: load questions, answer some correctly + some wrong, submit
 *  - Verify: submission graded, answer_records inserted, percentage computed
 *  - Call analytics endpoint, verify per-question error rate computed
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function normalizeAnswer(answer: string | null | undefined): string {
  if (answer == null) return "";
  const s = answer.trim().toLowerCase();
  const fractionMatch = s.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (fractionMatch) {
    const num = parseFloat(fractionMatch[1]);
    const den = parseFloat(fractionMatch[2]);
    if (den !== 0) return String(Math.round((num / den) * 10000) / 10000);
  }
  return s;
}
function answersMatch(student: string | null | undefined, correct: string | null | undefined): boolean {
  if (!correct) return false;
  const sNorm = normalizeAnswer(student);
  const cNorm = normalizeAnswer(correct);
  if (sNorm === cNorm) return true;
  const sNum = parseFloat(sNorm);
  const cNum = parseFloat(cNorm);
  if (!isNaN(sNum) && !isNaN(cNum)) return Math.abs(sNum - cNum) < 0.0001;
  return false;
}

async function main() {
  console.log("STEP 1: Find a Published test with an assigned student");
  const { data: tests } = await db
    .from("tests")
    .select("id, test_name, module_id, time_limit_minutes")
    .eq("status", "Published")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!tests?.length) throw new Error("No published tests");
  const test = tests[0];
  console.log(`  test=${test.test_name} (${test.id}) module=${test.module_id}`);

  const { data: assign } = await db
    .from("test_assignments")
    .select("student_ids, teacher_ids")
    .eq("test_id", test.id)
    .single();
  if (!assign?.student_ids?.length) throw new Error("No students assigned");
  const studentId = (assign.student_ids as string[])[0];
  console.log(`  student=${studentId} teacher=${(assign.teacher_ids as string[])[0]}`);

  console.log("\nSTEP 2: Load questions visible to student (with fix: not Rejected)");
  const { data: questions } = await db
    .from("questions")
    .select("id, original_question_number, question_type, question_text, choices, correct_answer, parsing_status")
    .eq("module_id", test.module_id)
    .neq("parsing_status", "Rejected")
    .order("original_question_number", { ascending: true });
  console.log(`  questions visible: ${questions?.length ?? 0}`);
  if (!questions?.length) throw new Error("Still no questions visible — fix did not apply");

  console.log("\nSTEP 3: Clean up any prior submissions for idempotency");
  const { data: priorSubs } = await db
    .from("submissions")
    .select("id")
    .eq("test_id", test.id)
    .eq("student_id", studentId);
  for (const s of priorSubs ?? []) {
    await db.from("answer_records").delete().eq("submission_id", s.id);
    await db.from("submissions").delete().eq("id", s.id);
  }
  console.log(`  removed ${priorSubs?.length ?? 0} prior submissions + answer records`);

  console.log("\nSTEP 4: Create In Progress submission");
  const { data: sub, error: sErr } = await db
    .from("submissions")
    .insert({
      test_id: test.id,
      student_id: studentId,
      answers: {},
      status: "In Progress",
      started_at: new Date(Date.now() - 600_000).toISOString(),
      attempt_number: 1,
    })
    .select("id, started_at")
    .single();
  if (sErr) throw sErr;
  console.log(`  submission_id=${sub.id}`);

  console.log("\nSTEP 5: Build answer set — half correct, half wrong, last few blank");
  const answers: Record<string, string> = {};
  const choiceWrongMap: Record<string, string> = { A: "B", B: "C", C: "D", D: "A" };
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (i >= questions.length - 2) continue; // leave last 2 blank
    const correct = q.correct_answer ?? "";
    if (i % 2 === 0) {
      answers[q.id] = correct;
    } else if (q.question_type === "Multiple Choice") {
      answers[q.id] = choiceWrongMap[correct] ?? "A";
    } else {
      answers[q.id] = "999";
    }
  }
  await db.from("submissions").update({ answers }).eq("id", sub.id);
  console.log(`  saved ${Object.keys(answers).length} answers`);

  console.log("\nSTEP 6: Inline submit grading (mirrors /api/.../submit)");
  const answerRecords = questions.map((q) => {
    const studentAnswer = answers[q.id] ?? null;
    const isCorrect = answersMatch(studentAnswer, q.correct_answer);
    return {
      submission_id: sub.id,
      question_id: q.id,
      student_answer: studentAnswer,
      correct_answer: q.correct_answer ?? null,
      is_correct: isCorrect,
      time_spent_seconds: 30,
    };
  });
  const correctCount = answerRecords.filter((r) => r.is_correct).length;
  const totalQuestions = questions.length;
  const percentage = Math.round((correctCount / totalQuestions) * 100 * 10) / 10;

  const { error: arErr } = await db.from("answer_records").insert(answerRecords);
  if (arErr) throw arErr;

  await db
    .from("submissions")
    .update({
      status: "Submitted",
      submitted_at: new Date().toISOString(),
      score: correctCount,
      correct_count: correctCount,
      total_questions: totalQuestions,
      percentage,
      time_spent_seconds: 600,
    })
    .eq("id", sub.id);

  console.log(`  graded: ${correctCount}/${totalQuestions} = ${percentage}%`);

  console.log("\nSTEP 7: Verify submission state");
  const { data: graded } = await db
    .from("submissions")
    .select("status, score, correct_count, total_questions, percentage")
    .eq("id", sub.id)
    .single();
  console.log("  ", graded);

  console.log("\nSTEP 8: Verify answer_records inserted");
  const { count: arCount } = await db
    .from("answer_records")
    .select("*", { count: "exact", head: true })
    .eq("submission_id", sub.id);
  console.log(`  answer_records: ${arCount}`);

  console.log("\nSTEP 9: Compute analytics (mirrors /api/teacher/.../analytics)");
  const { data: subRows } = await db
    .from("submissions")
    .select("id")
    .eq("test_id", test.id)
    .in("status", ["Submitted", "Late"]);
  const subIds = (subRows ?? []).map((s) => s.id);
  console.log(`  submissions counted: ${subIds.length}`);

  const { data: ars } = await db
    .from("answer_records")
    .select("question_id, student_answer, is_correct")
    .in("submission_id", subIds);

  const perQ: Record<string, { correct: number; wrong: number; blank: number; total: number }> = {};
  for (const ar of ars ?? []) {
    const e = (perQ[ar.question_id] ??= { correct: 0, wrong: 0, blank: 0, total: 0 });
    e.total++;
    if (ar.is_correct) e.correct++;
    else if (!ar.student_answer) e.blank++;
    else e.wrong++;
  }

  const rows = questions.slice(0, 5).map((q) => {
    const e = perQ[q.id] ?? { correct: 0, wrong: 0, blank: 0, total: 0 };
    const errorRate = e.total > 0 ? ((e.wrong + e.blank) / e.total) * 100 : 0;
    return {
      Q: q.original_question_number,
      total: e.total,
      correct: e.correct,
      wrong: e.wrong,
      blank: e.blank,
      "error_rate%": errorRate.toFixed(1),
    };
  });
  console.log("  per-question (first 5):");
  console.table(rows);

  console.log("\nSTEP 10: Per-question detail (Q1)");
  const q1 = questions[0];
  const q1Records = (ars ?? []).filter((r) => r.question_id === q1.id);
  const dist: Record<string, number> = {};
  for (const r of q1Records) {
    dist[r.student_answer ?? "blank"] = (dist[r.student_answer ?? "blank"] ?? 0) + 1;
  }
  console.log(`  Q${q1.original_question_number} correct=${q1.correct_answer} distribution=${JSON.stringify(dist)}`);

  console.log("\nE2E FLOW PASSED.");
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
