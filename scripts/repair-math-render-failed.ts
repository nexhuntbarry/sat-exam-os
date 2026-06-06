// scripts/repair-math-render-failed.ts
//
// For every question still parked in Needs Review with a
// "math-render-failed" note, send the source PDF page back to
// Claude with the tightened single-source-of-truth formatting
// rules and ask for a clean re-extraction of question_text +
// choices + explanation. Then validate the result locally
// (every $...$ region must round-trip through KaTeX, no stray
// `\<digit>`, no doubly-escaped wraps) and only then write back.
//
// Usage:
//   npx tsx scripts/repair-math-render-failed.ts                  # dry-run
//   npx tsx scripts/repair-math-render-failed.ts --apply
//   npx tsx scripts/repair-math-render-failed.ts --apply --question=<uuid>

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import katex from "katex";

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

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const apply = process.argv.includes("--apply");
const questionArg = process.argv.find((a) => a.startsWith("--question="));

const SYSTEM = `You are re-extracting one SAT question from a PDF. The previous parser run produced text that the KaTeX renderer refused to display. Output a clean replacement.

For every numeric token you write, choose one form and stick to it:
(a) Pure value (180, 45, 1,150, -12, 0.33) — write BARE. No $, no \\$, no backslash.
(b) Currency in prose (\\$5 admission, \\$1,150 fee) — write \\$<digits>. Never wrap in $...$.
(c) Math expression (operator / variable / fraction / root / LaTeX command) — wrap in $...$ inline or $$...$$ display.
(d) Mixed currency + math — each piece by its own rule.

Hard rules:
- NEVER write "\\3", "\\10", "\\13", "\\47" or any backslash-then-digit. There is no LaTeX \\3 macro.
- NEVER write "\\$<digit>$" (doubly-escaped wrap). Pick form (a) or (c).
- Every $ in a field must have a matching closing $ in the SAME field. Currency $ must be escaped as \\$.
- Every $...$ region must contain a real math expression — NOT a number alone, NOT English prose.
- For Multiple Choice, return exactly four choices labelled A, B, C, D.

Return JSON only.`;

const QSchema = z.object({
  question_text: z.string(),
  choices: z
    .array(z.object({ label: z.enum(["A", "B", "C", "D"]), text: z.string() }))
    .optional(),
  explanation: z.string().optional(),
});

function isMathClean(text: string): { ok: boolean; reason?: string } {
  if (!text) return { ok: true };
  if (/(^|[^\\$])\\\d/.test(text)) return { ok: false, reason: "\\<digit> macro" };
  if (/(^|[^\\])\\\$[^$\n]{1,25}?\$/.test(text))
    return { ok: false, reason: "doubly-escaped wrap" };
  // Strip escaped dollars (`\$`) so naive `\$...\$` pairing doesn't
  // false-flag legitimate currency-plus-math fields.
  const sanitized = text.replace(/\\\$/g, "\x00");
  const dollars = (sanitized.match(/\$/g) ?? []).length;
  if (dollars % 2 !== 0) return { ok: false, reason: "odd $ count" };
  const display = sanitized.match(/\$\$([\s\S]*?)\$\$/g) ?? [];
  for (const b of display) {
    const e = b.slice(2, -2);
    if (!e.trim()) continue;
    try {
      katex.renderToString(e, { throwOnError: true, displayMode: true });
    } catch {
      return { ok: false, reason: `KaTeX display fail: ${e.slice(0, 30)}` };
    }
  }
  const inline = sanitized
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .match(/\$([^$\n]+)\$/g) ?? [];
  for (const b of inline) {
    const e = b.slice(1, -1);
    if (!e.trim()) continue;
    try {
      katex.renderToString(e, { throwOnError: true, displayMode: false });
    } catch {
      return { ok: false, reason: `KaTeX inline fail: ${e.slice(0, 30)}` };
    }
  }
  return { ok: true };
}

