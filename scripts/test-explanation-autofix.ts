// Unit checks for the explanation auto-fix "only reason" logic (lib/explanation-autofix.ts).
//   node --import tsx scripts/test-explanation-autofix.ts
import {
  splitNotes,
  classifyNote,
  planNotes,
  decideAutoFix,
  explanationTargetReasons,
  explanationArguesOther,
  concludedLetters,
  formattingProblems,
  draftRejection,
  MAX_EXPLANATION_WORDS,
  AUTO_FIX_NOTE_PREFIX,
  type AutoFixRow,
  type NoteContext,
} from "../lib/explanation-autofix";
import { TRUNCATION_NOTE, REGEN_EXPLANATION_NOTE, REGEN_DISAGREE_PREFIX, officialDraftProblem, looksTruncated, stripMetaNarration, withAnswerLine } from "../lib/ai/solve-question";
import { keyDoubtNote } from "../lib/key-doubt";
import { chainMismatches, explanationNumericProblems, keyLetters, statedLetters } from "../lib/explanation-consistency";
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
ok("disagree: Approved stays Approved + note, explanation not written", d7.group === "disagree" && !("parsing_status" in (d7.update ?? {})) && String(d7.update?.parsing_notes).includes(REGEN_DISAGREE_PREFIX) && !("explanation" in (d7.update ?? {})));
const d8 = decideAutoFix(row({ parsing_status: "Approved", parsing_notes: null }), t, { ok: true, explanation: GOOD, aiAnswer: "B", agrees: false }, true);
ok("disagree on live Approved → kept Approved + disagree note", d8.group === "disagree" && !("parsing_status" in (d8.update ?? {})) && String(d8.update?.parsing_notes).includes(REGEN_DISAGREE_PREFIX));
const d8b = decideAutoFix(row({ parsing_status: "Draft", parsing_notes: null }), t, { ok: true, explanation: GOOD, aiAnswer: "B", agrees: false }, false);
ok("disagree on Draft → Needs Review", d8b.group === "disagree" && d8b.update?.parsing_status === "Needs Review");
const d9 = decideAutoFix(row(), t, { ok: false, error: "x", kind: "cut_off", partial: "Choice A is" }, false);
ok("still cut off → row left as-is (partial not stored)", d9.group === "still_cut_off" && d9.update === null);
const d10 = decideAutoFix(row(), t, { ok: true, explanation: GOOD.replace("Choice A is correct", "Choice B is correct"), aiAnswer: "A", agrees: true }, false);
ok("draft arguing another letter rejected", d10.group === "draft_rejected" && d10.update === null);
const d11 = decideAutoFix(row(), t, { ok: true, explanation: GOOD, aiAnswer: null, agrees: true }, false);
ok("no independent answer → left as-is", d11.group === "unverified" && d11.update === null);
const d11b = decideAutoFix(row(), t, { ok: true, explanation: GOOD, aiAnswer: "Let me re-read carefully. We want the greatest value.\nSo the answer is 15.", agrees: false }, false);
ok("independent answer that is working, not a value → left as-is (no disagree note)", d11b.group === "unverified" && d11b.update === null);
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

