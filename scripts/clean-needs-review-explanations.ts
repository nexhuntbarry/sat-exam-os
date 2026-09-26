import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "3");

const SYSTEM = `You are an expert SAT tutor writing the final answer explanation a student reads after a test. You are GIVEN the correct answer from the official College Board key — it is authoritative and final.

Write ONLY the explanation itself. Start immediately with the reasoning. Absolutely forbidden:
- ANY meta-narration or process talk: no "Wait", "Actually", "Let me", "re-examine", "reconsider", "re-reading", "hold on", "I must", "as required", "the instructions", "the answer key says".
- Questioning or hedging the answer. State the reasoning as settled fact.
- Ever naming a different letter as the answer.

Explain clearly why the given answer is correct and briefly why each other choice is wrong.

FORMATTING (Markdown + KaTeX, $…$ = math mode):
- Never write a bare dollar amount like $170 (it opens math mode). Write "170 dollars" or "\\$170".
- Use $…$ only for real algebra, and close every $ you open.`;

// Deterministic safety net: drop any leading sentence that is process
// narration rather than explanation, in case the model still slips.
function stripMetaNarration(raw: string): string {
  if (!raw) return raw;
  const META = /\b(wait|let me|re-?examine|reconsider|re-?reading|hold on|i must|i need to|as required|the instructions|answer key says|second-guess|let me construct|let me write|let me carefully|the correct answer given|the stored (correct )?answer)\b/i;
  // Split into sentences, keep terminators.
  const parts = raw.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) ?? [raw];
  const kept: string[] = [];
  let started = false;
  for (const p of parts) {
    if (!started && META.test(p)) continue; // skip leading process chatter
    started = true;
    kept.push(p);
  }
  let out = kept.join("").trim();
  // Also nuke a stray "Wait — …" clause anywhere at the very start.
  out = out.replace(/^(wait|actually|hmm|okay|ok)[\s,—-]+/i, "").trim();
  return out || raw;
}

const Schema = z.object({ explanation: z.string().min(20) });
const META_TEST = /\b(wait|let me|re-?examine|reconsider|re-?reading|as required|the instructions|answer key says)\b/i;

async function main() {
  const { data } = await db
    .from("questions")
    .select("id, original_question_number, question_text, choices, correct_answer, explanation, mismatch_with_official, parsing_notes, has_image, image_urls, question_type")
    .eq("parsing_status", "Needs Review");
  const rows = data ?? [];

  const caveat = /still needs review|incomplete|cut off|truncat|duplicate|same value|blind|no figure|not fully|blank choice|figure\/choices/i;
  const verified = /verified|answer = official key|explanation matches official|explanation rewritten to match/i;

  // Candidates: answer verified against official key, no structural caveat,
  // has choices/figure as needed. These are the "answer right, explanation
  // possibly messy" bucket.
  const cands = rows.filter((q) => {
    if (q.mismatch_with_official) return false;
    const n = (q.parsing_notes as string | null) ?? "";
    if (!verified.test(n)) return false;
    if (caveat.test(n)) return false;
    if (!q.correct_answer) return false;
    const ch = q.choices as Array<{ label: string; text: string }> | null;
    if (q.question_type === "Multiple Choice" && (!Array.isArray(ch) || ch.length < 2)) return false;
    if ((q.has_image) && !(Array.isArray(q.image_urls) && q.image_urls.length > 0)) return false;
    return true;
  });

  console.log(`Candidates: ${cands.length}. Processing ${APPLY ? "ALL" : LIMIT}...`);
  const todo = APPLY ? cands : cands.slice(0, LIMIT);
  let approved = 0, regen = 0, skipped = 0;

  for (const q of todo) {
    const expl = (q.explanation as string | null) ?? "";
    const messy = META_TEST.test(expl) || expl.trim().length < 40;
    let finalExpl = expl;
    if (messy) {
      const ch = Array.isArray(q.choices)
        ? (q.choices as Array<{ label: string; text: string }>).map((c) => `${c.label}) ${c.text}`).join("\n")
        : "";
      try {
        const res = await generateObject({
          model: anthropic("claude-sonnet-4-6"),
          schema: Schema,
          system: SYSTEM,
          maxOutputTokens: 2500,
          maxRetries: 2,
          messages: [{ role: "user", content: `Question ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${ch}\n\nThe correct answer is ${q.correct_answer}. Write the explanation.` }],
        });
        finalExpl = stripMetaNarration(res.object.explanation);
        regen++;
      } catch (e) {
        console.log(`  regen FAILED ${q.id.slice(0, 8)}:`, e instanceof Error ? e.message : e);
        skipped++;
        continue;
      }
    }
    // Reject if STILL messy after strip.
    if (META_TEST.test(finalExpl) || finalExpl.trim().length < 40) {
      console.log(`  still messy, skip ${q.id.slice(0, 8)}: ${finalExpl.slice(0, 80)}`);
      skipped++;
      continue;
    }
    if (APPLY) {
      const notes = ((q.parsing_notes as string | null) ?? "")
        .split(";").map((s) => s.trim()).filter((s) => s && !/^Semantic audit:/i.test(s)).join("; ");
      await db.from("questions").update({
        explanation: finalExpl,
        parsing_status: "Approved",
        parsing_notes: notes || null,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", q.id);
      approved++;
    } else {
      console.log(`\n=== ${q.id.slice(0, 8)} ans ${q.correct_answer} ${messy ? "(regenerated)" : "(kept)"}`);
      console.log(finalExpl.replace(/\s+/g, " ").slice(0, 260));
    }
  }
  console.log(`\nDone. approved=${approved} regen=${regen} skipped=${skipped}`);
  if (APPLY) {
    const { count } = await db.from("questions").select("*", { count: "exact", head: true }).eq("parsing_status", "Needs Review");
    console.log("Needs Review now:", count);
  }
}
main();
