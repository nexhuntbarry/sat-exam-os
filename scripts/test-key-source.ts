// scripts/test-key-source.ts
//
// Unit checks for lib/key-source.ts (where an answer key came from).
// Run: npx tsx scripts/test-key-source.ts — exits non-zero on any failure.

import { keySource, moduleKeyFacts, officialKeyProblem, type KeySourceRow } from "../lib/key-source";
import { aiKeyVerifiedNote, isAiOnlyKeyNote } from "../lib/verify-ai-key";
import { keyRejectedNote, sprLetterKeyReason } from "../lib/answer-marks";
import { keyDisagreementNote } from "../lib/parse-guards";

let failed = 0;
let total = 0;
function eq(label: string, got: unknown, want: unknown) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} = ${JSON.stringify(got)}${ok ? "" : `  (expected ${JSON.stringify(want)})`}`);
}

const MC = "Multiple Choice";
const SPR = "Student Produced Response";
const row = (r: Partial<KeySourceRow>): KeySourceRow => ({ question_type: MC, correct_answer: null, official_answer: null, parsing_notes: null, ...r });

// Real official key.
eq("official MC", keySource(row({ correct_answer: "B", official_answer: "B" })).kind, "official-pdf");
eq("official label", keySource(row({ correct_answer: "B", official_answer: "B" })).label, "Official answer key (PDF)");
eq("official SPR other form", keySource(row({ question_type: SPR, correct_answer: "3.5", official_answer: "7/2" })).kind, "official-pdf");
eq("officialFromPdf", keySource(row({ correct_answer: "B", official_answer: "B" })).officialFromPdf, true);

// J Test M1 Q5 as it was: fill-in question, invented letter key.
const jq5 = row({ question_type: SPR, correct_answer: "B", official_answer: "B", parsing_notes: "Answer = official key; explanation matches (verified)" });
eq("J M1 Q5 kind", keySource(jq5).kind, "ai-parsed");
eq("J M1 Q5 not from PDF", keySource(jq5).officialFromPdf, false);
eq("J M1 Q5 problem mentions letter", /choice letter "B"/.test(officialKeyProblem(jq5) ?? ""), true);
// J M1 Q5 now (official cleared, key 6/13, no note).
eq("J M1 Q5 now (no notes, no module facts)", keySource(row({ question_type: SPR, correct_answer: "6/13" })).kind, "unknown");
eq("J M1 Q5 now, approved by Premier", keySource(row({ question_type: SPR, correct_answer: "6/13", reviewed_by: "u1", reviewed_at: "2026-11-07T20:45:23Z", reviewer_name: "Premier Plus Education" })).label, "Confirmed by a reviewer (Premier Plus Education, Nov 7, 2026)");

// A MC question in a module whose extracted key gave letters to fill-ins.
const jMod = moduleKeyFacts([
  { original_question_number: 5, question_type: SPR, official_answer: "B" },
  { original_question_number: 19, question_type: SPR, official_answer: "B" },
  { original_question_number: 1, question_type: MC, official_answer: "D" },
  { original_question_number: 14, question_type: SPR, official_answer: "0" },
]);
eq("module facts letters", jMod.sprLetterQuestions, [5, 19]);
eq("module letter → MC official untrusted", keySource(row({ correct_answer: "D", official_answer: "D" }), jMod).kind, "ai-parsed");
eq("module letter → problem", /Q5, Q19/.test(officialKeyProblem(row({ correct_answer: "D", official_answer: "D" }), jMod) ?? ""), true);

// Module disagreement note (key may belong to another module).
const disMod = moduleKeyFacts([{ original_question_number: 9, question_type: MC, official_answer: "C", parsing_notes: `x; ${keyDisagreementNote(6, 17)}` }]);
eq("module disagreement", disMod.keyDisagreement, "6 of 17");
// A real ✓-marked key can still disagree with the AI on many questions
// ([Test #23] Nov 2023 INT English M2, 9 of 27): caution only.
eq("module disagreement → still trusted", keySource(row({ correct_answer: "C", official_answer: "C" }), disMod).officialFromPdf, true);
eq("no module facts → trusted", keySource(row({ correct_answer: "C", official_answer: "C" }), moduleKeyFacts([])).officialFromPdf, true);

// Rejected / invented-key notes.
eq("key rejected note", keySource(row({ correct_answer: "A", official_answer: "A", parsing_notes: keyRejectedNote(sprLetterKeyReason([5])) })).kind, "ai-parsed");
eq("hand note invented", keySource(row({ correct_answer: "A", official_answer: "A", parsing_notes: "Needs review: left for a teacher: the key was invented by the AI parser (this PDF has no answer key)." })).officialFromPdf, false);

// Reviewer changes (lib/key-change.ts note format).
const rev = row({ correct_answer: "A", parsing_notes: "Equations put on separate lines; Answer key check: key B → A (applied by a reviewer (review queue))" });
eq("reviewer kind", keySource(rev).kind, "reviewer");
eq("reviewer label", keySource(rev).label, "Set by a reviewer");
eq("reviewer label with date", keySource(row({ correct_answer: "A", parsing_notes: "Answer key check: key B → A (applied by Premier Plus Education (review queue), 2026-11-08)" })).label, "Set by a reviewer (Premier Plus Education, Nov 8, 2026)");
eq("reviewer detail", keySource(rev).detail, "Changed from B to A by a reviewer (review queue).");
eq("reviewer SPR", keySource(row({ question_type: SPR, correct_answer: "21.5", parsing_notes: "Answer key check: key B → 21.5 (applied by an admin)" })).kind, "reviewer");
eq("reviewer type change", keySource(row({ question_type: SPR, correct_answer: "9", parsing_notes: "Answer key check: type Multiple Choice → Student Produced Response, key B → 9, choices removed (applied by an admin)" })).kind, "reviewer");
eq("live-fix reviewer", keySource(row({ correct_answer: "C", parsing_notes: "[live-fix] Key/type corrected while this question is in a live test; kept Approved — please re-check. Answer key check: key A → C (applied by an admin)" })).kind, "reviewer");
eq("stale reviewer note (key changed again)", keySource(row({ correct_answer: "D", parsing_notes: "Answer key check: key B → A (applied by an admin)" })).kind, "unknown");
eq("reviewer overrides real official", keySource(row({ correct_answer: "A", official_answer: "B", parsing_notes: "Answer key check: key B → A (applied by an admin)" })).kind, "reviewer");
eq("reviewer restoring official", keySource(row({ correct_answer: "B", official_answer: "B", parsing_notes: "Answer key check: key A → B (applied by an admin)" })).kind, "official-pdf");

// AI-solved keys.
const verifiedNote = aiKeyVerifiedNote("code 9, plug-back ok, second solve 9", "2026-11-07");
eq("ai checked", keySource(row({ question_type: SPR, correct_answer: "9", parsing_notes: verifiedNote })).kind, "ai-checked");
eq("ai checked label", keySource(row({ question_type: SPR, correct_answer: "9", parsing_notes: verifiedNote })).label, "Solved by AI · checked by code");
for (const n of [
  "Answer & explanation generated by AI solver — please verify",
  "Solver self-contradicted (declared B, explained C)",
  "Consensus solve NOT unanimous (B/B/C) — needs human",
  "No official answer in key for Q7 — AI solver only, please verify",
]) {
  eq(`AI-only note recognised by verify-ai-key: ${n.slice(0, 30)}`, isAiOnlyKeyNote(n), true);
  eq(`ai: ${n.slice(0, 30)}`, keySource(row({ correct_answer: "B", parsing_notes: n })).kind, "ai");
}
eq("auto-settled", keySource(row({ correct_answer: "B", parsing_notes: "Auto-settled: 3 independent solves agreed + verified (no answer key available)" })).kind, "ai");
eq("differs from real official", keySource(row({ correct_answer: "C", official_answer: "B" })).kind, "ai");
eq("no notes, no official", keySource(row({ correct_answer: "C" })).kind, "unknown");

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
