// scripts/audit-render-issues.ts
//
// Run the same structural CHECKS the post-parse cleanup uses, but across
// EVERY question in the bank, and print a breakdown of how many rows fail
// each check (math-render-failed, has-table-flag-but-no-table,
// pipe-flattened-table, math-unwrapped, math-contains-prose, …) plus a
// sample of affected question numbers. Read-only — does not modify rows.
//
//   npx tsx scripts/audit-render-issues.ts
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { CHECKS, type AuditRow } from "../lib/post-parse-cleanup";

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

async function main() {
  // page through all questions
  const cols =
    "id, module_id, original_question_number, parsing_status, section, question_type, question_text, choices, correct_answer, explanation, has_image, image_urls, has_table, modules(module_name)";
  const all: (AuditRow & {
    module_id: string;
    original_question_number: number | null;
    parsing_status: string | null;
    modules?: { module_name?: string } | null;
  })[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("questions")
      .select(cols)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as typeof all));
    if (data.length < PAGE) break;
  }

  const tally: Record<string, typeof all> = {};
  let anyFail = 0;
  for (const row of all) {
    const failed = CHECKS.filter((c) => c.failed(row)).map((c) => c.id);
    if (failed.length) anyFail++;
    for (const id of failed) (tally[id] ??= []).push(row);
  }

  console.log(`\n=== Render/structure audit over ${all.length} questions ===`);
  console.log(`Rows with at least one issue: ${anyFail}\n`);
  const ids = Object.keys(tally).sort((a, b) => tally[b].length - tally[a].length);
  for (const id of ids) {
    const rows = tally[id];
    const sample = rows
      .slice(0, 8)
      .map((r) => `Q${r.original_question_number ?? "?"}`)
      .join(", ");
    console.log(`${String(rows.length).padStart(4)}  ${id}`);
    console.log(`        e.g. ${sample}${rows.length > 8 ? " …" : ""}`);
  }
  if (ids.length === 0) console.log("No issues found 🎉");

  // status breakdown of issue rows
  const byStatus: Record<string, number> = {};
  for (const id of ids)
    for (const r of tally[id]) {
      const s = r.parsing_status ?? "?";
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
  console.log("\n(issue rows by parsing_status, with double-counting):", byStatus);
}
main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