// ── Numeric consistency (lib/explanation-consistency.ts) ──
// Incident 2026-11-07: [Test #14] J Test Math M1 Q10, key changed B → A, the
// old explanation stayed: it computes (200 − 100)/100 = 100% and writes 120%.
const Q10_TEXT = "The value of a rare stamp increased by 150% from the end of 2018 to the end of 2019 and then decreased by 20% from the end of 2019 to the end of 2020. What was the net percentage increase in the value of the rare stamp from the end of 2018 to the end of 2020?";
const Q10_CHOICES = [{ label: "A", text: "100.00%" }, { label: "B", text: "120.00%" }, { label: "C", text: "140.00%" }, { label: "D", text: "150.00%" }];
const Q10_OLD = "Start with an arbitrary base value of 100 dollars at the end of 2018.\n\n**Step 1 — Increase of 150% from 2018 to 2019:**\nA 150% increase means the value grows by 1.5 times its current amount, so the new value is $100 \\times (1 + 1.50) = 100 \\times 2.50 = 250$ dollars.\n\n**Step 2 — Decrease of 20% from 2019 to 2020:**\nA 20% decrease means the value is multiplied by 0.80, so the new value is $250 \\times 0.80 = 200$ dollars.\n\n**Step 3 — Net percentage change from 2018 to 2020:**\nThe value went from 100 dollars to 200 dollars, which is an increase of 100 dollars on a base of 100 dollars.\n$$\\text{Net \\% increase} = \\frac{200 - 100}{100} \\times 100\\% = 120\\%$$\n\nThe combined multiplier $(2.50 \\times 0.80 = 2.00)$ confirms the final value is exactly double the original, representing a **120% net increase**.\n\nChoice A (100%) is too low — it would correspond to only doubling without correctly accounting for the 150% rise. Choices C (140%) and D (150%) ignore the compounding effect of the 20% decrease on the already-elevated 2019 value. Only choice B correctly applies both percentage changes in sequence to arrive at **120%**.";
const Q10_GOOD = "Start with a value of 100 dollars at the end of 2018.\n\n1. A 150% increase multiplies it by 2.5: $100 \\times 2.5 = 250$.\n2. A 20% decrease multiplies it by 0.8: $250 \\times 0.8 = 200$.\n3. Net change: $\\frac{200 - 100}{100} \\times 100\\% = 100\\%$.\n\nChoice B (120%) adds 150% and subtracts 20%. Choice C (140%) and choice D (150%) ignore the decrease or apply it to the original value.\n\nAnswer: A";
const q10 = (o: Partial<AutoFixRow> = {}) => row({ original_question_number: 10, question_text: Q10_TEXT, choices: Q10_CHOICES, correct_answer: "A", official_answer: null, explanation: Q10_OLD, parsing_status: "Approved", parsing_notes: null, ...o });
const q10Problems = explanationNumericProblems({ explanation: Q10_OLD, key: "A", questionType: "Multiple Choice", choices: Q10_CHOICES });
ok("Q10: '(200−100)/100 × 100% = 120%' is caught (computes 100)", chainMismatches(Q10_OLD).some((m) => m.computed === 100 && m.stated === 120));
ok("Q10: stated 120% maps to choice B ≠ key A", q10Problems.some((p) => /final value 120 is choice B, key is A/.test(p)));
ok("Q10: 'Only choice B …' ≠ key A", q10Problems.some((p) => /names B as the answer/.test(p)));
ok("Q10: the old text check alone missed it", explanationArguesOther(Q10_OLD, "A", "Multiple Choice", Q10_TEXT) === null);
ok("Q10 old explanation fails draftRejection for key A", /numbers don't match/.test(draftRejection(q10(), Q10_OLD) ?? ""));
ok("Q10 old explanation fails even for key B (computes 100, says 120)", draftRejection(q10({ correct_answer: "B" }), Q10_OLD) !== null);
ok("Q10 old explanation is an auto-fix target (non-official key too)", explanationTargetReasons(q10())?.contradicts != null);
ok("Q10 corrected explanation passes for key A", draftRejection(q10(), Q10_GOOD) === null && explanationNumericProblems({ explanation: Q10_GOOD, key: "A", questionType: "Multiple Choice", choices: Q10_CHOICES }).length === 0);
ok("Q10 corrected explanation fails for key B", draftRejection(q10({ correct_answer: "B" }), Q10_GOOD) !== null);
// No false alarms on deliberate wrong / non-computations.
const clean = (ex: string) => chainMismatches(ex).length === 0;
ok("contradiction '0 = 54' is not a computation", clean("The equation reduces to $0 = 54$, which is a contradiction, so there is no solution."));
ok("'gives 5 = 2' (no solution) is not flagged", clean("Subtracting $8x$ from both sides gives $5 = 2$, a false statement."));
ok("a distractor's mistake is not flagged", clean("Choice C would result from mistakenly using $\\sqrt{64} = 16$."));
ok("'3/6 = 1/2' in plain text", clean("So the ratio is 3/6 = 1/2 of the total."));
ok("'−3 + 12 = 9' (unicode minus)", clean("r = 2 gives −3 + 12 = 9 ≠ 0."));
ok("'0.25 = 25%'", clean("The probability is $\\frac{1}{4} = 0.25 = 25\\%$."));
ok("'≈' to the printed rounding", clean("The area is $115.375 \\times 48 \\approx 5500$ square meters, and $6\\pi - 12 \\approx 6.85$."));
ok("'= 39.3' to one decimal", clean("Divide: 5900 / 150 = 39.3 hours."));
ok("a real slip is flagged: 110 + 330 = 270", !clean("Therefore $p + w = 110 + 330 = 270$."));
ok("SPR: 'Answer: 12' vs key 8.5", explanationNumericProblems({ explanation: "So x = 12.\n\nAnswer: 12", key: "8.5", questionType: "Student Produced Response", choices: [] }).length > 0);
ok("SPR: 'Answer: 2/3; .6666 also accepted' vs key 2/3", explanationNumericProblems({ explanation: "x = 2/3.\n\nAnswer: 2/3; .6666, .6667 also accepted.", key: "2/3", questionType: "Student Produced Response", choices: [] }).length === 0);
ok("'Answer: C' closing line counts as a conclusion", explanationArguesOther("Steps…\n\nAnswer: C", "A", "Multiple Choice", null) !== null);
ok("'option consistent' is not option C", statedLetters("It is the only option consistent with the table.").length === 0);

// ── Independent solve first (req: explanations are not written to defend the key) ──
{
  const t = explanationTargetReasons(row())!;
  const dep = decideAutoFix(row(), t, { ok: true, explanation: GOOD, aiAnswer: "A", agrees: true, independent: false }, false);
  ok("agreement only from the writer (saw the key) → not saved", dep.group === "unverified" && dep.update === null);
  const dis = decideAutoFix(row(), t, { ok: true, explanation: "", aiAnswer: "C", agrees: false, independent: true }, false);
  ok("independent solve disagrees → no explanation written, key queued", dis.group === "disagree" && !(dis.update && "explanation" in dis.update));
  const fig = decideAutoFix(row(), t, { ok: false, error: "Figure read conflict: minimum: (2, -3) → (2, -4)", kind: "figure_conflict" }, false);
  ok("figure read conflict → nothing saved", fig.update === null && /Figure read conflict/.test(fig.detail ?? ""));
}

// ── Thinking aloud / format ──
ok("'Wait — looking more carefully' rejected", formattingProblems("The minimum is at (2, 3). Wait — looking more carefully at the graph, the minimum is at (2, -3).").length > 0);
ok("'Hmm' rejected", formattingProblems("Hmm, the slope is 2.").length > 0);
ok("'let's re-check' rejected", formattingProblems("x = 4. Let's re-check: x = 4.").length > 0);
ok("'actually indicates' (R&W) is not narration", formattingProblems("The passage actually indicates the opposite, so choice B is wrong.").length === 0);
ok("hedge 'approximately 5 or so' rejected", formattingProblems("The answer is approximately 5 or so.").length > 0);
ok("too long (> max words) rejected", formattingProblems(Array.from({ length: MAX_EXPLANATION_WORDS + 20 }, () => "word").join(" ")).some((p) => p.startsWith("too long")));
ok("Q10 corrected text has no format problem", formattingProblems(Q10_GOOD).length === 0);

// ── Review round 2 ──
// M1: narration only in narration form.
for (const t of ["Customers wait, on average, 5 minutes in line.", "The wait-time is 4 minutes.", "Then she will wait.", "The narrator is not sure whether to go.", "Looking closely at the graph, the minimum is at (2, -3).", "I think the author argues X, the student wrote.", "Students recheck their work before submitting."]) {
  ok(`not narration: "${t.slice(0, 40)}"`, formattingProblems(t).length === 0);
}
for (const t of ["Wait — looking more carefully at the graph, the minimum is (2, -4).", "So x = 9... wait — adding the equations gives 2a = 2.", "x = 4. Wait, that is wrong.", "Hmm, the slope is 2.", "Let me re-check: x = 4.", "On second thought, B fits better.", "Actually, no, the slope is negative."]) {
  ok(`narration: "${t.slice(0, 40)}"`, formattingProblems(t).length > 0);
}
// H1: more ways an explanation names an answer.
ok("bare 'B is correct because'", concludedLetters("B is correct because the semicolon joins two clauses.").includes("B"));
ok("'which matches option B.'", concludedLetters("The comma closes the phrase, which matches option B.").includes("B"));
ok("'**B** — the passage says'", concludedLetters("**B** — the passage says beta.").includes("B"));
ok("'**A** — incorrect, …' is a wrong-choice line", !concludedLetters("**A** — incorrect, it misreads the text.").includes("A"));
ok("choice-by-choice walk-through (**A** — … **B** — …) names no answer", concludedLetters("**A** — Both texts agree.\n**B** — Text 2 disagrees.").length === 0);
ok("'<key> is incorrect' contradicts the key", explanationArguesOther("Choice C is incorrect because the colon introduces a list.", "C", "Multiple Choice", null) !== null);
ok("another choice 'is incorrect' is fine", explanationArguesOther("Choice A is incorrect because the colon introduces a list. Choice C is correct.", "C", "Multiple Choice", null) === null);
// M2: mixed numbers.
ok("mixed number: 3.6 = 3\\frac{3}{5}", chainMismatches("So $3.6 = 3\\frac{3}{5}$ hours.").length === 0);
ok("mixed number: 2\\frac{1}{2} × 4 = 10", chainMismatches("Then $2\\frac{1}{2} \\times 4 = 10$.").length === 0);
ok("mixed number slip still caught: 2\\frac{1}{2} × 4 = 8", chainMismatches("Then $2\\frac{1}{2} \\times 4 = 8$.").length === 1);

// ── Review round 3 ──
// R2: multi-answer keys ("C, D") are a set, not their first letter.
{
  const twoKey = "**C) Mean — increases**\nRemoving 0.98 raises the mean, so C is correct.\n\n**D) Range — decreases**\nThe range shrinks, so choice D is correct.\n\n**A is wrong.** **B is wrong.**\n\nAnswer: C, D";
  const ch4 = [{ label: "A", text: "median" }, { label: "B", text: "mode" }, { label: "C", text: "mean" }, { label: "D", text: "range" }];
  ok("multi-answer key: concluding C and D doesn't argue another answer", explanationArguesOther(twoKey, "C, D", "Multiple Choice", null) === null);
  ok("multi-answer key: numeric/letter check finds nothing", explanationNumericProblems({ explanation: twoKey, key: "C, D", questionType: "Multiple Choice", choices: ch4 }).length === 0);
  ok("multi-answer key: naming B is still caught", explanationArguesOther("Choice B is correct.", "C, D", "Multiple Choice", null) !== null);
  ok("multi-answer key: 'D is incorrect' contradicts the key", explanationArguesOther("Choice D is incorrect because the range grows.", "C, D", "Multiple Choice", null) !== null);
  ok("keyLetters: 'C, D' / 'C or D' / 'B'", JSON.stringify(keyLetters("C, D")) === '["C","D"]' && JSON.stringify(keyLetters("C or D")) === '["C","D"]' && JSON.stringify(keyLetters("B")) === '["B"]' && keyLetters("12").length === 0);
  ok("withAnswerLine writes the full key", withAnswerLine("Steps.\n\nFinal answer: C", "C, D").endsWith("Answer: C, D") && withAnswerLine("Steps.", "B").endsWith("Answer: B"));
  ok("'Answer: C, D' closing line is not cut off", !looksTruncated("Steps here.\n\nAnswer: C, D"));
}
// M1 leftover: leading-narration stripper only at a sentence start.
ok("strip: 'Customers wait, on average' kept", stripMetaNarration("Customers wait, on average, 5 minutes. So x = 5.") === "Customers wait, on average, 5 minutes. So x = 5.");
ok("strip: 'The wait-time function' kept", stripMetaNarration("The wait-time function is linear. Its slope is 2.") === "The wait-time function is linear. Its slope is 2.");
ok("strip: leading 'Wait — let me re-check.' removed", stripMetaNarration("Wait — let me re-check. The slope is 2.") === "The slope is 2.");
ok("strip: leading 'I need to find x.' removed", stripMetaNarration("I need to find x. Then x = 5.") === "Then x = 5.");

// ── explainOfficialAndPersist: save + approve only a checked, independent draft ──
{
  const r10 = q10({ official_answer: "A", parsing_status: "Needs Review", explanation: null });
  const good = { ok: true as const, explanation: Q10_GOOD, aiAnswer: "A", agrees: true, independent: true };
  ok("official: checked independent draft → saved", officialDraftProblem(good, draftRejection(r10, Q10_GOOD)) === null);
  ok("official: Q10 old draft (computes 100, says 120) → not saved", /failed its check/.test(officialDraftProblem({ ...good, explanation: Q10_OLD }, draftRejection(r10, Q10_OLD)) ?? ""));
  ok("official: writer-only agreement (independent false) → not saved", /never saw the key/.test(officialDraftProblem({ ...good, independent: false }, null) ?? ""));
  ok("official: AI disagrees → not saved", /AI got B/.test(officialDraftProblem({ ok: true, explanation: "", aiAnswer: "B", agrees: false, independent: true }, null) ?? ""));
  ok("official: thinking aloud → not saved", officialDraftProblem({ ...good, explanation: "Wait — let me re-check. " + Q10_GOOD }, draftRejection(r10, "Wait — let me re-check. " + Q10_GOOD)) !== null);
  ok("official: cut off → not saved", officialDraftProblem({ ok: false, error: "x", kind: "cut_off" }, null) !== null);
}

console.log(fail ? `${fail} FAILED` : "ALL PASSED");
process.exit(fail ? 1 : 0);
