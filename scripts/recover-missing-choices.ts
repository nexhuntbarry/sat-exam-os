// scripts/recover-missing-choices.ts
//
// Re-extract answer choices for Multiple Choice questions whose
// choices array landed empty in the first parser pass. Targets every
// MCQ row with parsing_status='Needs Review' and choices=[] / null.
//
// For each row: fetches the question's source_pdf_url (single-page
// blob), sends it to Claude with the row's question_text as context,
// asks for the four labelled options A/B/C/D verbatim, and writes the
// result back into the row's choices column. Status stays at Needs
// Review so a human still has to verify before promote.
//
// Usage:
//   npx tsx scripts/recover-missing-choices.ts             # dry-run
//   npx tsx scripts/recover-missing-choices.ts --apply

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

function loadEnv(file: string, overwrite: boolean) {
  try {
    const body = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of body.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (overwrite || !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}
loadEnv(".env.local", true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
if (!supabaseUrl || !supabaseKey || !process.env.ANTHROPIC_API_KEY) {
  console.error("Missing env (Supabase or ANTHROPIC_API_KEY)");
  process.exit(1);
}

const apply = process.argv.includes("--apply");

const ChoicesSchema = z.object({
  choices: z
    .array(z.object({ label: z.enum(["A", "B", "C", "D"]), text: z.string() }))
    .describe(
      "The four answer choices for the multiple-choice question on this page, in order A, B, C, D. Copy verbatim from the PDF — preserve punctuation, capitalization, and any math formatting.",
    ),
});

const SYSTEM = `You are extracting answer choices for a single SAT Reading & Writing multiple-choice question from a PDF page. The question stem is given to you separately; you only need to return the four A/B/C/D options verbatim from the page.

Rules:
- Copy each choice text character-for-character. Do not paraphrase, do not normalize quotes, do not add or remove punctuation.
- Wrap any math expressions in $...$ delimiters per project convention (e.g. "$\\frac{1}{7}$"). For pure-prose R&W choices there will rarely be math.
- Return exactly four entries: A, B, C, D, in that order.
- If the page truly has fewer than four visible choices, fail by returning whatever you can see — the downstream system will surface this.`;

async function fetchPdfBase64(url: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (blobToken) headers.Authorization = `Bearer ${blobToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

async function extractChoices(pdfBase64: string, stem: string, qNum: number) {
  const result = await generateObject({
    model: anthropic("claude-sonnet-4-6"),
    schema: ChoicesSchema,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: pdfBase64, mediaType: "application/pdf" },
          {
            type: "text",
            text: `Question ${qNum} on this page. The stem of the question is:\n\n${stem}\n\nReturn the four answer choices A/B/C/D verbatim from the page. Output JSON matching the schema.`,
          },
        ],
      },
    ],
  });
  return result.object.choices;
}

async function main() {
  const sb = createClient(supabaseUrl!, supabaseKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await sb
    .from("questions")
    .select(
      "id, original_question_number, question_text, source_pdf_url, page_number",
    )
    .eq("question_type", "Multiple Choice")
    .eq("parsing_status", "Needs Review")
    .or("choices.is.null,choices.eq.[]");
  if (error) {
    console.error("[recover] select failed:", error);
    process.exit(1);
  }
  const rows = data ?? [];
  console.log(`[recover] candidates=${rows.length} apply=${apply}`);

  let patched = 0;
  let skipped = 0;
  for (const q of rows) {
    if (!q.source_pdf_url) {
      console.log(`  ⤳ Q${q.original_question_number} ${q.id} — no source_pdf_url, skip`);
      skipped++;
      continue;
    }
    try {
      const pdfBase64 = await fetchPdfBase64(q.source_pdf_url);
      const choices = await extractChoices(
        pdfBase64,
        q.question_text ?? "",
        q.original_question_number ?? 0,
      );
      if (choices.length < 2) {
        console.log(
          `  ⤳ Q${q.original_question_number} ${q.id} — extractor returned ${choices.length} choices, skip`,
        );
        skipped++;
        continue;
      }
      console.log(
        `  ✓ Q${q.original_question_number} ${q.id} — extracted ${choices.length} choices: ${choices.map((c) => c.label + "=" + c.text.slice(0, 30)).join(" | ")}`,
      );
      if (!apply) continue;
      const { error: upErr } = await sb
        .from("questions")
        .update({
          choices,
          parsing_notes:
            "Choices re-extracted by scripts/recover-missing-choices.ts. Verify correct_answer still maps to the right letter, then promote to Approved.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", q.id);
      if (upErr) {
        console.error(`    ! update failed for ${q.id}:`, upErr.message);
        skipped++;
        continue;
      }
      patched++;
    } catch (e) {
      console.error(
        `  ! Q${q.original_question_number} ${q.id} — error:`,
        e instanceof Error ? e.message : e,
      );
      skipped++;
    }
  }
  console.log(`[recover] done. patched=${patched} skipped=${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
