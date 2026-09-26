import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
const t = readFileSync(".env.local", "utf-8"); for (const l of t.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const APPLY = process.argv.includes("--apply");
const SYSTEM = `You are an expert SAT tutor writing the final answer explanation a student reads. You are GIVEN the correct answer from the official College Board key — authoritative and final. Write ONLY the explanation, starting immediately with the reasoning. FORBIDDEN: any meta-narration ("Wait","Actually","Let me","re-examine","reconsider","the instructions","the answer key says"); questioning the answer; naming a different answer. Explain why the given answer is correct and briefly why the others are wrong. Complete sentences, never cut off. Markdown+KaTeX: never a bare $170 (write "170 dollars"/"\\$170"); $…$ only for real algebra, close every $.`;
const META = /\b(wait|let me|re-?examine|reconsider|re-?reading|hold on|i must|as required|the instructions|answer key says|second-guess|the correct answer given|the stored (correct )?answer)\b/i;
function strip(raw: string): string { const parts = raw.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) ?? [raw]; const k: string[] = []; let s = false; for (const p of parts) { if (META.test(p)) { if (!s) continue; else continue; } s = true; k.push(p); } return (k.join("").trim().replace(/^(wait|actually|hmm|okay|ok)[\s,—-]+/i, "").trim()) || raw; }
const Schema = z.object({ explanation: z.string().min(30) });
// Notes that mean the ANSWER itself is unsettled — skip, human must decide.
const UNSETTLED = /verifier disagreed|contradicts the stored|needs human|placeholder|truncat|3 solves agreed on .* but/i;

async function main() {
  const { data } = await db.from("questions").select("id, original_question_number, question_text, choices, correct_answer, explanation, mismatch_with_official, has_image, image_urls, question_type, parsing_notes").eq("parsing_status", "Needs Review");
  const cands = (data ?? []).filter((q) => {
    if (q.mismatch_with_official || !q.correct_answer) return false;
    if (!META.test((q.explanation as string | null) ?? "")) return false;
    if (UNSETTLED.test((q.parsing_notes as string | null) ?? "")) return false;
    const ch = q.choices as Array<{ label: string; text: string }> | null;
    if (q.question_type === "Multiple Choice" && (!Array.isArray(ch) || ch.length < 2)) return false;
    if (q.has_image && !(Array.isArray(q.image_urls) && q.image_urls.length > 0)) return false;
    return true;
  });
  console.log(`meta candidates (settled answer): ${cands.length}`);
  let approved = 0, skipped = 0;
  for (const q of cands) {
    const ch = Array.isArray(q.choices) ? (q.choices as Array<{ label: string; text: string }>).map((c) => `${c.label}) ${c.text}`).join("\n") : "";
    try {
      const res = await generateObject({ model: anthropic("claude-sonnet-4-6"), schema: Schema, system: SYSTEM, maxOutputTokens: 2500, maxRetries: 2, messages: [{ role: "user", content: `Question ${q.original_question_number}:\n${q.question_text}\n\nChoices:\n${ch}\n\nThe correct answer is ${q.correct_answer}. Write the complete explanation.` }] });
      const cleaned = strip(res.object.explanation);
      if (META.test(cleaned) || cleaned.length < 40) { console.log(`  still meta, skip ${q.id.slice(0, 8)}`); skipped++; continue; }
      if (APPLY) {
        const notes = ((q.parsing_notes as string | null) ?? "").split(";").map(s => s.trim()).filter(s => s && !/^Semantic audit:/i.test(s)).join("; ");
        await db.from("questions").update({ explanation: cleaned, parsing_status: "Approved", parsing_notes: notes || null, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", q.id);
        approved++;
      } else { console.log(`\n=== ${q.id.slice(0, 8)} ${q.correct_answer}\n${cleaned.replace(/\s+/g, " ").slice(0, 220)}`); }
    } catch (e) { console.log(`  FAIL ${q.id.slice(0, 8)}`, e instanceof Error ? e.message : e); skipped++; }
  }
  console.log(`\nDone approved=${approved} skipped=${skipped}`);
  if (APPLY) { const { count } = await db.from("questions").select("*", { count: "exact", head: true }).eq("parsing_status", "Needs Review"); console.log("Needs Review now:", count); }
}
main();
