// scripts/test-result-printout.ts
//
// Server-side rules of the student result printout (lib/result-printout),
// against the live database, read-only: who may print whom, QA isolation,
// answer/explanation visibility, short version, and that the score matches
// the shared attemptScore display.
// Run: npx tsx scripts/test-result-printout.ts — exits non-zero on any failure.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
  const [k, ...rest] = line.split("=");
  if (k && !process.env[k]) process.env[k] = rest.join("=").trim().replace(/^"|"$/g, "");
}

let failed = 0;
let total = 0;
function ok(label: string, cond: boolean, detail = "") {
  total++;
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { getServiceClient } = await import("@/lib/supabase");
  const { loadResultPrintouts, listPrintableAttempts, PrintAccessError } = await import("@/lib/result-printout");
  const { decideAnswerVisibility, loadAnswerVisibilityInputs, visibilityKey } = await import("@/lib/answer-visibility");
  const db = getServiceClient();
  const cast = JSON.parse(readFileSync(".omc/qa/cast.json", "utf-8"));
  const TESTS = JSON.parse(readFileSync(".omc/qa/tests.json", "utf-8"));
  const full = { mode: "full" as const, explanations: true, explanationsAt: "inline" as const };
  const denied = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof PrintAccessError ? e.status : `other: ${e}`));

  const qaAdmin = { userId: cast.admins[0].id, role: "admin", isQa: true };
  const T = TESTS.mathLinear as string;
  const all = await listPrintableAttempts(db, qaAdmin, T);
  ok("QA admin lists finished QA attempts", all.length > 0, `${all.length}`);

  // Teacher: only their classes' students.
  const teacher = { userId: cast.teachers[0].id, role: "teacher", isQa: true };
  const mine = await listPrintableAttempts(db, teacher, T).catch(() => []);
  const theirs = new Set(mine.map((a) => a.studentId));
  const outside = all.find((a) => !theirs.has(a.studentId));
  ok("teacher sees a subset of the class list", mine.length < all.length, `${mine.length}/${all.length}`);
  if (outside) ok("teacher can't print a student outside their classes", (await denied(loadResultPrintouts(db, teacher, T, [outside.submissionId], full))) === 403);
  if (mine[0]) ok("teacher can print their own class's student", (await denied(loadResultPrintouts(db, teacher, T, [mine[0].submissionId], full))) === null);

  // Student: own only.
  const a0 = all[0], a1 = all[1];
  const student = { userId: a0.studentId, role: "student", isQa: true };
  ok("student can print their own result", (await denied(loadResultPrintouts(db, student, T, [a0.submissionId], full))) === null);
  if (a1) ok("student can't print another student's result", (await denied(loadResultPrintouts(db, student, T, [a1.submissionId], full))) === 403);

  // QA isolation both ways.
  const { data: realAdmins } = await db.from("users").select("id, email").eq("role", "admin").not("email", "ilike", "qa-test-%").limit(1);
  const realAdmin = { userId: realAdmins![0].id, role: "admin", isQa: false };
  ok("real admin can't print a QA test", (await denied(loadResultPrintouts(db, realAdmin, T, [a0.submissionId], full))) === 404);
  const { data: realTest } = await db.from("tests").select("id").eq("test_name", "[Fall 2026 SAT Midterm] [Test #19] SAT ENG Test").single();
  const realList = await listPrintableAttempts(db, realAdmin, realTest!.id);
  if (realList[0]) ok("QA admin can't print a real test", (await denied(loadResultPrintouts(db, qaAdmin, realTest!.id, [realList[0].submissionId], full))) === 404);

  // Visibility: each printout carries exactly what the student may see.
  async function checkVisibility(viewer: typeof qaAdmin, testId: string, list: { submissionId: string; studentId: string }[], tag: string) {
    const ps = await loadResultPrintouts(db, viewer, testId, list.slice(0, 8).map((a) => a.submissionId), full);
    const inputs = await loadAnswerVisibilityInputs(db, [testId], ps.map((p) => p.studentId));
    for (const p of ps) {
      const input = inputs.get(visibilityKey(testId, p.studentId))!;
      let v = decideAnswerVisibility(input, "results");
      if (!v.answers) {
        const r = decideAnswerVisibility(input, "class_review");
        if (r.answers) v = r;
      }
      const qs = p.modules.flatMap((m) => m.questions);
      const leak = v.answers
        ? qs.some((q) => (q.explanation != null) && !v.explanations)
        : qs.length > 0 || p.grid.some((g) => g.outcome != null);
      ok(`${tag}: ${p.studentName} sees ${v.answers ? (v.explanations ? "answers+explanations" : "answers only") : "score only"}`, !leak);
    }
  }
  await checkVisibility(qaAdmin, T, all, "QA math");
  // A real test whose answers are hidden from students (if any), and one with answers but no explanations.
  const { data: hiddenTests } = await db.from("tests").select("id, test_name").eq("show_answers_after_submission", false).eq("review_unlocked", false).limit(20);
  for (const t of hiddenTests ?? []) {
    const l = await listPrintableAttempts(db, realAdmin, t.id).catch(() => []);
    if (l.length) {
      await checkVisibility(realAdmin, t.id, l, t.test_name);
      break;
    }
  }
  const { data: noExpl } = await db.from("tests").select("id, test_name").eq("show_answers_after_submission", true).eq("show_explanations_after_submission", false).limit(20);
  for (const t of noExpl ?? []) {
    const l = await listPrintableAttempts(db, realAdmin, t.id).catch(() => []);
    if (l.length) {
      await checkVisibility(realAdmin, t.id, l, t.test_name);
      break;
    }
  }

  // Short version: only wrong/blank questions; summary grid still complete.
  const [shortP] = await loadResultPrintouts(db, qaAdmin, T, [a0.submissionId], { ...full, mode: "short" });
  const [fullP] = await loadResultPrintouts(db, qaAdmin, T, [a0.submissionId], full);
  const shortQs = shortP.modules.flatMap((m) => m.questions);
  ok("short version: no correct questions", shortQs.every((q) => q.outcome !== "correct"), `${shortQs.length} shown`);
  ok("short version: summary grid has every question", shortP.grid.length === fullP.grid.length && fullP.grid.length === fullP.modules.flatMap((m) => m.questions).length);
  // Score = the shared display = grid counts.
  const correct = fullP.grid.filter((g) => g.outcome === "correct").length;
  const counted = fullP.attempt.modules.filter((m) => m.graded).reduce((n, m) => n + (m.correct ?? 0), 0);
  ok("score display counts = right answers on paper", !fullP.shows.answers || correct === counted, `${correct} vs ${counted} (${fullP.attempt.score?.modules})`);

  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
