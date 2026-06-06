// scripts/validate-new-prompt.ts
//
// Runs the parser against a known-broken PDF and checks every
// output field for the math/dollar/digit failure patterns the new
// prompt is supposed to eliminate. Fails loudly if any pattern
// shows up so we don't ship a prompt rewrite that reintroduces
// the very bugs we just cleaned up.
//
// Usage:
//   npx tsx scripts/validate-new-prompt.ts --module=<uuid>
//
// Picks the module's source PDF, re-parses it (without writing to
// the DB) and prints any field that violates any of these rules:
//
//   R1  no "$<bare number>$" (pure-numeric math wrap)
//   R2  no "\$<bare number>$" (doubly-escaped math wrap)
//   R3  no "\<digit>" outside a "\$" prefix (invalid backslash-digit)
//   R4  unescaped "$" count must be EVEN in each field
//   R5  every $...$ region must render through KaTeX
//
// Designed to run on ONE module at a time so the AI cost stays
// bounded (~30 questions, ~1-2 minutes).

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import katex from "katex";
import {
  parsePdfToQuestions,
  type ModuleMetadata,
  type ParsedQuestion,
} from "../lib/ai/parse-pdf";

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

interface FieldRef {
  qn: number;
  field: string;
  text: string;
}

function violations(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;

  // R1: pure-numeric math wrap.
  if (/(^|[^\\])\$\s*-?\d[\d,]*(?:\.\d+)?\s*\$/.test(text)) {
    out.push("R1 pure-numeric `$N$` wrap");
  }
  // R2: doubly-escaped math wrap. Cap content at 25 chars so a
  // legit currency reference in the same field as a later real
  // math region doesn't false-positive (`\$600 ... $B(x)$`).
  if (/(^|[^\\])\\\$[^$\n]{1,25}?\$/.test(text)) {
    out.push("R2 doubly-escaped `\\$X$` wrap");
  }
  // R3: backslash directly before digit, but allow `\$<digit>`.
  if (/(^|[^\\$])\\\d/.test(text)) {
    out.push("R3 invalid `\\<digit>` escape");
  }
  // R4: unescaped $ count must be even per field.
  const unescapedDollars = (text.match(/(^|[^\\])\$/g) ?? []).length;
  if (unescapedDollars % 2 !== 0) {
    out.push(`R4 odd unescaped $ count (${unescapedDollars})`);
  }
  // R5: KaTeX renders every $...$ region.
  const displayBlocks = text.match(/\$\$([\s\S]*?)\$\$/g) ?? [];
  for (const block of displayBlocks) {
    const expr = block.slice(2, -2);
    if (!expr.trim()) continue;
    try {
      katex.renderToString(expr, { throwOnError: true, displayMode: true });
    } catch (e) {
      out.push(`R5 KaTeX display fail: ${expr.slice(0, 40)}…`);
    }
  }
  const inlineSrc = text.replace(/\$\$[\s\S]*?\$\$/g, " ");
  const inlineBlocks = inlineSrc.match(/\$([^$\n]+)\$/g) ?? [];
  for (const block of inlineBlocks) {
    const expr = block.slice(1, -1);
    if (!expr.trim()) continue;
    try {
      katex.renderToString(expr, { throwOnError: true, displayMode: false });
    } catch (e) {
      out.push(`R5 KaTeX inline fail: ${expr.slice(0, 40)}…`);
    }
  }
  return out;
}

async function main() {
  const moduleArg = process.argv.find((a) => a.startsWith("--module="));
  const moduleId = moduleArg?.split("=")[1];
  if (!moduleId) {
    console.error("Pass --module=<uuid>");
    process.exit(1);
  }

  const { data: mod } = await sb
    .from("modules")
    .select("id, module_name, pdf_url, section, module_number, difficulty")
    .eq("id", moduleId)
    .maybeSingle();
  if (!mod || !mod.pdf_url) {
    console.error("Module not found or missing pdf_url");
    process.exit(1);
  }

  console.log(`Validating new prompt against: ${mod.module_name}`);
  console.log(`(this re-parses the PDF; ~1-2 min, no DB writes)\n`);

  const metadata: ModuleMetadata = {
    section: mod.section as "Math" | "Reading & Writing",
    difficulty_hint: (mod.difficulty as "Easy" | "Medium" | "Hard" | "Mixed") ?? "Mixed",
    moduleNumber: (mod.module_number as number) ?? null,
  };
  const questions: ParsedQuestion[] = await parsePdfToQuestions(mod.pdf_url, metadata);

  // Walk every field of every question through the violation rules.
  const flagged: Array<{ qn: number; field: string; viols: string[]; preview: string }> = [];
  for (const q of questions) {
    const checks: FieldRef[] = [
      { qn: q.original_question_number ?? 0, field: "question_text", text: q.question_text ?? "" },
      { qn: q.original_question_number ?? 0, field: "explanation", text: q.explanation ?? "" },
      { qn: q.original_question_number ?? 0, field: "correct_answer", text: q.correct_answer ?? "" },
    ];
    if (Array.isArray(q.choices)) {
      for (const c of q.choices as Array<{ label: string; text: string }>) {
        checks.push({
          qn: q.original_question_number ?? 0,
          field: `choice ${c.label}`,
          text: c.text ?? "",
        });
      }
    }
    for (const ref of checks) {
      const viols = violations(ref.text);
      if (viols.length === 0) continue;
      flagged.push({
        qn: ref.qn,
        field: ref.field,
        viols,
        preview: ref.text,
      });
    }
  }

  console.log(`Parsed ${questions.length} questions.\n`);
  if (flagged.length === 0) {
    console.log("✅ ALL FIELDS PASS — prompt is safe to ship.");
    return;
  }
  console.log(`❌ ${flagged.length} field(s) FAILED:`);
  for (const f of flagged.slice(0, 50)) {
    console.log(`  Q${f.qn} ${f.field}: ${f.viols.join(", ")}`);
    console.log(`    full: ${JSON.stringify(f.preview.length === 110 ? f.preview + "…" : f.preview)}`);
  }
  if (flagged.length > 50) {
    console.log(`  …and ${flagged.length - 50} more.`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