async function fetchPdfBase64(url: string): Promise<string> {
  const headers: Record<string, string> = {};
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

interface Row {
  id: string;
  module_id: string;
  original_question_number: number | null;
  source_pdf_url: string | null;
  question_type: string | null;
  question_text: string | null;
  choices: Array<{ label: string; text: string }> | null;
  explanation: string | null;
  page_number: number | null;
}

async function repairOne(row: Row): Promise<{ ok: boolean; reason?: string }> {
  if (!row.source_pdf_url) return { ok: false, reason: "no pdf url" };
  const pdfBase64 = await fetchPdfBase64(row.source_pdf_url);
  let lastReason = "";
  // Three escalating attempts: Haiku → Sonnet → Opus. The cheap
  // model handles the easy 90%; the smarter ones are reserved for
  // the questions where currency-runaway slips through.
  const ladder = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-7",
  ] as const;
  for (let attempt = 0; attempt < ladder.length; attempt++) {
    const result = await generateObject({
      model: anthropic(ladder[attempt]),
      schema: QSchema,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: pdfBase64, mediaType: "application/pdf" },
            {
              type: "text",
              text: `Re-extract question ${row.original_question_number ?? "?"} (page ${row.page_number ?? "?"}) from this PDF.\n\nCurrent stored text (rendering broken — use this only as context, fix the formatting):\n\nquestion_text: ${row.question_text}\n\nchoices: ${JSON.stringify(row.choices)}\n\nexplanation: ${row.explanation}\n\nReturn cleaned question_text${row.question_type === "Multiple Choice" ? " + 4 choices" : ""} + explanation.${
                attempt > 0
                  ? `\n\nPrior attempt failed math-render check (${lastReason}). Be stricter — currency MUST be \\$, math expressions MUST balance their $ pairs, NEVER use \\<digit>.`
                  : ""
              }`,
            },
          ],
        },
      ],
    });

    const q = result.object;
    const checks: Array<{ field: string; text: string }> = [
      { field: "question_text", text: q.question_text },
    ];
    if (q.explanation) checks.push({ field: "explanation", text: q.explanation });
    for (const c of q.choices ?? []) {
      checks.push({ field: `choice ${c.label}`, text: c.text });
    }
    let failed: string | null = null;
    for (const f of checks) {
      const r = isMathClean(f.text);
      if (!r.ok) {
        failed = `${f.field}: ${r.reason}`;
        break;
      }
    }
    if (failed) {
      lastReason = failed;
      continue;
    }

    // Clean — write back.
    if (!apply) {
      console.log(
        `  Q${row.original_question_number}: would update (${checks.length} field(s) clean)`,
      );
      return { ok: true };
    }
    const update: Record<string, unknown> = {
      question_text: q.question_text,
      parsing_status: "Draft",
      parsing_notes: "Re-extracted by repair-math-render-failed. Re-review before approve.",
      updated_at: new Date().toISOString(),
    };
    if (q.explanation) update.explanation = q.explanation;
    if (q.choices && q.choices.length > 0) update.choices = q.choices;
    const { error: upErr } = await sb
      .from("questions")
      .update(update)
      .eq("id", row.id);
    if (upErr) {
      console.log(`  Q${row.original_question_number}: write fail — ${upErr.message}`);
      return { ok: false, reason: upErr.message };
    }
    console.log(
      `  Q${row.original_question_number}: repaired (attempt ${attempt + 1})`,
    );
    return { ok: true };
  }
  console.log(
    `  Q${row.original_question_number}: ${ladder.length} attempts (Haiku → Sonnet → Opus) all failed math-render (last: ${lastReason})`,
  );
  return { ok: false, reason: lastReason };
}

async function main() {
  let query = sb
    .from("questions")
    .select(
      "id, module_id, original_question_number, source_pdf_url, question_type, question_text, choices, explanation, page_number",
    )
    .eq("parsing_status", "Needs Review")
    .like("parsing_notes", "%math-render-failed%");
  if (questionArg) {
    query = sb
      .from("questions")
      .select(
        "id, module_id, original_question_number, source_pdf_url, question_type, question_text, choices, explanation, page_number",
      )
      .eq("id", questionArg.split("=")[1]);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) {
    console.log("No rows match.");
    return;
  }
  if (!apply) console.log("DRY-RUN: pass --apply to mutate.");
  console.log(`Targeting ${rows.length} row(s).\n`);
  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    try {
      const res = await repairOne(r);
      if (res.ok) ok++;
      else fail++;
    } catch (e) {
      fail++;
      console.log(
        `  Q${r.original_question_number}: ERROR — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  console.log(`\nDone. ${ok}/${rows.length} repaired, ${fail} stuck.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
