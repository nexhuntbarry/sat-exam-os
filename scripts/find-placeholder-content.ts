// scripts/find-placeholder-content.ts
//
// H-16 / L-06: Read-only audit script.
// Lists Approved questions whose choices or stem still contain:
//   1. Parser placeholder patterns — phrases that mean the image / figure
//      was not captured, e.g. "not visible", "partially visible",
//      "page cut off", "[bar chart]", "[graph]", "[table]", "[figure …]"
//   2. Stray "\ $" sequences — LaTeX protected-space artefacts that render
//      as a literal backslash-space-dollar in prose.
//
// Output: module name, question number, id, field (stem / choice label),
//         and a short snippet showing the offending text.
//
//   npx tsx scripts/find-placeholder-content.ts
//
// Read-only: no writes to the database.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envText = readFileSync(".env.local", "utf-8");
for (const l of envText.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Placeholder patterns from the brief (case-insensitive).
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /not visible/i,
  /partially visible/i,
  /page cut off/i,
  /\[\s*(?:bar chart|graph|table|figure)[^\]]*\]/i,
];

// Stray LaTeX protected-space before a dollar sign.
const STRAY_BACKSLASH_DOLLAR = /\\ \$/;

type Choice = { label: string; text: string };

interface Row {
  id: string;
  original_question_number: number | null;
  question_text: string | null;
  choices: unknown;
  parsing_status: string;
  modules: { module_name: string } | null;
}

interface Finding {
  module: string;
  question_number: number | null;
  id: string;
  field: string;
  issue: string;
  snippet: string;
}

function snippet(text: string): string {
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
}

function checkText(text: string): { issue: string } | null {
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(text)) return { issue: `placeholder match: ${re.source}` };
  }
  if (STRAY_BACKSLASH_DOLLAR.test(text)) return { issue: 'stray "\\ $" sequence' };
  return null;
}

async function main() {
  const PAGE = 1000;
  let from = 0;
  const rows: Row[] = [];

  for (;;) {
    const { data, error } = await db
      .from("questions")
      .select("id, original_question_number, question_text, choices, parsing_status, modules(module_name)")
      .eq("parsing_status", "Approved")
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("DB error:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as Row[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`Scanned ${rows.length} Approved questions.\n`);

  const findings: Finding[] = [];

  for (const row of rows) {
    const moduleName = row.modules?.module_name ?? "(unknown module)";

    // Check question stem.
    if (row.question_text) {
      const hit = checkText(row.question_text);
      if (hit) {
        findings.push({
          module: moduleName,
          question_number: row.original_question_number,
          id: row.id,
          field: "stem",
          issue: hit.issue,
          snippet: snippet(row.question_text),
        });
      }
    }

    // Check each choice text.
    const choices: Choice[] = Array.isArray(row.choices) ? (row.choices as Choice[]) : [];
    for (const choice of choices) {
      if (typeof choice.text !== "string") continue;
      const hit = checkText(choice.text);
      if (hit) {
        findings.push({
          module: moduleName,
          question_number: row.original_question_number,
          id: row.id,
          field: `choice ${choice.label}`,
          issue: hit.issue,
          snippet: snippet(choice.text),
        });
      }
    }
  }

  if (findings.length === 0) {
    console.log("No placeholder content or stray sequences found.");
    return;
  }

  console.log(`Found ${findings.length} issue(s):\n`);
  console.log(
    `${"Module".padEnd(42)}  ${"Q#".padStart(3)}  ${"Field".padEnd(12)}  Issue / Snippet`,
  );
  console.log("─".repeat(110));

  for (const f of findings) {
    const qn = f.question_number != null ? String(f.question_number).padStart(3) : "  ?";
    const mod = f.module.slice(0, 40).padEnd(42);
    const field = f.field.padEnd(12);
    console.log(`${mod}  ${qn}  ${field}  [${f.issue}]`);
    console.log(`  id: ${f.id}`);
    console.log(`  snippet: ${f.snippet}`);
    console.log();
  }

  console.log(`\nTotal: ${findings.length} finding(s) across ${rows.length} Approved questions.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
