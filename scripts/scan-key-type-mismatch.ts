// scripts/scan-key-type-mismatch.ts
//
// Find answer keys that don't fit their question type (lib/key-check.ts):
// fill-in (SPR) with a letter key / invalid SPR form / ignored rounding /
// leftover choices, Multiple choice with a non A–D key, and AI-solved keys
// whose explanation ends on a different answer. Prints a suggested-
// corrections list.
//
// Usage:
//   npx tsx scripts/scan-key-type-mismatch.ts                 # dry run (read-only, default)
//   npx tsx scripts/scan-key-type-mismatch.ts --json=out.json # also write findings as JSON
//   npx tsx scripts/scan-key-type-mismatch.ts --apply         # apply SAFE suggestions only
//
// --apply only touches rows that are NOT in a live test and have NO graded
// attempts (so nothing needs rescoring); it changes the key/type, moves the
// row to Needs Review (the explanation may argue the old key) and notes why.
// Everything else — live questions, anything students already answered —
// goes through the admin page /admin/questions/key-check, which previews the
// affected attempts and rescoring before you confirm.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";

for (const l of readFileSync(".env.local", "utf-8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const APPLY = process.argv.includes("--apply");
const JSON_OUT = process.argv.find((a) => a.startsWith("--json="))?.slice(7);

async function main() {
  const { scanKeyTypeMismatch } = await import("../lib/key-check");
  const { keyTypeProblem } = await import("../lib/answer-key");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const findings = await scanKeyTypeMismatch(db);
  const byCode: Record<string, number> = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${findings.length} finding(s)`);
  console.log(`by problem: ${JSON.stringify(byCode)}`);
  console.log(`with a suggested correction: ${findings.filter((f) => f.suggestion).length}; in a live test: ${findings.filter((f) => f.live).length}\n`);

  for (const f of findings) {
    const sug = f.suggestion
      ? [
          f.suggestion.question_type ? `type → ${f.suggestion.question_type}` : null,
          f.suggestion.correct_answer ? `key ${f.key ?? "∅"} → ${f.suggestion.correct_answer}` : null,
          f.suggestion.clear_choices ? "remove choices" : null,
        ]
          .filter(Boolean)
          .join(", ") + ` (${f.suggestionWhy})`
      : "no automatic suggestion — use AI suggestion on the review page";
    console.log(
      `${f.live ? "[LIVE] " : ""}${f.moduleName ?? f.moduleId} Q${f.number ?? "?"} [${f.status}] ${f.questionType ?? "?"} key=${JSON.stringify(f.key)}${f.officialAnswer ? ` official=${JSON.stringify(f.officialAnswer)}` : ""}\n    ${f.code}: ${f.reason}\n    suggestion: ${sug}\n    /admin/questions/${f.id}`,
    );
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(findings, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
  if (!APPLY) return;

  let applied = 0, skipped = 0;
  for (const f of findings) {
    if (!f.suggestion || f.live) {
      skipped++;
      continue;
    }
    const { count } = await db.from("answer_records").select("id", { count: "exact", head: true }).eq("question_id", f.id);
    if ((count ?? 0) > 0) {
      skipped++;
      continue;
    }
    const { data: row } = await db.from("questions").select("question_text, choices, correct_answer, question_type, parsing_notes").eq("id", f.id).single();
    if (!row || row.correct_answer !== f.key) {
      skipped++;
      continue;
    }
    const next = {
      question_type: f.suggestion.question_type ?? row.question_type,
      correct_answer: f.suggestion.correct_answer ?? row.correct_answer,
      choices: f.suggestion.clear_choices || f.suggestion.question_type === "Student Produced Response" ? [] : row.choices,
      question_text: row.question_text,
    };
    if (keyTypeProblem(next)) {
      skipped++;
      continue;
    }
    const note = `Needs review: key/type corrected by scan-key-type-mismatch (${f.code}: key ${f.key ?? "∅"} → ${next.correct_answer}, type ${next.question_type}) — check the explanation`;
    await db
      .from("questions")
      .update({
        ...next,
        parsing_status: "Needs Review",
        parsing_notes: row.parsing_notes ? `${row.parsing_notes}; ${note}` : note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", f.id);
    applied++;
  }
  console.log(`\napplied ${applied}, skipped ${skipped} (live, attempts, no suggestion or changed since the scan)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
