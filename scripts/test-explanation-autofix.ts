// Unit checks for the explanation auto-fix "only reason" logic (lib/explanation-autofix.ts).
//   node --import tsx scripts/test-explanation-autofix.ts
import {
  splitNotes,
  classifyNote,
  planNotes,
  decideAutoFix,
  explanationTargetReasons,
  explanationArguesOther,
  formattingProblems,
  AUTO_FIX_NOTE_PREFIX,
  type AutoFixRow,
  type NoteContext,
} from "../lib/explanation-autofix";
import { TRUNCATION_NOTE, REGEN_EXPLANATION_NOTE, REGEN_DISAGREE_PREFIX } from "../lib/ai/solve-question";
import { keyDoubtNote } from "../lib/key-doubt";
import { LIVE_FIX_TAG } from "../lib/live-questions";

let fail = 0;
const ok = (n: string, c: boolean) => { console.log(c ? "PASS" : "FAIL", n); if (!c) fail++; };

const GOOD = "Choice A is correct because the comma after “Ortelius” closes the phrase opened by the earlier comma. Choice B leaves the phrase open, and C and D add commas that split the subject from its verb.";
const row = (o: Partial<AutoFixRow> = {}): AutoFixRow => ({
  id: "q1",
  module_id: "m1",
  original_question_number: 19,
  question_type: "Multiple Choice",
  question_text: "Which choice completes the text so that it conforms to the conventions of Standard English?",
  choices: [{ label: "A", text: "Ortelius," }, { label: "B", text: "Ortelius" }, { label: "C", text: "Ortelius;" }, { label: "D", text: "Ortelius:" }],
  correct_answer: "A",
  official_answer: "A",
  explanation: "Choice A is correct because the comma after",
  parsing_status: "Needs Review",
  parsing_notes: TRUNCATION_NOTE,
  has_image: false,
  image_urls: [],
  has_table: false,
  updated_at: "2026-11-07T00:00:00+00:00",
  ...o,
});
const ctx: NoteContext = { officialKey: true, failingChecks: new Set() };
const agree = { ok: true as const, explanation: GOOD, aiAnswer: "A", agrees: true };

// ── splitNotes keeps "; " inside parentheses ──
const keyFix = `Key fix 2026-10-26: key = "SAT ENGLISH MODULE 1 AK" (printed on the Module 1 PDF; the two Oct 2024 ENG PDFs carry each other's keys), verified against this PDF's screenshots`;
ok("splitNotes paren", JSON.stringify(splitNotes(`Answer = official key; ${keyFix}; ${TRUNCATION_NOTE}`)) === JSON.stringify(["Answer = official key", keyFix, TRUNCATION_NOTE]));

// ── classifyNote ──
ok("truncation note = explanation", classifyNote(TRUNCATION_NOTE, ctx) === "explanation");
ok("regen note = explanation", classifyNote(REGEN_EXPLANATION_NOTE, ctx) === "explanation");
ok("semantic truncated = explanation", classifyNote("Semantic audit: Explanation is truncated mid-sentence after 'The phrase' and does not complete its reasoning", ctx) === "explanation");
ok("semantic stray $ in explanation = explanation", classifyNote("Semantic audit: Stray dollar signs in explanation lines ('$\\$10')", ctx) === "explanation");
ok("semantic malformed latex in explanation = explanation", classifyNote("Semantic audit: Malformed LaTeX in explanation: '\\$4x^2'", ctx) === "explanation");
ok("semantic stem = blocking", classifyNote("Semantic audit: Stem is truncated mid-sentence ('the drugs were')", ctx) === "blocking");
ok("semantic choice garbled = blocking", classifyNote("Semantic audit: Choice B is truncated/garbled: 'Untitled'", ctx) === "blocking");
ok("semantic explanation+figure = blocking", classifyNote("Semantic audit: The explanation is fine but missing figure for the graph", ctx) === "blocking");
ok("semantic contradiction, official key = explanation", classifyNote("Semantic audit: The explanation concludes that D is correct, but the stored answer is C", ctx) === "explanation");
ok("semantic contradiction, no official key = blocking", classifyNote("Semantic audit: The explanation concludes that D is correct, but the stored answer is C", { ...ctx, officialKey: false }) === "blocking");
ok("solver self-contradicted + official = explanation", classifyNote("Solver self-contradicted (declared D, explained C)", ctx) === "explanation");
ok("stored explained answer, no official = blocking", classifyNote(`stored the explained answer "C". Please verify.`, { ...ctx, officialKey: false }) === "blocking");
const q19Note = `Needs review: key A is verified from the PDF screenshot (the comma after "Ortelius" opens the "known for…" phrase closed by the comma before "are"), but the stored explanation still argues for the old wrong key B and 3 regeneration attempts gave incorrect grammar reasoning — rewrite the explanation, then approve (2026-10-26)`;
ok("Q19 'explanation still argues' note = explanation", classifyNote(q19Note, ctx) === "explanation");
ok("other Needs review = blocking", classifyNote("Needs review: question text looks cut off — compare with the PDF.", ctx) === "blocking");
ok("key doubt = blocking", classifyNote(keyDoubtNote("C", "D", "the AI's own solve reached a different answer"), ctx) === "blocking");
ok("regen disagree = blocking", classifyNote(`${REGEN_DISAGREE_PREFIX} B but the saved key is A — check the key.`, ctx) === "blocking");
ok("figure/choice/extraction = blocking", ["choices re-extracted from PDF", "Image re-extracted by admin self-repair (1 region).", "still needs review (figure/choices)", "Answer & explanation generated by AI solver — please verify"].every((n) => classifyNote(n, ctx) === "blocking"));
ok("info notes", ["Answer = official key", "explanation matches (verified)", keyFix].every((n) => classifyNote(n, ctx) === "info"));
ok("demoted explanation check passing = explanation", classifyNote("Demoted by post-parse-cleanup: failed checks → math-render-failed", ctx) === "explanation");
ok("demoted check still failing = blocking", classifyNote("Demoted by post-parse-cleanup: failed checks → math-render-failed", { ...ctx, failingChecks: new Set(["math-render-failed"]) }) === "blocking");
ok("demoted non-explanation check = blocking", classifyNote("Demoted by post-parse-cleanup: failed checks → blind-image", ctx) === "blocking");

