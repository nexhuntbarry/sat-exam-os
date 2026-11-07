// lib/reparse-rescore.ts
//
// After a module re-parse set some keys to the PDF's "official" answer
// (app/api/cron/reparse-inplace), students' answers are rescored ONLY when
// that key can be trusted: no module-level key warning (the key disagrees
// with the solved answers on too many questions, or a key-page problem) and
// officialKeyProblem (lib/key-source.ts) finds nothing wrong with it. Other
// rows keep their old grades and a note tells a person why.

import type { SupabaseClient } from "@supabase/supabase-js";
import { moduleKeyFacts, officialKeyProblem } from "@/lib/key-source";
import { rescoreQuestion } from "@/lib/rescore";

export const RESCORE_HELD_PREFIX = "Needs review: answers not rescored to the official key";

/** Why answers may not be rescored to this official key (null = they may). */
export function rescoreHoldReason(
  row: { question_type: string | null; correct_answer: string | null; official_answer: string | null; question_text?: string | null; parsing_notes?: string | null },
  moduleWarning: string | null,
  facts: ReturnType<typeof moduleKeyFacts> | null,
): string | null {
  if (moduleWarning) return `the module's key is in doubt (${moduleWarning.replace(/[;()]/g, ",").slice(0, 120)})`;
  return officialKeyProblem(row, facts);
}

export async function rescoreOfficialKeyChanges(
  db: SupabaseClient,
  moduleId: string,
  ids: string[],
  moduleWarning: string | null,
): Promise<{ rescored: number; held: number }> {
  if (ids.length === 0) return { rescored: 0, held: 0 };
  const { data: all } = await db
    .from("questions")
    .select("id, original_question_number, question_type, question_text, correct_answer, official_answer, parsing_notes")
    .eq("module_id", moduleId);
  const rows = all ?? [];
  const facts = moduleKeyFacts(rows as Parameters<typeof moduleKeyFacts>[0]);
  let rescored = 0, held = 0;
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    if (!r) continue;
    const why = rescoreHoldReason(r as Parameters<typeof rescoreHoldReason>[0], moduleWarning, facts);
    if (why) {
      held++;
      const note = `${RESCORE_HELD_PREFIX} — ${why.replace(/;/g, ",")}. Confirm the key, then rescore`;
      const notes = (r.parsing_notes as string | null) ?? "";
      if (!notes.includes(RESCORE_HELD_PREFIX)) {
        await db.from("questions").update({ parsing_notes: notes ? `${notes}; ${note}` : note, updated_at: new Date().toISOString() }).eq("id", id);
      }
      continue;
    }
    try {
      await rescoreQuestion(db, id);
      rescored++;
    } catch (e) {
      console.error(`[reparse-rescore] ${id}:`, e);
    }
  }
  return { rescored, held };
}
