// One-off (support 40febc9c, approved by Barry 2026-11-02): Test #17 ENG M2 Q24
// key C → D ("Nevertheless"), new explanation, then re-grade submitted answers.
import { getServiceClient } from "@/lib/supabase";
import { rescoreQuestion } from "@/lib/rescore";

const ID = "5733cc17-d525-4cd4-9f15-49cf3c7fd06d";
const EXPLANATION = `Choice D is the best answer. The first sentence says engineers warned against using multiple track widths. The second sentence says regional officials couldn't agree on a single-width system, which is the opposite of what the warning called for. "Nevertheless" signals that something happened despite what came before, so it correctly links the warning to the officials' failure to agree. The last sentence ("Thus, ...") then gives the result: different regions built different track widths.

Choice A is incorrect because "In other words" introduces a restatement, but the officials' disagreement doesn't restate the engineers' warning.
Choice B is incorrect because "Similarly" introduces a parallel point, but the disagreement contrasts with the warning rather than resembling it.
Choice C is incorrect because "For this reason" would mean the warning caused the officials to disagree, which isn't logical; the officials disagreed in spite of the warning.`;

async function main() {
  const db = getServiceClient();
  const { data: q } = await db.from("questions").select("correct_answer, parsing_notes").eq("id", ID).single();
  if (!q) throw new Error("question not found");
  console.log("before key", q.correct_answer);
  const { data: recs } = await db.from("answer_records").select("submission_id, student_answer, is_correct").eq("question_id", ID);
  const subIds = [...new Set((recs ?? []).map((r) => r.submission_id))];
  const { data: before } = await db.from("submissions").select("id, correct_count, total_questions, score").in("id", subIds);
  const note = `Key fix 2026-11-02 (support 40febc9c, approved by Barry): C → D ("Nevertheless"). The engineers warned against multiple widths and officials failed to agree despite it; "For this reason" is illogical. The source PDF marks D with an x and C with nothing, so it doesn't support C. Student reported the official Bluebook answer is D.`;
  const { error } = await db.from("questions").update({ correct_answer: "D", explanation: EXPLANATION, parsing_notes: `${note}\n${q.parsing_notes ?? ""}`, updated_at: new Date().toISOString() }).eq("id", ID);
  if (error) throw error;
  console.log("rescore", await rescoreQuestion(db, ID));
  const { data: after } = await db.from("submissions").select("id, correct_count, total_questions, score").in("id", subIds);
  for (const b of before ?? []) {
    const a = after?.find((x) => x.id === b.id);
    const ans = recs?.find((r) => r.submission_id === b.id)?.student_answer;
    console.log(b.id.slice(0, 8), "answered", ans, `${b.correct_count}/${b.total_questions}`, "→", `${a?.correct_count}/${a?.total_questions}`);
  }
}
main();
