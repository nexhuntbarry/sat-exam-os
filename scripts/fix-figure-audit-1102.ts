// One-off 2026-11-02 (figure + key audit after Barry asked why scanned
// questions still had problems). No real student's score changes.
import { getServiceClient } from "@/lib/supabase";
import { liveQuestionIds, LIVE_FIX_TAG } from "@/lib/live-questions";
import { rescoreQuestion } from "@/lib/rescore";

const EXPL_CDD5 = `The figure shows the points $(-3, 4)$, $(5, 3)$, and $(4, -3)$. Use the distance formula $d = \\sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}$ for each side:

- From $(-3, 4)$ to $(5, 3)$: $\\sqrt{8^2 + (-1)^2} = \\sqrt{65} \\approx 8.06$
- From $(5, 3)$ to $(4, -3)$: $\\sqrt{(-1)^2 + (-6)^2} = \\sqrt{37} \\approx 6.08$
- From $(4, -3)$ to $(-3, 4)$: $\\sqrt{(-7)^2 + 7^2} = \\sqrt{98} \\approx 9.90$

The perimeter is $\\sqrt{65} + \\sqrt{37} + \\sqrt{98} \\approx 24.04$, which rounds to 24.`;

const PULL: Record<string, string> = {
  "84d7ad11": "the figure's axis titles are scrambled (\"&HOO SKRQH VXEVFULHUV\") and the y-axis has no numbers; re-crop the figure from the PDF.",
  cfeb50a4: "the graph levels off at y = -8 and crosses the y-axis at (0, -7), so k = -8 (choice A), but the key is B (-7). Check the key and explanation.",
  f81a38db: "the shaded region is above the dashed line y = -5, so -19y < c gives c = 95 (choice A), but the key is D (-95). Check the key and explanation.",
  "3950e4c4": "line k in the figure passes through (0, -5) and (6, 0) (slope 5/6), but the choices assume slope ±5/4; the figure or choices don't match the source. Re-check against the PDF.",
  fc4e373b: "tan C = 3/4 with hypotenuse AC = 90 gives AB = 90 × 3/5 = 54 (choice C), but the key is B (15/4). Fix the key and explanation.",
};

async function byPrefix(db: ReturnType<typeof getServiceClient>, prefix: string) {
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from("questions").select("id, question_text, parsing_status, parsing_notes, correct_answer").range(f, f + 999);
    const q = data?.find((x) => x.id.startsWith(prefix));
    if (q) return q;
    if ((data ?? []).length < 1000) throw new Error(`not found ${prefix}`);
  }
}

async function main() {
  const db = getServiceClient();
  const now = new Date().toISOString();

  // 1. cdd5eff3 (Test #12 L Test 1 Math): key 23 → 24, explanation rewritten.
  const a = await byPrefix(db, "cdd5eff3");
  const liveA = (await liveQuestionIds(db, [a.id])).has(a.id);
  await db.from("questions").update({
    correct_answer: "24",
    explanation: EXPL_CDD5,
    parsing_notes: `${liveA ? `${LIVE_FIX_TAG} Answer key corrected while this question is in a live test; kept Approved — please re-check. ` : ""}Key fix 2026-11-02 (figure audit): points (-3,4), (5,3), (4,-3) give perimeter √65+√37+√98 ≈ 24.04 → 24, not 23. Only answer on record was "50" (wrong either way), so no score changes.\n${a.parsing_notes ?? ""}`,
    updated_at: now,
  }).eq("id", a.id);
  console.log("cdd5eff3 live", liveA, "rescore", await rescoreQuestion(db, a.id));

  // 2. 657dc7e4: stem typo x^3 - 11x → x^3 - 11x^2 (graph is (x-2)^2(x-7)).
  const b = await byPrefix(db, "657dc7e4");
  const liveB = (await liveQuestionIds(db, [b.id])).has(b.id);
  const stem = b.question_text.replace("x^{3} - 11x + 32x - 28", "x^{3} - 11x^{2} + 32x - 28");
  if (stem === b.question_text) throw new Error("657dc7e4 pattern not found");
  await db.from("questions").update({
    question_text: stem,
    parsing_notes: `${liveB ? `${LIVE_FIX_TAG} Typo fixed while this question is in a live test; kept Approved — please re-check. ` : ""}Typo fix 2026-11-02: f(x) numerator x³ − 11x + 32x − 28 → x³ − 11x² + 32x − 28 (matches the graph (x−2)²(x−7)/10); answer unchanged.\n${b.parsing_notes ?? ""}`,
    updated_at: now,
  }).eq("id", b.id);
  console.log("657dc7e4 live", liveB, "stem fixed");

  // 3. Not in any test, 0 answers: pull to Needs Review with what's wrong.
  for (const [p, why] of Object.entries(PULL)) {
    const q = await byPrefix(db, p);
    if ((await liveQuestionIds(db, [q.id])).has(q.id)) { console.log(p, "LIVE — skipped"); continue; }
    const { count } = await db.from("answer_records").select("id", { count: "exact", head: true }).eq("question_id", q.id);
    if (count) { console.log(p, "has answers — skipped"); continue; }
    await db.from("questions").update({ parsing_status: "Needs Review", parsing_notes: `Pulled for review 2026-11-02 (figure audit): ${why}\n${q.parsing_notes ?? ""}`, updated_at: now }).eq("id", q.id);
    console.log(p, "→ Needs Review");
  }
}
main();
