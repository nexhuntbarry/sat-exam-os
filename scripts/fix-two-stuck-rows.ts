// scripts/fix-two-stuck-rows.ts
//
// Manual fix for the two rows the sweep couldn't auto-resolve:
//   Q9  October 2024 SAT Math Module 1 — math-contains-prose
//   Q13 RW Module 001 Test           — has-table-flag-but-no-table-in-text
//
// Q9  is a clean hand-edit (escape the lone bare "$230" in the
//      explanation so the renderer stops pairing it with the inline
//      `$\frac{4}{5}$` and swallowing "and").
// Q13 needs the source table embedded in question_text. We call
//      Claude with the PDF page and ask for a markdown table, then
//      splice it in front of the existing question prompt.
//
// Run:
//   set -a && source .env.local && set +a && npx tsx scripts/fix-two-stuck-rows.ts --apply

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

function loadEnv(file: string) {
  try {
    const body = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of body.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv(".env.local");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const apply = process.argv.includes("--apply");

const Q9_ID = "20b0f6d8-cdd4-4be7-a998-1d3b105e426c";
const Q13_ID = "e003f792-d17d-41ed-81a9-4f14be6a76ee";

async function fixQ9() {
  // Source of truth: AI re-extraction keeps emitting bare `$230` in
  // the explanation, which pairs with `$\frac{4}{5}$` and gobbles up
  // the word "and" — that's what triggers the math-contains-prose
  // audit check. Just escape the currency dollar sign by hand.
  const cleanQuestion =
    "Charles saves $\\frac{4}{5}$ of the \\$230 he earns each week from his summer job. If Charles continues to save at this rate, how much money, in dollars, will Charles save in 3 weeks?";
  const cleanExplanation =
    "Charles earns \\$230 per week and saves $\\frac{4}{5}$ of that each week.\n\nWeekly savings: $\\frac{4}{5} \\times 230 = \\frac{920}{5} = 184$ dollars per week.\n\nOver 3 weeks: $184 \\times 3 = 552$ dollars.\n\nFinal answer: 552";

  console.log("Q9 plan:");
  console.log("  question_text =", cleanQuestion);
  console.log("  explanation   =", cleanExplanation);

  if (!apply) return;
  const { error } = await sb
    .from("questions")
    .update({
      question_text: cleanQuestion,
      explanation: cleanExplanation,
      parsing_status: "Approved",
      parsing_notes:
        "Hand-fixed: escaped lone \\$230 in explanation that was pairing with $\\frac{4}{5}$ and tripping the math-contains-prose audit.",
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", Q9_ID);
  if (error) throw new Error(`Q9 update: ${error.message}`);
  console.log("Q9: APPROVED");
}

const TableSchema = z.object({
  table_markdown: z.string().describe("Markdown table with header row + separator + body rows"),
  notes: z.string().optional(),
});

async function fixQ13() {
  const { data: row, error } = await sb
    .from("questions")
    .select("id, source_pdf_url, page_number, question_text, choices, explanation")
    .eq("id", Q13_ID)
    .maybeSingle();
  if (error || !row) throw new Error("Q13 fetch failed");

  const pdfRes = await fetch(row.source_pdf_url as string, {
    headers: process.env.BLOB_READ_WRITE_TOKEN
      ? { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
      : undefined,
  });
  if (!pdfRes.ok) throw new Error(`PDF fetch ${pdfRes.status}`);
  const pdfBase64 = Buffer.from(await pdfRes.arrayBuffer()).toString("base64");

  const result = await generateObject({
    model: anthropic("claude-opus-4-7"),
    schema: TableSchema,
    system:
      "Extract one table from the given SAT PDF page. Output a clean GitHub-flavored markdown table. Header row, separator row of dashes, then body rows. Use \\$ (escaped) for dollar amounts so the math renderer leaves them alone. Do not output anything other than the table fields.",
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: pdfBase64, mediaType: "application/pdf" },
          {
            type: "text",
            text: `Question ${13} sits on page ${row.page_number ?? "?"}. The journalist's-claim question references a table of films with columns like Film, Opening weekend, Lifetime earnings, Oscar recognition. Extract that table verbatim from the PDF. Use markdown.`,
          },
        ],
      },
    ],
  });

  const table = result.object.table_markdown.trim();
  const newText = `${table}\n\nWhich choice best describes data from the table that support the journalist's claim?`;

  // Earlier vision pass mis-OCR'd Huevos' opening weekend as
  // \$3,124,702. Two independent Opus re-reads of the PDF both
  // return \$3,424,702 (1 → 4). Patch the choice + explanation so
  // the numbers line up with the embedded table.
  const fixedChoices = (row.choices as Array<{ label: string; text: string }>).map((c) => ({
    ...c,
    text: c.text.replace(/3,124,702/g, "3,424,702"),
  }));
  const fixedExplanation = (row.explanation as string).replace(/3,124,702/g, "3,424,702");

  console.log("\nQ13 plan:");
  console.log("---- new question_text ----");
  console.log(newText);
  console.log("---- choice digit patch ----");
  console.log("3,124,702 → 3,424,702 in choice B + explanation");
  console.log("---------------------------");

  if (!apply) return;
  const { error: upErr } = await sb
    .from("questions")
    .update({
      question_text: newText,
      choices: fixedChoices,
      explanation: fixedExplanation,
      parsing_status: "Approved",
      parsing_notes:
        "Hand-fixed: embedded the source-table markdown the parser dropped, and corrected Huevos' opening weekend (1→4) so the choices match the table.",
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", Q13_ID);
  if (upErr) throw new Error(`Q13 update: ${upErr.message}`);
  console.log("Q13: APPROVED");
}

async function main() {
  await fixQ9();
  await fixQ13();
  console.log(`\nDone. apply=${apply}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
