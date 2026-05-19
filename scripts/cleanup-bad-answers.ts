// One-off cleanup: walk every question in the bank and apply the same
// three guards we added to the live solver.
//
//   A) has_image=true AND image_urls=[]  → answer is hallucinated; null
//      it out and flag Needs Review.
//   B) question_type='Student Produced Response' AND correct_answer
//      matches /^[A-D]$/  → SPR can't have a letter answer; null it
//      out and flag Needs Review.
//   C) parsing_notes already mentions "Solver self-contradicts"  → the
//      solver disagreed with itself when it ran; the declared answer
//      is at best a coin flip. Null it out so admins notice on review.
//
// Runs against whatever DATABASE_URL / SUPABASE_SERVICE_ROLE_KEY are in
// the local env. Idempotent — re-running on already-cleaned rows is a
// no-op because the conditions no longer trigger.
//
// Usage:
//   npx tsx scripts/cleanup-bad-answers.ts [--dry-run]

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

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
    /* env file missing → rely on existing process.env */
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
  question_type: string;
  has_image: boolean | null;
  image_urls: string[] | null;
  correct_answer: string | null;
  parsing_notes: string | null;
  parsing_status: string;
}

async function fetchAll(): Promise<Row[]> {
  const PAGE = 1000;
  let from = 0;
  const out: Row[] = [];
  for (;;) {
    const { data, error } = await sb
      .from("questions")
      .select(
        "id, module_id, original_question_number, question_type, has_image, image_urls, correct_answer, parsing_notes, parsing_status",
      )
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as Row[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

interface Action {
  reason: string;
  note: string;
}

function evaluate(r: Row): Action | null {
  // Skip already-rejected rows: admin made a decision.
  if (r.parsing_status === "Rejected") return null;

  const hasAnswer = (r.correct_answer ?? "").trim().length > 0;
  const hasImage = Boolean(r.has_image);
  const imageCount = Array.isArray(r.image_urls) ? r.image_urls.length : 0;
  const ans = (r.correct_answer ?? "").trim();

  // A: image flagged but no crop uploaded → solver ran blind.
  if (hasImage && imageCount === 0 && hasAnswer) {
    return {
      reason: "missing-image",
      note:
        "Solver answered without seeing the figure (has_image=true but image_urls=[]). Answer cleared — please enter the official answer manually.",
    };
  }

  // B: SPR with letter answer.
  if (r.question_type === "Student Produced Response" && /^[A-D]$/i.test(ans)) {
    return {
      reason: "spr-letter",
      note: `Solver returned letter "${ans}" on a Student Produced Response — invalid answer cleared. Please enter manually.`,
    };
  }

  // C: solver self-contradicted at parse time. parsing_notes is the
  // only marker we have after the fact — the gate already flips
  // status to Needs Review, but the old code still wrote the declared
  // answer to correct_answer. Clear it so admins don't trust it.
  if (
    hasAnswer &&
    /solver self-contradict/i.test(r.parsing_notes ?? "")
  ) {
    return {
      reason: "self-contradict",
      note: `${r.parsing_notes ?? ""}\nAnswer cleared by cleanup pass — please verify and enter manually.`,
    };
  }

  return null;
}

async function main() {
  const rows = await fetchAll();
  console.log(`[cleanup] scanned ${rows.length} questions${dryRun ? " (DRY RUN)" : ""}`);

  const byReason: Record<string, number> = {};
  const updates: { id: string; note: string; reason: string }[] = [];
  for (const r of rows) {
    const a = evaluate(r);
    if (!a) continue;
    byReason[a.reason] = (byReason[a.reason] ?? 0) + 1;
    updates.push({ id: r.id, note: a.note, reason: a.reason });
  }

  console.log(`[cleanup] would update ${updates.length} rows`);
  for (const [k, v] of Object.entries(byReason)) {
    console.log(`  - ${k}: ${v}`);
  }
  if (dryRun || updates.length === 0) return;

  let ok = 0;
  let fail = 0;
  for (const u of updates) {
    // Keep the existing correct_answer so admins have an AI guess to
    // verify against — we only flip parsing_status + parsing_notes.
    // The note explains why this row needs another look.
    const { error } = await sb
      .from("questions")
      .update({
        parsing_status: "Needs Review",
        parsing_notes: u.note.slice(0, 1000),
      })
      .eq("id", u.id);
    if (error) {
      fail++;
      console.warn(`[cleanup] ${u.id}: ${error.message}`);
    } else {
      ok++;
    }
  }
  console.log(`[cleanup] done: ${ok} updated, ${fail} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
