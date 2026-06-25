// scripts/fix-render-issues.ts
//
// Sweep every question through the structural CHECKS and auto-repair the
// fixable failure modes, then demote any still-broken Approved row to
// Needs Review so students never see a broken question.
//
// Routing:
//   pipe-flattened-table / has-table-flag-but-no-table → repairTableForQuestion
//   math-render-failed / math-contains-prose / math-unwrapped → repairMathForQuestion
//   blind-image → repairImageForQuestion
//   answer/empty/mcq checks → no safe auto-fix; reported + (if Approved) demoted
//
//   npx tsx scripts/fix-render-issues.ts          # dry-run: report only
//   npx tsx scripts/fix-render-issues.ts --apply  # run repairs + demote
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { CHECKS, type AuditRow } from "../lib/post-parse-cleanup";

const APPLY = process.argv.includes("--apply");
const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const TABLE_CHECKS = new Set([
  "pipe-flattened-table",
  "has-table-flag-but-no-table-in-text",
]);
const MATH_CHECKS = new Set([
  "math-render-failed",
  "math-contains-prose",
  "math-unwrapped",
]);
const IMAGE_CHECKS = new Set(["blind-image"]);
// no safe auto-fix — human review
const HUMAN_CHECKS = new Set([
  "explanation-final-mismatch",
  "empty-answer",
  "empty-text",
  "mcq-answer-not-in-choices",
  "mcq-bad-choice-count",
  "spr-with-letter-answer",
  "rw-misclassified-as-spr",
  "image-url-malformed",
  "blank-artifact",
]);

type Row = AuditRow & {
  original_question_number: number | null;
  parsing_status: string | null;
};

async function loadAll(): Promise<Row[]> {
  const cols =
    "id, original_question_number, parsing_status, section, question_type, question_text, choices, correct_answer, explanation, has_image, image_urls, has_table";
  const all: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("questions").select(cols).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...(data as unknown as Row[]));
    if (data.length < 1000) break;
  }
  return all;
}

async function main() {
  // Imported here (not at top) so env is already in process.env when
  // lib/supabase captures NEXT_PUBLIC_SUPABASE_URL at module-load time.
  const { repairMathForQuestion, repairTableForQuestion, repairImageForQuestion } =
    await import("../lib/repair-ops");
  const all = await loadAll();
  const issues = all
    .map((r) => ({ r, failed: CHECKS.filter((c) => c.failed(r)).map((c) => c.id) }))
    .filter((x) => x.failed.length);
  console.log(`${all.length} questions; ${issues.length} with issues. APPLY=${APPLY}\n`);

  let fixed = 0,
    humanLeft = 0,
    demoted = 0;
  for (const { r, failed } of issues) {
    const tag = `Q${r.original_question_number ?? "?"} [${r.parsing_status}] (${failed.join(",")})`;
    const wantsTable = failed.some((f) => TABLE_CHECKS.has(f));
    const wantsMath = failed.some((f) => MATH_CHECKS.has(f));
    const wantsImage = failed.some((f) => IMAGE_CHECKS.has(f));
    const humanOnly = !wantsTable && !wantsMath && !wantsImage;

    if (!APPLY) {
      console.log(
        `${tag} → ${[
          wantsTable && "table",
          wantsMath && "math",
          wantsImage && "image",
          humanOnly && "HUMAN",
        ]
          .filter(Boolean)
          .join("+")}`,
      );
      continue;
    }

    const msgs: string[] = [];
    let anyOk = false;
    if (wantsTable) {
      const x = await repairTableForQuestion(r.id);
      msgs.push(`table:${x.ok ? "OK" : "no"}`);
      anyOk ||= x.ok;
    }
    if (wantsMath) {
      const x = await repairMathForQuestion(r.id);
      msgs.push(`math:${x.ok ? "OK" : "no"}`);
      anyOk ||= x.ok;
    }
    if (wantsImage) {
      const x = await repairImageForQuestion(r.id);
      msgs.push(`image:${x.ok ? "OK" : "no"}`);
      anyOk ||= x.ok;
    }
    if (anyOk) fixed++;

    // Re-audit the row from the DB; if it STILL fails any check and is
    // Approved, demote so a broken question never stays live.
    const { data: fresh } = await db
      .from("questions")
      .select(
        "id, original_question_number, parsing_status, section, question_type, question_text, choices, correct_answer, explanation, has_image, image_urls, has_table",
      )
      .eq("id", r.id)
      .single();
    const stillFailing = fresh
      ? CHECKS.filter((c) => c.failed(fresh as unknown as AuditRow)).map((c) => c.id)
      : failed;
    if (stillFailing.length && (fresh?.parsing_status ?? r.parsing_status) === "Approved") {
      await db
        .from("questions")
        .update({
          parsing_status: "Needs Review",
          parsing_notes: `Demoted by render audit: still failing → ${stillFailing.join(", ")}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      demoted++;
      msgs.push("DEMOTED");
    }
    if (humanOnly && stillFailing.length) humanLeft++;
    console.log(`${tag} → ${msgs.join(" ")}${stillFailing.length ? ` | stillFailing: ${stillFailing.join(",")}` : " | CLEAN"}`);
  }

  console.log(`\nDone. repaired=${fixed}, demoted-approved=${demoted}, human-only-left=${humanLeft}`);
}
main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
