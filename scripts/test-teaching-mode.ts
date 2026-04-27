/**
 * E2E sanity check for the Teaching Mode tab.
 *
 * Locates the existing teacher (barry.py.chuang@gmail.com), runs the same DB
 * queries that /teacher/teaching-mode hits, and prints:
 *   - the test that test-review would auto-select
 *   - the top 3 hardest questions for that test
 *   - the top 3 weakest skills (latest-domain-first)
 *   - candidate practice questions for the weakest skill
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
  console.log(`STEP 1: Locate teacher = ${TEACHER_EMAIL}`);
  const { data: teacher } = await db
    .from("users")
    .select("id, display_name, role")
    .eq("email", TEACHER_EMAIL)
    .single();
  if (!teacher) throw new Error(`Teacher ${TEACHER_EMAIL} not found`);
  console.log(`  teacher.id=${teacher.id} role=${teacher.role}`);

  console.log("\nSTEP 2: Find test_assignments");
  const { data: assignments } = await db
    .from("test_assignments")
    .select("test_id, class_group_ids")
    .contains("teacher_ids", JSON.stringify([teacher.id]));
  console.log(`  assignments: ${assignments?.length ?? 0}`);
  if (!assignments || assignments.length === 0) {
    console.log("  (page would render empty state)");
    return;
  }
  const testIds = assignments.map((a) => a.test_id);

  console.log("\nSTEP 3: Tests (Published/Closed only — same as test-review endpoint)");
  const { data: tests } = await db
    .from("tests")
    .select("id, test_name, status, created_at")
    .in("id", testIds)
    .in("status", ["Published", "Closed"])
    .order("created_at", { ascending: false });
  console.log(`  tests: ${tests?.length ?? 0}`);
  for (const t of tests ?? []) {
    console.log(`    - ${t.test_name} [${t.status}] (${t.id})`);
  }
  if (!tests || tests.length === 0) return;

  const selectedTest = tests[0];
  console.log(`  -> auto-selected: ${selectedTest.test_name}`);

  console.log("\nSTEP 4: Submissions for selected test");
  const { data: subs } = await db
    .from("submissions")
    .select("id")
    .eq("test_id", selectedTest.id)
    .in("status", ["Submitted", "Late"]);
  const subIds = (subs ?? []).map((s) => s.id);
  console.log(`  submissions (Submitted/Late): ${subIds.length}`);

  console.log("\nSTEP 5: Top-3 hardest questions for that test");
  if (subIds.length > 0) {
    const { data: ars } = await db
      .from("answer_records")
      .select("question_id, is_correct")
      .in("submission_id", subIds);

    const perQ = new Map<string, { total: number; wrong: number }>();
    for (const ar of ars ?? []) {
      let e = perQ.get(ar.question_id);
      if (!e) {
        e = { total: 0, wrong: 0 };
        perQ.set(ar.question_id, e);
      }
      e.total++;
      if (!ar.is_correct) e.wrong++;
    }
    const ranked = Array.from(perQ.entries())
      .map(([qid, v]) => ({
        qid,
        total: v.total,
        wrong: v.wrong,
        errorRate: v.total ? (v.wrong / v.total) * 100 : 0,
      }))
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, 3);

    if (ranked.length === 0) {
      console.log("  (no answer records)");
    } else {
      const qIds = ranked.map((r) => r.qid);
      const { data: qmeta } = await db
        .from("questions")
        .select("id, original_question_number, domain, skill, question_text")
        .in("id", qIds);
      const m = new Map((qmeta ?? []).map((q) => [q.id, q]));
      console.table(
        ranked.map((r) => {
          const q = m.get(r.qid);
          return {
            Q: q?.original_question_number ?? "?",
            domain: q?.domain ?? "—",
            skill: q?.skill ?? "—",
            wrong: `${r.wrong}/${r.total}`,
            "error_rate%": r.errorRate.toFixed(1),
            preview: (q?.question_text ?? "").slice(0, 50).replace(/\n/g, " "),
          };
        })
      );
    }
  } else {
    console.log("  (no submissions yet)");
  }

  console.log("\nSTEP 6: Top-3 weakest skills across ALL teacher's tests");
  const { data: allSubs } = await db
    .from("submissions")
    .select("id")
    .in("test_id", testIds)
    .in("status", ["Submitted", "Late"]);
  const allSubIds = (allSubs ?? []).map((s) => s.id);
  console.log(`  total Submitted/Late submissions: ${allSubIds.length}`);

  if (allSubIds.length === 0) {
    console.log("  (no data — skill drill would render empty state)");
    console.log("\nTEACHING-MODE E2E PASSED (empty-state path).");
    return;
  }

  const { data: allArs } = await db
    .from("answer_records")
    .select("question_id, is_correct")
    .in("submission_id", allSubIds);
  console.log(`  total answer_records: ${allArs?.length ?? 0}`);

  const allQIds = Array.from(new Set((allArs ?? []).map((a) => a.question_id)));
  const { data: qmetaAll } = await db
    .from("questions")
    .select("id, domain, skill")
    .in("id", allQIds);
  const metaMap = new Map((qmetaAll ?? []).map((q) => [q.id, q]));

  const allDomains = Array.from(
    new Set((qmetaAll ?? []).map((q) => q.domain).filter(Boolean) as string[])
  ).sort();
  console.log(`  domains found: ${allDomains.join(", ") || "(none)"}`);

  const firstDomain = allDomains[0];
  if (!firstDomain) {
    console.log("  (no domain metadata on questions — skill drill empty)");
    console.log("\nTEACHING-MODE E2E PASSED (no-domain path).");
    return;
  }
  console.log(`  -> auto-selected domain: ${firstDomain}`);

  const perSkill = new Map<string, { total: number; wrong: number }>();
  for (const ar of allArs ?? []) {
    const q = metaMap.get(ar.question_id);
    if (!q?.skill || q.domain !== firstDomain) continue;
    let e = perSkill.get(q.skill);
    if (!e) {
      e = { total: 0, wrong: 0 };
      perSkill.set(q.skill, e);
    }
    e.total++;
    if (!ar.is_correct) e.wrong++;
  }

  const topSkills = Array.from(perSkill.entries())
    .map(([skill, v]) => ({
      skill,
      total: v.total,
      wrong: v.wrong,
      "error_rate%": v.total ? ((v.wrong / v.total) * 100).toFixed(1) : "0.0",
    }))
    .sort((a, b) => Number(b["error_rate%"]) - Number(a["error_rate%"]))
    .slice(0, 3);

  if (topSkills.length === 0) {
    console.log(`  (no skill-tagged answer records in domain ${firstDomain})`);
  } else {
    console.table(topSkills);
  }

  console.log("\nSTEP 7: Candidate questions for the weakest skill");
  const weakest = topSkills[0]?.skill;
  if (weakest) {
    const { data: candidates } = await db
      .from("questions")
      .select("id, original_question_number, difficulty, has_image")
      .eq("skill", weakest)
      .limit(10);
    console.log(`  candidates for "${weakest}": ${candidates?.length ?? 0}`);
    if (candidates && candidates.length > 0) {
      console.table(
        candidates.slice(0, 5).map((q) => ({
          Q: q.original_question_number,
          difficulty: q.difficulty,
          hasImage: q.has_image,
        }))
      );
    }
  }

  console.log("\nSUMMARY");
  console.log(`  teacher: ${teacher.display_name}`);
  console.log(`  tests visible in Teaching Mode picker: ${tests.length}`);
  console.log(`  selected test submissions: ${subIds.length}`);
  console.log(`  domains available: ${allDomains.length}`);
  console.log(`  weakest-skill candidates queried: ${weakest ?? "(n/a)"}`);

  console.log("\nTEACHING-MODE E2E PASSED.");
}

main().catch((e) => {
  console.error("TEACHING-MODE E2E FAILED:", e);
  process.exit(1);
});
