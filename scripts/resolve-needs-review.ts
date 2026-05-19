// One-off: re-run the AI solver on every "Needs Review" row that has no
// correct_answer. Used after the cleanup pass that nulled 34 answers —
// the new policy is to keep an AI guess on every row (flagged NR for
// admin verification) instead of leaving it empty.
//
// Usage:
//   npx tsx scripts/resolve-needs-review.ts [--dry-run]

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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
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
  image_alts: string[] | null;
  domain: string | null;
  skill: string | null;
  concept: string | null;
  difficulty: string | null;
  page_number: number | null;
  ai_confidence_score: number | null;
  parsing_notes: string | null;
}

async function fetchRows(): Promise<Row[]> {
  const { data, error } = await sb
    .from("questions")
    .select(
      "id, module_id, original_question_number, question_text, choices, question_type, has_image, has_table, has_formula, image_urls, image_alts, domain, skill, concept, difficulty, page_number, ai_confidence_score, parsing_notes",
    )
    .eq("parsing_status", "Needs Review")
    .is("correct_answer", null);
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
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
  const rows = await fetchRows();
  console.log(`[resolve] ${rows.length} Needs Review rows with null answer${dryRun ? " (DRY RUN)" : ""}`);
  if (rows.length === 0) return;
  if (dryRun) {
    for (const r of rows.slice(0, 10)) {
      console.log(`  Q${r.original_question_number} mod=${r.module_id.slice(0, 8)} type=${r.question_type} has_image=${r.has_image} imgs=${(r.image_urls ?? []).length}`);
    }
    return;
  }

  // Group by module so solveQuestions can reuse one images map per module.
  const byModule = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byModule.get(r.module_id) ?? [];
    arr.push(r);
    byModule.set(r.module_id, arr);
  }

  let ok = 0;
  let fail = 0;
  for (const [moduleId, modRows] of byModule) {
    const questions = modRows.map(toParsedQuestion);
    const imagesByQuestion = new Map<number, { urls: string[] }>();
    for (const r of modRows) {
      const urls = r.image_urls ?? [];
      if (urls.length > 0) {
        imagesByQuestion.set(r.original_question_number, { urls });
      }
    }
    console.log(`[resolve] module ${moduleId.slice(0, 8)} — ${questions.length} questions`);
    const solved = await solveQuestions(questions, imagesByQuestion);
    for (const r of modRows) {
      const s = solved.get(r.original_question_number);
      if (!s) {
        fail++;
        continue;
      }
      // Apply the same gates as solveQuestionsAndPersist so any new
      // failures land NR (which they already are).
      const declared = s.correct_answer ?? "";
      const isSPR = r.question_type === "Student Produced Response";
      const sprLetter = isSPR && /^[A-D]$/i.test(declared.trim());
      const blindImage = Boolean(r.has_image) && (r.image_urls ?? []).length === 0;
      let saved = s.correct_answer;
      if (sprLetter && s.explainedAnswer && !/^[A-D]$/i.test(s.explainedAnswer.trim())) {
        saved = s.explainedAnswer;
      }
      const noteParts: string[] = [];
      if (blindImage) noteParts.push("has_image=true but no image uploaded — verify against PDF.");
      if (sprLetter) noteParts.push(`Solver returned letter "${declared}" on SPR${saved !== declared ? `; substituted "${saved}"` : ""}. Verify.`);
      if (s.consistencyMismatch) noteParts.push(`Solver self-contradicts: declared ${declared}, explained ${s.explainedAnswer ?? "<unparsed>"}. Verify.`);
      const notes = noteParts.length > 0 ? noteParts.join(" ") : "Answer regenerated by cleanup pass — please verify.";
      const { error } = await sb
        .from("questions")
        .update({
          correct_answer: saved,
          explanation: s.explanation,
          parsing_notes: notes.slice(0, 1000),
          parsing_status: "Needs Review",
        })
        .eq("id", r.id);
      if (error) {
        fail++;
        console.warn(`[resolve] ${r.id}: ${error.message}`);
      } else {
        ok++;
      }
    }
  }
  console.log(`[resolve] done: ${ok} updated, ${fail} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
