// One-off (nightly D-20261105-3): Test #10 Dec 2023 INT V1 Math M2 Q18 was
// stored as a typed-answer (SPR) question with key "D" and no choices, so no
// typed answer could ever be marked right. The source PDF (page 11) shows it
// is multiple choice: A 3,645/289, B 405/17, C 85, D 1,445/9 (D checked).
// Restores the choices, keeps key D, cleans the explanation. No answer records
// exist yet, so no scores move.
import { getServiceClient } from "@/lib/supabase";
import { rescoreQuestion } from "@/lib/rescore";
import { LIVE_FIX_TAG, liveQuestionIds } from "@/lib/live-questions";

const ID = "e8d5c0fd-659d-423d-8aae-a33723150f76";
const CHOICES = [
  { label: "A", text: String.raw`$\frac{3{,}645}{289}$` },
  { label: "B", text: String.raw`$\frac{405}{17}$` },
  { label: "C", text: "85" },
  { label: "D", text: String.raw`$\frac{1{,}445}{9}$` },
];
const EXPLANATION = String.raw`Choice D is the best answer. Because $\overline{LM}$ is parallel to $\overline{PQ}$, angles $LMR$ and $QPR$ are alternate interior angles and are congruent, and angles $LRM$ and $QRP$ are vertical angles and are congruent. So $\triangle LMR$ is similar to $\triangle QPR$, with $\overline{MR}$ corresponding to $\overline{PR}$. The scale factor from $\triangle LMR$ to $\triangle QPR$ is $\frac{17}{9}$, so the ratio of their areas is $\left(\frac{17}{9}\right)^2 = \frac{289}{81}$. The area of $\triangle PQR$ is $45 \cdot \frac{289}{81} = \frac{1{,}445}{9}$ square units.

Choice A is incorrect. It's the result of squaring the scale factor $\frac{9}{17}$ instead of $\frac{17}{9}$.
Choice B is incorrect. It's the result of using the scale factor $\frac{9}{17}$ without squaring it.
Choice C is incorrect. It's the result of using the scale factor $\frac{17}{9}$ without squaring it.`;

async function main() {
  const db = getServiceClient();
  const { data: q } = await db.from("questions").select("question_type, correct_answer, parsing_notes").eq("id", ID).single();
  if (!q) throw new Error("question not found");
  if (q.correct_answer !== "D") throw new Error(`unexpected key ${q.correct_answer}`);
  const live = (await liveQuestionIds(db, [ID])).has(ID);
  const note = `Fixed 2026-11-05: was stored as a typed-answer question with no choices; restored the 4 choices from the source PDF (page 11); key D matches the PDF checkmark.`;
  const notes = [live ? `${LIVE_FIX_TAG} ${note}` : note, q.parsing_notes].filter(Boolean).join("; ");
  const { error } = await db
    .from("questions")
    .update({
      question_type: "Multiple Choice",
      choices: CHOICES,
      explanation: EXPLANATION,
      parsing_notes: notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ID);
  if (error) throw error;
  console.log("live:", live, "rescore", await rescoreQuestion(db, ID));

  const { data: bad } = await db
    .from("questions")
    .select("id, original_question_number, correct_answer, module_id")
    .eq("question_type", "Student Produced Response")
    .eq("parsing_status", "Approved")
    .in("correct_answer", ["A", "B", "C", "D", "a", "b", "c", "d"]);
  console.log("other approved SPR with letter key:", bad);
}
main();
