// T14 English M2 Q26: the live explanation stopped mid-sentence ("Choice B,").
// Nightly BANK check 2026-11-03. Content-only fix; key B unchanged.
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ID = "50529e9b-6774-4e4b-9ce4-2714990da606";
const explanation =
  "The writer wants to stress how fast skill sets are becoming obsolete, and to do it concisely. " +
  "Choice B, \"only accelerating,\" says the trend keeps speeding up, which highlights the speed of the transition in two words. " +
  "Choice A (\"accelerating in a faster and faster way\"), Choice C (\"increasingly accelerating\") and Choice D (\"accelerating more quickly as time goes by\") all repeat the idea of speeding up that \"accelerating\" already contains, so they are redundant and wordy. " +
  "The answer is B.";

async function main() {
  const { data: q } = await db.from("questions").select("correct_answer,parsing_notes").eq("id", ID).single();
  if (q?.correct_answer !== "B") throw new Error(`unexpected key ${q?.correct_answer}`);
  const notes = (q.parsing_notes ?? "")
    .split(";").map((s: string) => s.trim())
    .filter((s: string) => s && !s.includes("explanation looks cut off")).join("; ") || null;
  const { error } = await db.from("questions").update({ explanation, parsing_notes: notes }).eq("id", ID);
  if (error) throw error;
  console.log("updated", ID);
}
main();
