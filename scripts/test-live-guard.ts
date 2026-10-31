// scripts/test-live-guard.ts
//
// Checks the live-test demotion guard (lib/live-questions.ts) against real
// data. Read-only: no question is written — holdLiveDemotion only reads and
// returns the adjusted update.
//
//   node --env-file=.env.local --import tsx scripts/test-live-guard.ts
import { createClient } from "@supabase/supabase-js";
import {
  LIVE_FIX_TAG,
  applyLiveHold,
  holdLiveDemotion,
  liveQuestionIds,
  stripLiveFixNote,
} from "../lib/live-questions";

// In published test a58f0bb8… with a class assigned.
const LIVE_ID = "fa61d7b3-3cf6-4169-8d7a-3d5b3dd86957";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  // A question from a module that no Published test uses at all.
  const { data: tests } = await db
    .from("tests")
    .select("module_id, module_1_id, module_2_id, module_2_easy_id, module_2_hard_id, question_ids")
    .eq("status", "Published");
  const usedModules = new Set<string>();
  const usedIds = new Set<string>();
  for (const t of tests ?? []) {
    for (const m of [t.module_id, t.module_1_id, t.module_2_id, t.module_2_easy_id, t.module_2_hard_id]) {
      if (m) usedModules.add(m as string);
    }
    for (const q of (t.question_ids as string[] | null) ?? []) usedIds.add(q);
  }
  const { data: candidates } = await db
    .from("questions")
    .select("id, module_id, parsing_status, parsing_notes, correct_answer")
    .eq("parsing_status", "Approved")
    .limit(500);
  const notLiveRow = (candidates ?? []).find(
    (q) => q.module_id && !usedModules.has(q.module_id as string) && !usedIds.has(q.id as string),
  );
  if (!notLiveRow) throw new Error("No Approved question outside every published test — can't run the negative case");

  const { data: liveRow } = await db
    .from("questions")
    .select("id, module_id, parsing_status, parsing_notes, correct_answer")
    .eq("id", LIVE_ID)
    .single();
  if (!liveRow) throw new Error(`Question ${LIVE_ID} not found`);
  console.log(`live question     ${liveRow.id} status=${liveRow.parsing_status} answer=${liveRow.correct_answer}`);
  console.log(`not-live question ${notLiveRow.id} status=${notLiveRow.parsing_status} module=${notLiveRow.module_id}`);

  // 1. liveQuestionIds
  const live = await liveQuestionIds(db, [liveRow.id, notLiveRow.id]);
  check("liveQuestionIds: published+assigned question is live", live.has(liveRow.id));
  check("liveQuestionIds: question in no published test is not live", !live.has(notLiveRow.id));
  check("liveQuestionIds: empty input → empty set", (await liveQuestionIds(db, [])).size === 0);

  // 2. applyLiveHold (pure)
  const demote = {
    question_text: "new text",
    parsing_status: "Draft",
    parsing_notes: "Re-extracted by admin self-repair (math). Re-review before approve.",
    reviewed_at: null,
    updated_at: "now",
  };
  const held = applyLiveHold(liveRow, demote, "Math formatting repaired", live);
  check("applyLiveHold live: held", held.held);
  check("applyLiveHold live: parsing_status removed", !("parsing_status" in held.update));
  check("applyLiveHold live: reviewed_at kept", !("reviewed_at" in held.update));
  check("applyLiveHold live: content still updated", held.update.question_text === "new text");
  check(
    "applyLiveHold live: note tagged",
    String(held.update.parsing_notes).startsWith(`${LIVE_FIX_TAG} Math formatting repaired`) &&
      String(held.update.parsing_notes).endsWith(demote.parsing_notes),
    held.update.parsing_notes,
  );

  const answerChange = applyLiveHold(
    liveRow,
    { correct_answer: liveRow.correct_answer === "A" ? "B" : "A", explanation: "x", parsing_status: "Needs Review" },
    "Re-solved by the AI solver",
    live,
  );
  check("applyLiveHold live: correct_answer change dropped", !("correct_answer" in answerChange.update));
  check("applyLiveHold live: explanation for the other answer dropped", !("explanation" in answerChange.update));
  check("applyLiveHold live: note says answer not applied", /was not applied/.test(String(answerChange.update.parsing_notes)), answerChange.update.parsing_notes);

  const sameAnswer = applyLiveHold(liveRow, { correct_answer: liveRow.correct_answer, explanation: "x" }, "x", live);
  check("applyLiveHold live: same answer + no demotion → untouched", !sameAnswer.held && sameAnswer.update.explanation === "x");

  const free = applyLiveHold(notLiveRow, demote, "Math formatting repaired", live);
  check("applyLiveHold not-live: not held", !free.held);
  check("applyLiveHold not-live: update unchanged", free.update === demote);

  // Re-tagging replaces the old tag instead of stacking.
  const again = applyLiveHold({ ...liveRow, parsing_notes: String(held.update.parsing_notes) }, { parsing_status: "Needs Review" }, "Semantic audit found a problem", live);
  check(
    "applyLiveHold: re-tag doesn't stack",
    String(again.update.parsing_notes).split(LIVE_FIX_TAG).length === 2,
    again.update.parsing_notes,
  );

  // 3. holdLiveDemotion (reads only)
  const h1 = await holdLiveDemotion(db, liveRow.id, { ...demote }, "Math formatting repaired");
  check("holdLiveDemotion live: held", h1.held && !("parsing_status" in h1.update));
  const h2 = await holdLiveDemotion(db, notLiveRow.id, { ...demote }, "Math formatting repaired");
  check("holdLiveDemotion not-live: passes through", !h2.held && h2.update.parsing_status === "Draft");
  const h3 = await holdLiveDemotion(db, liveRow.id, { parsing_status: "Approved" }, "x");
  check("holdLiveDemotion: Approved write not touched", !h3.held && h3.update.parsing_status === "Approved");

  // 4. stripLiveFixNote
  check("stripLiveFixNote: removes tag sentence", stripLiveFixNote(String(held.update.parsing_notes)) === demote.parsing_notes);
  check("stripLiveFixNote: tag only → null", stripLiveFixNote(`${LIVE_FIX_TAG} Fixed while live; kept Approved — please re-check. `) === null);
  check("stripLiveFixNote: untagged untouched", stripLiveFixNote("Some note") === "Some note");

  // The tag must not have been written anywhere by this run.
  const { data: after } = await db.from("questions").select("parsing_status, parsing_notes").eq("id", liveRow.id).single();
  check("live question unchanged in DB", after?.parsing_status === liveRow.parsing_status && after?.parsing_notes === liveRow.parsing_notes);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
