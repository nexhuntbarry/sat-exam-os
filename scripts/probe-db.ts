import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

// Load .env.local
const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  console.log("\n== TESTS (any status) ==");
  const { data: tests } = await db
    .from("tests")
    .select("id, test_name, status, module_id, time_limit_minutes, question_ids, created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  console.table(tests);

  console.log("\n== TEST_ASSIGNMENTS for those tests ==");
  if (tests && tests.length > 0) {
    const { data: assigns } = await db
      .from("test_assignments")
      .select("test_id, teacher_ids, student_ids, class_group_ids")
      .in("test_id", tests.map(t => t.id));
    console.log(JSON.stringify(assigns, null, 2));
  }

  console.log("\n== MODULES (any) ==");
  const { data: mods } = await db
    .from("modules")
    .select("id, module_name, section, parsing_status, total_questions")
    .order("created_at", { ascending: false })
    .limit(10);
  console.table(mods);

  if (tests && tests.length > 0 && tests[0].module_id) {
    const moduleId = tests[0].module_id;
    console.log(`\n== QUESTIONS for module ${moduleId} ==`);
    const { data: qs, count } = await db
      .from("questions")
      .select("id, original_question_number, question_type, parsing_status, has_image, has_table, page_number", { count: "exact" })
      .eq("module_id", moduleId)
      .order("original_question_number", { ascending: true })
      .limit(15);
    console.log(`Total: ${count}`);
    console.table(qs);

    const { data: approved } = await db
      .from("questions")
      .select("id", { count: "exact", head: true })
      .eq("module_id", moduleId)
      .eq("parsing_status", "Approved");
    console.log(`Approved: ${(approved as unknown as { count?: number })?.count ?? "—"}`);
  }

  console.log("\n== STUDENT USERS ==");
  const { data: students } = await db
    .from("users")
    .select("id, email, display_name, role, account_status")
    .eq("role", "student")
    .limit(10);
  console.table(students);

  console.log("\n== SUBMISSIONS ==");
  const { data: subs } = await db
    .from("submissions")
    .select("id, test_id, student_id, status, score, percentage, attempt_number, started_at, submitted_at")
    .order("started_at", { ascending: false })
    .limit(10);
  console.table(subs);
}

main().catch((e) => { console.error(e); process.exit(1); });
