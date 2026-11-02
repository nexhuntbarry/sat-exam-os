// Unit checks for the "AI thinks the answer key may be wrong" flow.
import { keyDoubtNote, parseKeyDoubt, hasKeyDoubt, stripKeyDoubtNote, clearReviewTags, hasReviewTags } from "@/lib/key-doubt";
import { friendlyParsingNote } from "@/lib/friendly-parsing-notes";
import { applyLiveHold } from "@/lib/live-questions";

let fail = 0;
const ok = (name: string, cond: boolean) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) fail++; };

const note = keyDoubtNote("C", "D", 'The officials disagreed despite the warning; "For this reason" is illogical.');
const notes = `Answer = official key; explanation matches (verified); ${note}`;
ok("note has no ';' inside", !note.includes(";"));
ok("parse round-trips", JSON.stringify(parseKeyDoubt(notes)) === JSON.stringify({ stored: "C", suggested: "D", reason: 'The officials disagreed despite the warning, "For this reason" is illogical' }));
ok("hasKeyDoubt", hasKeyDoubt(notes) && !hasKeyDoubt("Answer = official key"));
ok("strip keeps other notes", stripKeyDoubtNote(notes) === "Answer = official key; explanation matches (verified)");

// Every automatic approve path keys off these patterns (lib/ai/solve-question.ts
// EXPLAIN_HARD_ISSUE, lib/repair-ops.ts OTHER_NOTE x2).
const EXPLAIN_HARD_ISSUE = /missing figure|needs? a figure|no figure|figure shown|based on the graph|image not uploaded|requires drawing|LaTeX|garbled|choices|needs review:/i;
const OTHER_NOTE_1 = /LaTeX|math\/|choices|Multiple Choice with|garbled|answer\/explanation|self-contradict|official key=|needs review:/i;
const OTHER_NOTE_2 = /figure|graph|LaTeX|math\/|self-contradict|official key=|answer\/explanation|misalign|needs review:/i;
ok("explain-official keeps it in review", EXPLAIN_HARD_ISSUE.test(notes));
ok("figure repair keeps it in review", OTHER_NOTE_1.test(notes));
ok("choice repair keeps it in review", OTHER_NOTE_2.test(notes));

const f = friendlyParsingNote(notes);
ok("admin banner headline", f?.headline === "Moved to Needs Review: the AI thinks the answer key may be wrong" && f.tone === "error");
ok("admin banner detail", f?.detail === 'Current answer: C · AI suggests: D. Why: The officials disagreed despite the warning, "For this reason" is illogical.');

// Live row: stays Approved, tagged for re-check; a person approving clears both.
const { update, held } = applyLiveHold(
  { id: "q1", parsing_status: "Approved", correct_answer: "C", parsing_notes: null } as never,
  { parsing_status: "Needs Review", parsing_notes: notes },
  "AI thinks the answer key may be wrong",
  new Set(["q1"]),
);
ok("live row held Approved", held && !("parsing_status" in update));
const liveNotes = update.parsing_notes as string;
ok("live note tagged + reason", liveNotes.startsWith("[live-fix] AI thinks the answer key may be wrong") && hasKeyDoubt(liveNotes));
ok("live banner still explains the doubt", friendlyParsingNote(liveNotes)?.detail?.startsWith("Current answer: C") === true);
ok("human approve clears both", hasReviewTags(liveNotes) && clearReviewTags(liveNotes) === "Answer = official key; explanation matches (verified)");

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
process.exit(fail ? 1 : 0);
