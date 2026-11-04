// One-off (nightly BANK-MATH 2026-11-04, approved by Barry on Telegram): Test #20
// Nov 2024 Math M2 Q15 key A → B. The figure's segment runs (−5, 3) → (4, 9), so
// the leg is 3√13 and ½·3√13·x = 48√13 gives x = 32. The old explanation was an
// AI guess with made-up coordinates and broken math. Re-grades submitted answers.
import { getServiceClient } from "@/lib/supabase";
import { rescoreQuestion } from "@/lib/rescore";
import { LIVE_FIX_TAG } from "@/lib/live-questions";

const ID = "8142c0b3-7228-4f57-89db-dfa10708bf0e";
const EXPLANATION = String.raw`Choice B is the best answer. The segment in the figure goes from $(-5, 3)$ to $(4, 9)$, so its length is $\sqrt{(4-(-5))^2 + (9-3)^2} = \sqrt{81 + 36} = \sqrt{117} = 3\sqrt{13}$ units. That segment is one leg of the right triangle. The legs of a right triangle meet at the right angle, so the area is $\frac{1}{2}$ times the product of the legs. If the other leg is $x$, then $\frac{1}{2}(3\sqrt{13})(x) = 48\sqrt{13}$. Dividing both sides by $\sqrt{13}$ gives $\frac{3}{2}x = 48$, so $x = 32$.

Choice A is incorrect. It's the result of leaving out the $\frac{1}{2}$ in the area formula.
Choice C is incorrect. It's the length of the leg shown in the figure, not the other leg.
Choice D is incorrect and may result from calculation errors.`;

async function main() {
  const db = getServiceClient();
  const { data: q } = await db.from("questions").select("correct_answer, parsing_notes").eq("id", ID).single();
  if (!q) throw new Error("question not found");
  if (q.correct_answer !== "A") throw new Error(`unexpected key ${q.correct_answer}`);
  const { data: recs } = await db.from("answer_records").select("submission_id, student_answer").eq("question_id", ID);
  const subIds = [...new Set((recs ?? []).map((r) => r.submission_id))];
  const { data: before } = await db.from("submissions").select("id, correct_count, total_questions, scaled_score").in("id", subIds);
  const notes = [
    `${LIVE_FIX_TAG} Key fix 2026-11-04 (approved by Barry): A → B. The segment runs (−5, 3) to (4, 9), so the shown leg is 3√13 and ½·3√13·x = 48√13 gives x = 32. The old key 16 leaves out the ½. Explanation rewritten.`,
    "Choice D is cut off in the source PDF; the stored \"8\" couldn't be checked against it.",
  ].join("; ");
  const { error } = await db
    .from("questions")
    .update({ correct_answer: "B", explanation: EXPLANATION, parsing_notes: notes, updated_at: new Date().toISOString() })
    .eq("id", ID);
  if (error) throw error;
  console.log("rescore", await rescoreQuestion(db, ID));
  const { data: after } = await db.from("submissions").select("id, correct_count, total_questions, scaled_score").in("id", subIds);
  for (const b of before ?? []) {
    const a = after?.find((x) => x.id === b.id);
    const ans = recs?.find((r) => r.submission_id === b.id)?.student_answer;
    console.log(b.id.slice(0, 8), "answered", ans, `${b.correct_count}/${b.total_questions} (${b.scaled_score})`, "→", `${a?.correct_count}/${a?.total_questions} (${a?.scaled_score})`);
  }
}
main();