// ── planNotes: "only reason" ──
const p1 = planNotes(row({ parsing_notes: `Answer = official key; ${keyFix}; ${q19Note}` }), GOOD);
ok("only explanation note → no blockers", p1.blockers.length === 0);
ok("explanation note removed, info kept", !p1.notes.includes("still argues") && p1.notes.includes("Key fix 2026-10-26") && p1.notes.includes(AUTO_FIX_NOTE_PREFIX));
const p2 = planNotes(row({ parsing_notes: `${TRUNCATION_NOTE}; choices re-extracted from PDF` }), GOOD);
ok("extraction note blocks", p2.blockers.length === 1 && p2.blockers[0].includes("choices re-extracted"));
const p3 = planNotes(row({ parsing_notes: `${TRUNCATION_NOTE}; ${keyDoubtNote("A", "B", "x")}` }), GOOD);
ok("key doubt blocks", p3.blockers.some((b) => b.includes("answer key may be wrong")));
const p4 = planNotes(row({ choices: [{ label: "A", text: "" }, { label: "B", text: "x" }, { label: "C", text: "y" }, { label: "D", text: "z" }] }), GOOD);
ok("findApproveBlocker blocks (empty choice)", p4.blockers.some((b) => b.startsWith("approve check:")));
const p5 = planNotes(row({ official_answer: "B" }), GOOD);
ok("key ≠ official blocks", p5.blockers.some((b) => b.includes("differs from the official answer")));
const p6 = planNotes(row({ has_image: true, image_urls: [], question_text: "The figure shown is a right triangle. What is x?" }), GOOD);
ok("missing stem figure blocks", p6.blockers.some((b) => b.includes("figure is missing")));
const p7 = planNotes(row({ parsing_notes: `${TRUNCATION_NOTE}; ${AUTO_FIX_NOTE_PREFIX}: old (2026-11-01)` }), GOOD);
ok("old auto-fix note replaced, not duplicated", p7.notes.split(AUTO_FIX_NOTE_PREFIX).length === 2);

