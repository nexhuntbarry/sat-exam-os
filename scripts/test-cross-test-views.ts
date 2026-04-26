/**
 * E2E sanity check for cross-test teacher views.
 *
 * Picks the existing teacher (barry.py.chuang@gmail.com), runs the same DB
 * queries that /teacher/results and /teacher/analysis use, and prints a
 * summary so we can confirm the queries return non-empty data when expected.
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
const db = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEACHER_EMAIL = "barry.py.chuang@gmail.com";

async function main() {
  console.log(`STEP 1: Locate teacher by email = ${TEACHER_EMAIL}`);
  const { data: teacher } = await db
    .from("users")
    .select("id, display_name, role")
    .eq("email", TEACHER_EMAIL)
    .single();
  if (!teacher) throw new Error(`Teacher ${TEACHER_EMAIL} not found`);
  console.log(`  teacher.id=${teacher.id} role=${teacher.role}`);

  console.log("\nSTEP 2: Find this teacher's assignments (test_assignments.teacher_ids)");
  const { data: assignments } = await db
    .from("test_assignments")
    .select("test_id, student_ids, teacher_ids")
    .contains("teacher_ids", JSON.stringify([teacher.id]));
  console.log(`  assignments: ${assignments?.length ?? 0}`);
  if (!assignments || assignments.length === 0) {
    console.log("  (no assignments — both pages would render empty state)");
    return;
  }
  const testIds = assignments.map((a) => a.test_id);

  console.log("\nSTEP 3: Tests metadata");
  const { data: tests } = await db
    .from("tests")
    .select("id, test_name, module_id, question_ids")
    .in("id", testIds);
  console.log(`  tests: ${tests?.length ?? 0}`);
  for (const t of tests ?? []) {
    console.log(`    - ${t.test_name} (${t.id})`);
  }

  console.log("\nSTEP 4: Submissions across all teacher's tests (results page query)");
  const { data: subs } = await db
    .from("submissions")
    .select(
      `id, test_id, student_id, status, percentage, correct_count, total_questions, time_spent_seconds, submitted_at,
       users!inner(display_name, email)`
    )
    .in("test_id", testIds)
    .order("submitted_at", { ascending: false });
  console.log(`  submissions total: ${subs?.length ?? 0}`);

  // class group via separate student_profiles query (no FK to submissions)
  const studentIds = Array.from(new Set((subs ?? []).map((s) => s.student_id)));
  const { data: profiles } = await db
    .from("student_profiles")
    .select("user_id, class_group")
    .in("user_id", studentIds);
  const classMap = new Map((profiles ?? []).map((p) => [p.user_id, p.class_group]));
  const classCount = Array.from(new Set(Array.from(classMap.values()).filter(Boolean))).length;
  console.log(`  unique class groups: ${classCount}`);
  const completed = (subs ?? []).filter(
    (s) => s.status === "Submitted" || s.status === "Late"
  );
  console.log(`  submitted/late: ${completed.length}`);
  const uniqStudents = new Set((subs ?? []).map((s) => s.student_id)).size;
  console.log(`  unique students: ${uniqStudents}`);

  if (completed.length === 0) {
    console.log("  (no completed submissions — analysis page would render empty state)");
    return;
  }

  console.log("\nSTEP 5: Answer records across all teacher's submissions (analysis query)");
  const subIds = completed.map((s) => s.id);
  const { data: ars } = await db
    .from("answer_records")
    .select("submission_id, question_id, student_answer, is_correct")
    .in("submission_id", subIds);
  console.log(`  answer_records: ${ars?.length ?? 0}`);

  const perQ = new Map<
    string,
    { total: number; correct: number; wrong: number; blank: number }
  >();
  for (const ar of ars ?? []) {
    let e = perQ.get(ar.question_id);
    if (!e) {
      e = { total: 0, correct: 0, wrong: 0, blank: 0 };
      perQ.set(ar.question_id, e);
    }
    e.total++;
    if (ar.is_correct) e.correct++;
    else if (!ar.student_answer) e.blank++;
    else e.wrong++;
  }
  const uniqueQuestions = perQ.size;
  console.log(`  unique questions seen: ${uniqueQuestions}`);

  console.log("\nSTEP 6: Question metadata for top-3 hardest by error_rate");
  const ranked = Array.from(perQ.entries())
    .map(([qid, v]) => ({
      qid,
      total: v.total,
      correct: v.correct,
      wrong: v.wrong,
      blank: v.blank,
      errorRatePct: v.total > 0 ? ((v.wrong + v.blank) / v.total) * 100 : 0,
    }))
    .sort((a, b) => b.errorRatePct - a.errorRatePct)
    .slice(0, 3);

  if (ranked.length === 0) {
    console.log("  (no questions to rank)");
  } else {
    const qIds = ranked.map((r) => r.qid);
    const { data: qmeta } = await db
      .from("questions")
      .select("id, original_question_number, domain, difficulty, question_text")
      .in("id", qIds);
    const metaMap = new Map((qmeta ?? []).map((q) => [q.id, q]));
    console.log("  top-3 hardest:");
    console.table(
      ranked.map((r) => {
        const m = metaMap.get(r.qid);
        return {
          Q: m?.original_question_number ?? "?",
          domain: m?.domain ?? "—",
          attempts: r.total,
          correct: r.correct,
          wrong: r.wrong,
          blank: r.blank,
          "error_rate%": r.errorRatePct.toFixed(1),
          textPreview: (m?.question_text ?? "").slice(0, 60).replace(/\n/g, " "),
        };
      })
    );
  }

  console.log("\nSUMMARY");
  console.log(`  teacher: ${teacher.display_name} <${TEACHER_EMAIL}>`);
  console.log(`  tests: ${tests?.length ?? 0}`);
  console.log(`  submissions (any status): ${subs?.length ?? 0}`);
  console.log(`  submissions (Submitted/Late): ${completed.length}`);
  console.log(`  unique students: ${uniqStudents}`);
  console.log(`  unique questions attempted: ${uniqueQuestions}`);

  console.log("\nCROSS-TEST E2E PASSED.");
}

main().catch((e) => {
  console.error("CROSS-TEST E2E FAILED:", e);
  process.exit(1);
});
