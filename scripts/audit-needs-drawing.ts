// One-off audit pass: walk every Math question currently in Draft or
// Needs Review status, re-run the solver, and flag any that the solver
// self-reports as needing physical drawing (`needs_drawing=true`).
//
// Only TOUCHES rows that the solver flags as drawing-required:
//   - clears correct_answer (was a hallucination by definition)
//   - sets parsing_status = "Needs Review"
//   - replaces parsing_notes with a clear "needs drawing" message
//
// Rows that the solver answers cleanly are left alone — admins may
// have manually fixed them, and there's no reason to disturb a
// working answer.
//
// Usage:
//   npx tsx scripts/audit-needs-drawing.ts [--dry-run] [--limit=N]

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { solveQuestions } from "../lib/ai/solve-question";
import type { ParsedQuestion } from "../lib/ai/parse-pdf";

function loadEnv(file: string, overwrite = false) {
  try {
    const txt = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
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
loadEnv(".env");
// lib/supabase.ts expects `SUPABASE_URL` (not the NEXT_PUBLIC prefix)
// when running outside the Next.js runtime. Mirror it so logUsage
// doesn't spam the console with "supabaseUrl is required" warnings.
if (process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const limitFlag = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitFlag ? Math.max(1, parseInt(limitFlag.split("=")[1], 10) || 0) : Infinity;

const sb = createClient(url, key, { auth: { persistSession: false } });

interface Row {
  id: string;
  module_id: string;
  original_question_number: number;
  question_text: string;
  choices: Array<{ label: string; text: string }> | null;
  question_type: string;
  has_image: boolean | null;
  has_table: boolean | null;
  has_formula: boolean | null;
  image_urls: string[] | null;
  domain: string | null;
  skill: string | null;
  concept: string | null;
  difficulty: string | null;
  page_number: number | null;
  ai_confidence_score: number | null;
  parsing_status: string;
}

async function fetchMathRows(): Promise<Row[]> {
  // Pull every Draft / Needs Review math question. We filter the
  // result client-side because PostgREST doesn't let us join the
  // module section into the same response cleanly without
  // restructuring the select.
  const PAGE = 500;
  let from = 0;
  const out: Row[] = [];
  for (;;) {
    const { data, error } = await sb
      .from("questions")
      .select(
        "id, module_id, original_question_number, question_text, choices, question_type, has_image, has_table, has_formula, image_urls, domain, skill, concept, difficulty, page_number, ai_confidence_score, parsing_status, modules!module_id(section)",
      )
      .in("parsing_status", ["Draft", "Needs Review"])
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as unknown as (Row & { modules: { section: string } })[]) {
      if (r.modules?.section === "Math") {
        out.push(r);
        if (out.length >= LIMIT) return out;
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function toParsedQuestion(r: Row): ParsedQuestion {
  return {
    original_question_number: r.original_question_number,
    question_text: r.question_text,
    choices: (r.choices ?? []) as ParsedQuestion["choices"],
    correct_answer: null,
    explanation: null,
    difficulty: (r.difficulty ?? "Medium") as ParsedQuestion["difficulty"],
    domain: r.domain ?? "",
    skill: r.skill ?? "",
    concept: r.concept ?? "",
    question_type:
      r.question_type === "Student Produced Response"
        ? "Student Produced Response"
        : "Multiple Choice",
    has_image: Boolean(r.has_image),
    has_table: Boolean(r.has_table),
    has_formula: Boolean(r.has_formula),
    page_number: r.page_number ?? 1,
    ai_confidence_score: r.ai_confidence_score ?? 0.5,
    image_regions: [],
  };
}

async function main() {
  const rows = await fetchMathRows();
  console.log(`[audit] ${rows.length} math questions to scan${dryRun ? " (DRY RUN)" : ""}`);
  if (rows.length === 0) return;

  // Group by module so we can pass images per-module to solveQuestions
  // when they exist (skill-stats path).
  const byModule = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byModule.get(r.module_id) ?? [];
    arr.push(r);
    byModule.set(r.module_id, arr);
  }

  let flagged = 0;
  let answered = 0;
  let failed = 0;

  for (const [moduleId, modRows] of byModule) {
    const questions = modRows.map(toParsedQuestion);
    const imagesByQuestion = new Map<number, { urls: string[] }>();
    for (const r of modRows) {
      const urls = r.image_urls ?? [];
      if (urls.length > 0) {
        imagesByQuestion.set(r.original_question_number, { urls });
      }
    }
    console.log(`[audit] module ${moduleId.slice(0, 8)} — ${questions.length} questions`);
    const solved = await solveQuestions(questions, imagesByQuestion);

    for (const r of modRows) {
      const s = solved.get(r.original_question_number);
      if (!s) {
        failed++;
        continue;
      }
      if (s.needsDrawing) {
        flagged++;
        if (dryRun) {
          console.log(
            `[audit][DRY] flag q${r.original_question_number} mod=${moduleId.slice(0, 8)} — solver says needs drawing`,
          );
          continue;
        }
        const note =
          "Solver flagged this question as requiring drawing/constructing a figure to solve. AI cannot answer — please solve and enter the answer manually.";
        const { error } = await sb
          .from("questions")
          .update({
            correct_answer: null,
            parsing_status: "Needs Review",
            parsing_notes: note.slice(0, 1000),
          })
          .eq("id", r.id);
        if (error) {
          failed++;
          console.warn(`[audit] ${r.id}: ${error.message}`);
        }
      } else {
        answered++;
      }
    }
  }

  console.log(
    `[audit] done: ${flagged} flagged needs_drawing, ${answered} answered cleanly (untouched), ${failed} failed`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
