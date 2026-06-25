// scripts/audit-bug-reports.ts
//
// "Did the AI actually fix what the user reported?"
//
// Lists recent user bug_reports and, for each, re-runs the structural
// CHECKS against the current question to show whether the underlying
// defect is genuinely gone. Flags the dangerous case: a report marked
// `resolved` whose question STILL fails a check (the auto-resolver
// closed it without really fixing it). Read-only.
//
//   npx tsx scripts/audit-bug-reports.ts          # last 25 reports
//   npx tsx scripts/audit-bug-reports.ts 100      # last 100
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const LIMIT = Number(process.argv[2] ?? 25);
const envText = readFileSync(".env.local", "utf-8");
for (const l of envText.split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  const { CHECKS } = (await import("../lib/post-parse-cleanup")) as unknown as {
    CHECKS: { id: string; failed: (r: unknown) => boolean }[];
  };
  const { data: reports } = await db
    .from("bug_reports")
    .select("id, question_id, note, status, created_at, resolved_at")
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  const QCOLS =
    "original_question_number, parsing_status, section, question_type, correct_answer, has_image, image_urls, has_table, question_text, choices, explanation";
  let falseResolved = 0;
  let openBroken = 0;
  for (const r of reports ?? []) {
    const { data: q } = await db
      .from("questions")
      .select(QCOLS)
      .eq("id", r.question_id)
      .maybeSingle();
    const fails = q ? CHECKS.filter((c) => c.failed(q)).map((c) => c.id) : ["(question deleted)"];
    const clean = fails.length === 0;
    const flag =
      r.status === "resolved" && !clean
        ? "  ⚠️ RESOLVED-BUT-STILL-BROKEN"
        : !clean
          ? "  ⛔ still broken"
          : "  ✓ clean";
    if (r.status === "resolved" && !clean) falseResolved++;
    if (r.status !== "resolved" && !clean) openBroken++;
    console.log(
      `[${r.status}] Q${q?.original_question_number ?? "?"} (${q?.parsing_status ?? "?"}) ${String(r.created_at).slice(0, 16)}${flag}`,
    );
    if (r.note) console.log(`    note: ${r.note}`);
    if (!clean) console.log(`    checks failing: ${fails.join(", ")}`);
  }
  console.log(
    `\n${reports?.length ?? 0} reports · resolved-but-still-broken: ${falseResolved} · open+broken: ${openBroken}`,
  );
  if (falseResolved) {
    console.log(
      "⚠️ Some reports were auto-closed without the defect being fixed — investigate those questions.",
    );
  }
}
main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
