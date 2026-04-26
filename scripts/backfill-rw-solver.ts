import { createClient } from "@supabase/supabase-js";
import { solveQuestionsAndPersist } from "../lib/ai/solve-question";
import type { ParsedQuestion } from "../lib/ai/parse-pdf";

const MODULE_ID = "86f950a0-e43a-4366-b92f-754a10f45fce";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const db = createClient(url, key);
  const { data: rows, error } = await db
    .from("questions")
    .select("original_question_number, question_text, choices, question_type, image_urls")
    .eq("module_id", MODULE_ID)
    .order("original_question_number");
  if (error) throw error;
  console.log(`fetched ${rows!.length} questions`);
  const parsed: ParsedQuestion[] = (rows ?? []).map((r) => ({
    original_question_number: r.original_question_number,
    question_text: r.question_text,
    choices: r.choices ?? [],
    correct_answer: null,
    explanation: null,
    difficulty: "Medium" as const,
    domain: "",
    skill: "",
    concept: "",
    question_type: r.question_type as ParsedQuestion["question_type"],
    has_image: false,
    has_table: false,
    has_formula: false,
    page_number: 1,
    ai_confidence_score: 1,
    image_regions: [],
  } as ParsedQuestion));
  const imagesByQuestion = new Map();
  for (const r of rows ?? []) {
    if (Array.isArray(r.image_urls) && r.image_urls.length > 0) {
      imagesByQuestion.set(r.original_question_number, { urls: r.image_urls });
    }
  }
  const t0 = Date.now();
  const stats = await solveQuestionsAndPersist(parsed, imagesByQuestion, MODULE_ID, db as any, undefined);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`done ${elapsed}s — solved=${stats.solved} failed=${stats.failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
