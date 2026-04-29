/**
 * Seed 6 fake students + submissions for trial-UI verification.
 *
 * Usage:
 *   npx tsx scripts/seed-fake-students.ts <test_id>
 *
 * Creates users (clerk_user_id null), student_profiles, attaches them to
 * the test_assignments.student_ids array, then writes one Submitted
 * submission + per-question answer_records each with varied realistic
 * scores (35–92%).
 *
 * Re-runnable: emails are unique-suffixed per run so duplicates are
 * easy to clean up. Pass --cleanup <test_id> to remove every fake user
 * matching the +seed@nexhunt-test.local pattern from the assignment +
 * cascade their submissions/profiles.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  // Fall back to local .env.local so the operator can just run the script.
  try {
    const env = readFileSync(".env.local", "utf-8");
    for (const line of env.split("\n")) {
      const [k, ...rest] = line.split("=");
      const v = rest.join("=").trim().replace(/^"|"$/g, "");
      if (k === "NEXT_PUBLIC_SUPABASE_URL" && !process.env.NEXT_PUBLIC_SUPABASE_URL) {
        process.env.NEXT_PUBLIC_SUPABASE_URL = v;
      }
      if (k === "SUPABASE_SERVICE_ROLE_KEY" && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        process.env.SUPABASE_SERVICE_ROLE_KEY = v;
      }
    }
  } catch {
    // ignore
  }
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(SUPA_URL, SUPA_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const FAKE_TAG = "+seed@nexhunt-test.local";

const STUDENTS = [
  { name: "Emily Chen",   grade: "10", school: "Jericho HS", target: 1500, ratio: 0.92 },
  { name: "Marcus Liu",   grade: "11", school: "Jericho HS", target: 1450, ratio: 0.85 },
  { name: "Sophia Wang",  grade: "10", school: "Jericho HS", target: 1400, ratio: 0.72 },
  { name: "Daniel Park",  grade: "11", school: "Great Neck", target: 1350, ratio: 0.60 },
  { name: "Olivia Hsu",   grade: "10", school: "Great Neck", target: 1500, ratio: 0.50 },
  { name: "Tyler Lin",    grade: "9",  school: "Roslyn",     target: 1200, ratio: 0.35 },
];

interface Question {
  id: string;
  correct_answer: string | null;
  question_type: string;
}

function pickWrongAnswer(correct: string, type: string): string {
  if (type === "Multiple Choice") {
    const choices = ["A", "B", "C", "D"];
    const wrongs = choices.filter((c) => c !== correct);
    return wrongs[Math.floor(Math.random() * wrongs.length)];
  }
  // Student-produced response: numeric guess
  const n = Number(correct);
  if (Number.isFinite(n)) return String(Math.round(n + (Math.random() < 0.5 ? -3 : 3)));
  return "999";
}

async function seedOne(testId: string, moduleId: string, questions: Question[], assignmentId: string, currentStudentIds: string[]) {
  const runStamp = Date.now();
  const newStudentIds: string[] = [];

  for (const s of STUDENTS) {
    const slug = s.name.toLowerCase().replace(/\s+/g, ".");
    const email = `${slug}${runStamp}${FAKE_TAG}`;

    // Insert user (admin / Clerk-less student).
    const { data: user, error: userErr } = await db
      .from("users")
      .insert({
        clerk_user_id: null,
        email,
        display_name: s.name,
        role: "student",
        account_status: "approved",
      })
      .select("id")
      .single();
    if (userErr || !user) {
      console.error("User insert failed:", userErr);
      continue;
    }

    // Profile.
    await db.from("student_profiles").insert({
      user_id: user.id,
      grade: s.grade,
      school: s.school,
      campus: s.school,
      target_score: s.target,
      current_level: "Beginner",
    });

    newStudentIds.push(user.id);

    // Build answer set scoring s.ratio of the questions correctly.
    const correctCount = Math.round(questions.length * s.ratio);
    const shuffled = [...questions].sort(() => Math.random() - 0.5);
    const correctSet = new Set(shuffled.slice(0, correctCount).map((q) => q.id));

    const answers: Record<string, string> = {};
    const records: Array<{
      question_id: string;
      student_answer: string;
      correct_answer: string | null;
      is_correct: boolean;
      time_spent_seconds: number;
    }> = [];

    for (const q of questions) {
      const isCorrect = correctSet.has(q.id);
      const ans =
        isCorrect && q.correct_answer
          ? q.correct_answer
          : pickWrongAnswer(q.correct_answer ?? "A", q.question_type);
      answers[q.id] = ans;
      records.push({
        question_id: q.id,
        student_answer: ans,
        correct_answer: q.correct_answer,
        is_correct: isCorrect,
        time_spent_seconds: 30 + Math.floor(Math.random() * 90),
      });
    }

    const totalSeconds = records.reduce((sum, r) => sum + r.time_spent_seconds, 0);
    const startedAt = new Date(Date.now() - totalSeconds * 1000 - 60_000).toISOString();
    const submittedAt = new Date(Date.now() - 60_000).toISOString();
    const percentage = Math.round((correctCount / questions.length) * 1000) / 10;

    const { data: sub, error: subErr } = await db
      .from("submissions")
      .insert({
        test_id: testId,
        student_id: user.id,
        answers,
        score: correctCount,
        correct_count: correctCount,
        total_questions: questions.length,
        percentage,
        started_at: startedAt,
        submitted_at: submittedAt,
        time_spent_seconds: totalSeconds,
        status: "Submitted",
        attempt_number: 1,
        metadata: { seed: true, fake: true },
      })
      .select("id")
      .single();
    if (subErr || !sub) {
      console.error(`Submission insert failed for ${s.name}:`, subErr);
      continue;
    }

    const recordsWithSub = records.map((r) => ({ ...r, submission_id: sub.id }));
    const { error: arErr } = await db.from("answer_records").insert(recordsWithSub);
    if (arErr) console.error(`Answer records insert failed for ${s.name}:`, arErr);

    console.log(`✓ ${s.name} (${percentage}%) → submission ${sub.id}`);
  }

  // Add new student IDs to assignment.
  const merged = Array.from(new Set([...(currentStudentIds ?? []), ...newStudentIds]));
  const { error: assignErr } = await db
    .from("test_assignments")
    .update({ student_ids: merged })
    .eq("id", assignmentId);
  if (assignErr) console.error("Assignment update failed:", assignErr);
  else console.log(`✓ Assignment updated: now has ${merged.length} students`);

  console.log(`\nSeeded ${newStudentIds.length} fake students to test ${testId}.`);
}

async function cleanup(testId: string) {
  const { data: assignment } = await db
    .from("test_assignments")
    .select("id, student_ids")
    .eq("test_id", testId)
    .single();
  if (!assignment) {
    console.error("No assignment found for test", testId);
    return;
  }

  const { data: fakeUsers } = await db
    .from("users")
    .select("id")
    .like("email", `%${FAKE_TAG.replace("+", "%2B")}%`)
    .ilike("email", "%seed@nexhunt-test.local");

  const fakeIds = new Set((fakeUsers ?? []).map((u) => u.id));
  const filteredStudents = ((assignment.student_ids as string[]) ?? []).filter(
    (id) => !fakeIds.has(id)
  );

  await db.from("test_assignments").update({ student_ids: filteredStudents }).eq("id", assignment.id);

  if (fakeIds.size > 0) {
    const ids = Array.from(fakeIds);
    await db.from("answer_records").delete().in("submission_id",
      (await db.from("submissions").select("id").in("student_id", ids)).data?.map((s) => s.id) ?? []);
    await db.from("submissions").delete().in("student_id", ids);
    await db.from("student_profiles").delete().in("user_id", ids);
    await db.from("users").delete().in("id", ids);
    console.log(`Removed ${fakeIds.size} fake students.`);
  } else {
    console.log("No fake students found.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--cleanup") {
    const testId = args[1];
    if (!testId) {
      console.error("Usage: npx tsx scripts/seed-fake-students.ts --cleanup <test_id>");
      process.exit(1);
    }
    await cleanup(testId);
    return;
  }

  const testId = args[0];
  if (!testId) {
    console.error("Usage: npx tsx scripts/seed-fake-students.ts <test_id>");
    process.exit(1);
  }

  // Load test → module → questions.
  const { data: test } = await db
    .from("tests")
    .select("id, module_id")
    .eq("id", testId)
    .single();
  if (!test) {
    console.error("Test not found:", testId);
    process.exit(1);
  }

  const { data: questions } = await db
    .from("questions")
    .select("id, correct_answer, question_type")
    .eq("module_id", test.module_id)
    .neq("parsing_status", "Rejected");

  if (!questions || questions.length === 0) {
    console.error("No questions found for module", test.module_id);
    process.exit(1);
  }

  const { data: assignment } = await db
    .from("test_assignments")
    .select("id, student_ids")
    .eq("test_id", testId)
    .single();
  if (!assignment) {
    console.error("No assignment found for test", testId);
    process.exit(1);
  }

  console.log(`Seeding 6 fake students for test ${testId} (${questions.length} questions)...`);
  await seedOne(
    testId,
    test.module_id,
    questions as Question[],
    assignment.id,
    (assignment.student_ids as string[]) ?? []
  );
}

main().catch((err) => {
  console.error("Seeder crashed:", err);
  process.exit(1);
});