// ── decideAutoFix ──
const t = explanationTargetReasons(row())!;
ok("cut-off row is a target", !!t && t.cutOff);
const d1 = decideAutoFix(row(), t, agree, false);
ok("NR only reason → Approved", d1.group === "fixed_approved" && d1.update?.parsing_status === "Approved" && d1.update?.explanation === GOOD);
ok("never writes key/choices/text", !["correct_answer", "official_answer", "choices", "question_text"].some((k) => k in (d1.update ?? {})));
const d2 = decideAutoFix(row({ parsing_notes: `${TRUNCATION_NOTE}; choices re-extracted from PDF` }), t, agree, false);
ok("NR with other reason → stays NR", d2.group === "fixed_still_review" && !("parsing_status" in (d2.update ?? {})) && d2.update?.explanation === GOOD);
const d3 = decideAutoFix(row({ parsing_status: "Approved", parsing_notes: null }), t, agree, false);
ok("Approved stays Approved", d3.group === "fixed_kept_approved" && !("parsing_status" in (d3.update ?? {})));
const d3b = decideAutoFix(row({ parsing_status: "Approved", parsing_notes: "choices re-extracted from PDF" }), t, agree, false);
ok("Approved with blocking note is never demoted", d3b.group === "fixed_kept_approved" && !("parsing_status" in (d3b.update ?? {})));
const d4 = decideAutoFix(row(), t, agree, true);
ok("live NR → status kept + [live-fix]", d4.group === "fixed_live_held" && !("parsing_status" in (d4.update ?? {})) && String(d4.update?.parsing_notes).startsWith(LIVE_FIX_TAG));
const d5 = decideAutoFix(row({ parsing_status: "Approved", parsing_notes: null }), t, agree, true);
ok("live Approved cut-off fix → no [live-fix] (not material)", d5.group === "fixed_kept_approved" && !String(d5.update?.parsing_notes).includes(LIVE_FIX_TAG));
const tc = { ...t, contradicts: "explanation concludes B, key is A" };
const d6 = decideAutoFix(row({ parsing_status: "Approved", parsing_notes: null }), tc, agree, true);
ok("live Approved contradiction fix → [live-fix]", String(d6.update?.parsing_notes).startsWith(LIVE_FIX_TAG) && !("parsing_status" in (d6.update ?? {})));
const d7 = decideAutoFix(row({ parsing_status: "Approved", parsing_notes: "Answer = official key" }), t, { ok: true, explanation: GOOD, aiAnswer: "B", agrees: false }, false);
ok("disagree: Approved → NR + note, explanation not written", d7.group === "disagree" && d7.update?.parsing_status === "Needs Review" && String(d7.update?.parsing_notes).includes(REGEN_DISAGREE_PREFIX) && !("explanation" in (d7.update ?? {})));
const d8 = decideAutoFix(row({ parsing_status: "Approved", parsing_notes: null }), t, { ok: true, explanation: GOOD, aiAnswer: "B", agrees: false }, true);
ok("disagree on live Approved → kept Approved + [live-fix]", d8.group === "disagree" && !("parsing_status" in (d8.update ?? {})) && String(d8.update?.parsing_notes).startsWith(LIVE_FIX_TAG));
const d9 = decideAutoFix(row(), t, { ok: false, error: "x", kind: "cut_off", partial: "Choice A is" }, false);
ok("still cut off → row left as-is (partial not stored)", d9.group === "still_cut_off" && d9.update === null);
const d10 = decideAutoFix(row(), t, { ok: true, explanation: GOOD.replace("Choice A is correct", "Choice B is correct"), aiAnswer: "A", agrees: true }, false);
ok("draft arguing another letter rejected", d10.group === "draft_rejected" && d10.update === null);
const d11 = decideAutoFix(row(), t, { ok: true, explanation: GOOD, aiAnswer: null, agrees: true }, false);
ok("no independent answer → left as-is", d11.group === "unverified" && d11.update === null);
const d12 = decideAutoFix(row(), t, { ok: true, explanation: `${GOOD} Wait, let me re-check that.`, aiAnswer: "A", agrees: true }, false);
ok("draft with narration rejected", d12.group === "draft_rejected");
const d13 = decideAutoFix(row(), t, { ok: false, error: "x", kind: "failed" }, false);
ok("AI failure → left as-is", d13.group === "failed" && d13.update === null);

// ── detectors ──
ok("argues other: Therefore B", explanationArguesOther("… Therefore, B is the only choice that follows the conventions.", "A", "Multiple Choice", null) !== null);
ok("argues other: 'so B is wrong' is not a conclusion", explanationArguesOther("Choice A is correct. B fails, so B is wrong.", "A", "Multiple Choice", null) === null);
ok("argues other: 'Choice C is incorrect' is not a conclusion", explanationArguesOther("Choice A is correct. Choice C is incorrect.", "A", "Multiple Choice", null) === null);
ok("SPR final answer line with key value", explanationArguesOther("… Final answer: **a + c = 7 + 1.5 = \\mathbf{8.5}**", "8.5", "Student Produced Response", null) === null);
ok("SPR final answer differs", explanationArguesOther("… Final answer: 12", "8.5", "Student Produced Response", null) !== null);
ok("narration detected", formattingProblems("x = 3. Wait, let me recheck: x = 4.").length > 0);
ok("quoted 'wait,' in passage not narration", formattingProblems(`The narrator says “wait, the train is late,” which shows impatience.`).length === 0);
ok("raw LaTeX detected", formattingProblems("We get 3x \\Rightarrow x = 3.").length > 0);
ok("clean math passes", formattingProblems("Solve $3x = 9$ to get $x = 3$. It costs \\$5.").length === 0);
ok("approved clean row is not a target", explanationTargetReasons(row({ parsing_status: "Approved", parsing_notes: null, explanation: GOOD })) === null);
ok("row waiting on a disagreement is not a target", explanationTargetReasons(row({ parsing_notes: `${TRUNCATION_NOTE}; ${REGEN_DISAGREE_PREFIX} B but the saved key is A` })) === null);

console.log(fail ? `${fail} FAILED` : "ALL PASSED");
process.exit(fail ? 1 : 0);
