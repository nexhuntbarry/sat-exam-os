// Dump every question in the latest module whose explanation
// trailer disagrees with the stored correct_answer. Mirrors the
// audit's `explanation-final-mismatch` heuristic so we can see
// the actual broken rows without hitting the admin UI.

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

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

function letterFromTrailer(expl: string | null): string | null {
  if (!expl) return null;
  const m = expl.match(/Final answer:\s*([^\n]+)/i);
  if (!m) return null;
  return m[1].trim().replace(/[.,;)]+$/, "") || null;
}

async function main() {
  const target = process.argv[2];
  let moduleId = target;
  if (!moduleId) {
    const { data: mods } = await sb
      .from("modules")
      .select("id, module_name")
      .order("created_at", { ascending: false })
      .limit(1);
    moduleId = mods?.[0]?.id;
    console.log(
      `Latest module: ${mods?.[0]?.module_name} (${moduleId}); pass a UUID to target another.`,
    );
  }
  if (!moduleId) return;
  const { data: qs } = await sb
    .from("questions")
    .select(
      "id, original_question_number, correct_answer, explanation, parsing_status, parsing_notes",
    )
    .eq("module_id", moduleId)
    .order("original_question_number", { ascending: true });
  let mismatches = 0;
  for (const q of qs ?? []) {
    const trailer = letterFromTrailer(q.explanation as string | null);
    const stored = (q.correct_answer ?? "").trim();
    if (!trailer) continue;
    let mismatch = false;
    if (/^[A-D]$/i.test(trailer) && /^[A-D]$/i.test(stored)) {
      mismatch = trailer.toUpperCase() !== stored.toUpperCase();
    } else {
      const tNum = parseFloat(trailer.replace(/[,]/g, ""));
      const sNum = parseFloat(stored.replace(/[,]/g, ""));
      if (!Number.isNaN(tNum) && !Number.isNaN(sNum)) {
        mismatch = Math.abs(tNum - sNum) > 0.0001;
      } else {
        const norm = (s: string) =>
          s.trim().toLowerCase().replace(/^["']|["']$/g, "");
        mismatch = norm(trailer) !== norm(stored);
      }
    }
    if (mismatch) {
      mismatches++;
      console.log(
        `Q${q.original_question_number} → answer_key=${stored}, explanation says ${trailer}`,
      );
      console.log(`  status=${q.parsing_status} notes=${q.parsing_notes ?? ""}`);
    }
  }
  console.log(`\nTotal mismatches: ${mismatches}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
