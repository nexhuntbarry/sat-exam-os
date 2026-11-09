// Unit checks for the review queue: reason grouping, key-dispute parsing,
// stale-note cleanup after a key change and the figure-check decision
// (lib/review-queue.ts, lib/figure-compare.ts, lib/review-decide.ts).
//   node --import tsx scripts/test-review-queue.ts
import {
  approvalBlockers,
  autoFixedGroup,
  countByGroup,
  dropFigureNotes,
  dropStaleKeyNotes,
  figureDiffNote,
  figureProposalUrl,
  FIGURE_MATCH_PREFIX,
  groupRow,
  isFigureNote,
  isKeyQuestionNote,
  noteSegments,
  parseKeyDispute,
  removeNotes,
} from "../lib/review-queue";
import {
  compareFigureWithPdf,
  currentStored,
  decideFigure,
  diffTables,
  proposalIsCurrent,
  tableBlockCount,
  isFigureTarget,
  isStaleChoiceAudit,
  replaceTableBlock,
  strictChoice,
  type FigureCompareResult,
  type FigureRow,
} from "../lib/figure-compare";
import { approveRefusal, decide, decideBlockers, liveFixNotes } from "../lib/review-decide";
import { applyKeyCorrection, explanationForKey, keyExplanationPatch, KEY_EXPLANATION_FAILED_PREFIX, type ExplainFn } from "../lib/key-change";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTO_FIX_NOTE_PREFIX } from "../lib/explanation-autofix";
import { TRUNCATION_NOTE, REGEN_DISAGREE_PREFIX } from "../lib/ai/solve-question";
import { keyDoubtNote } from "../lib/key-doubt";
import { LIVE_FIX_TAG, stripLiveFixNote } from "../lib/live-questions";
import { editedExplanationProblem, staleSave } from "../lib/question-save-guard";
import { STEM_CUT_OFF_NOTE } from "../lib/parse-guards";

let fail = 0;
const ok = (n: string, c: boolean) => {
  console.log(c ? "PASS" : "FAIL", n);
  if (!c) fail++;
};

const GOOD = "Choice A is correct because the comma after “Ortelius” closes the phrase opened by the earlier comma. Choice B leaves the phrase open, and C and D add commas that split the subject from its verb.";
const row = (o: Partial<FigureRow> = {}): FigureRow => ({
  id: "q1",
  module_id: "m1",
  original_question_number: 19,
  section: "Reading & Writing",
  question_type: "Multiple Choice",
  question_text: "Which choice completes the text so that it conforms to the conventions of Standard English?",
  choices: [{ label: "A", text: "Ortelius," }, { label: "B", text: "Ortelius" }, { label: "C", text: "Ortelius;" }, { label: "D", text: "Ortelius:" }],
  correct_answer: "A",
  official_answer: "A",
  explanation: GOOD,
  parsing_status: "Needs Review",
  parsing_notes: null,
  has_image: false,
  image_urls: [],
  has_table: false,
  updated_at: "2026-11-07T00:00:00+00:00",
  page_number: 3,
  source_pdf_url: null,
  ...o,
});

// ── parseKeyDispute: the new verify-ai-key note, parsed defensively ──
const ks = parseKeyDispute("Needs review: key says B, AI says C (51.12)", "B");
ok("key says/AI says with ref", ks?.alternative === "C" && ks?.ref === "51.12" && ks?.source === "AI");
ok("key says without prefix / ref / case", parseKeyDispute("Answer = official key; KEY SAYS b, ai says d.", "B")?.alternative === "d");
ok("key says with fill-in values", parseKeyDispute("Needs review: key says 3/2, AI says 1.25 (12.4)", "3/2")?.alternative === "1.25");
ok("key says, AI agrees → no dispute", parseKeyDispute("Needs review: key says B, AI says B", "B") === null);
ok("key doubt → AI audit", parseKeyDispute(keyDoubtNote("D", "C", "comma splice"), "D")?.alternative === "C");
ok("regen disagree", parseKeyDispute(`${REGEN_DISAGREE_PREFIX} B but the saved key is D — check the key (the explanation argues D).`, "D")?.alternative === "B");
ok("Mismatch: AI answered", parseKeyDispute("Mismatch: AI answered A, official B", "B")?.alternative === "A");
ok("official differs", parseKeyDispute("Answer = official key", "A", "D")?.alternative === "D");
ok("figure audit", parseKeyDispute("Pulled for review 2026-11-02 (figure audit): k = -8 (choice A), but the key is B (-7). Check the key and explanation.", "B")?.alternative === "A");
ok("solver self-contradicted picks the other answer", parseKeyDispute("Solver self-contradicted (declared A, explained C); stored the explained answer \"C\". Please verify.", "C")?.alternative === "A");
ok("consensus not unanimous", parseKeyDispute("Consensus solve NOT unanimous (B/B/C) — needs human", "B")?.alternative === "C");
ok("no dispute", parseKeyDispute("Answer = official key", "A", "A") === null);

// ── Grouping ──
const g = (notes: string | null, o: Partial<FigureRow> = {}) => groupRow(row({ parsing_notes: notes, ...o })).primary;
ok("key says → key_dispute", g("Needs review: key says B, AI says C (51.12)", { correct_answer: "B", official_answer: null }) === "key_dispute");
ok("key doubt → key_dispute", g(keyDoubtNote("A", "B", "x")) === "key_dispute");
ok("key ≠ official → key_dispute", g(null, { official_answer: "B" }) === "key_dispute");
ok("module key → module_key", g("Needs review: the PDF's answer key disagrees with the solved answer on 6 of 17 questions in this module — the key page may be for a different module.") === "module_key");
ok("SPR letter → key_format", g("Needs review: SPR question has a letter answer — may actually be multiple choice.", { question_type: "Student Produced Response", choices: [], correct_answer: "A", official_answer: null }) === "key_format");
ok("AI solver → ai_key", g("Answer & explanation generated by AI solver — please verify", { official_answer: null }) === "ai_key");
ok("solver self-contradicted, no official → ai_key", g("Solver self-contradicted (declared A, explained C); stored the explained answer \"C\". Please verify.", { official_answer: null, correct_answer: "C" }) === "ai_key");
ok("stem cut off → stem", g(STEM_CUT_OFF_NOTE) === "stem");
ok("semantic stem truncated → stem", g("Semantic audit: Stem is truncated — only contains 'most nearly mean?' with no passage") === "stem");
ok("figure/choices → figure", g("Explanation matches official answer; still needs review (figure/choices)") === "figure");
ok("image re-extracted → figure", g("Image re-extracted by admin self-repair (1 region).") === "figure");
ok("table AND image → figure", g("Needs review: the question has a Markdown table AND an image; we could not confirm automatically whether the image is the same table") === "figure");
ok("cut-off explanation only → explanation", g(TRUNCATION_NOTE, { explanation: "Choice A is correct because the" }) === "explanation");
ok("live-fix → live_fix", g(`${LIVE_FIX_TAG} Explanation auto-fixed and nothing else blocks approval while this question is in a live test; kept Needs Review — please re-check. Answer = official key`) === "live_fix");
ok("only info notes → ready (nothing left to decide)", g("Answer = official key; explanation matches (verified)") === "ready");
ok("auto-fix history alone → ready", g(`${AUTO_FIX_NOTE_PREFIX}: regenerated from the saved key (2026-11-07)`) === "ready");
const multi = groupRow(row({ parsing_notes: `${keyDoubtNote("A", "B", "x")}; ${STEM_CUT_OFF_NOTE}; still needs review (figure/choices)` }));
// A cut-off stem comes before the key (Q21: the key can't be judged on the wrong question).
ok("priority: broken stem first, then key, then figure", multi.primary === "stem" && multi.groups.join(",") === "stem,key_dispute,figure");
const multi2 = groupRow(row({ parsing_notes: `${keyDoubtNote("A", "B", "x")}; still needs review (figure/choices)` }));
ok("priority: key before figure", multi2.primary === "key_dispute" && multi2.groups.join(",") === "key_dispute,figure");
const counts = countByGroup([row({ parsing_notes: STEM_CUT_OFF_NOTE }), row({ parsing_notes: STEM_CUT_OFF_NOTE }), row({ parsing_notes: "Answer = official key" })]);
ok("countByGroup", counts.stem === 2 && counts.ready === 1 && counts.key_dispute === 0);

ok("'re-extracted from the PDF — check the explanation' → explanation", g("Needs review: stem and choices re-extracted from the PDF (quote cut-off fix, 2026-11-07) — check the explanation against the full question, then approve.") === "explanation");
ok("queue history notes never block", approvalBlockers(row({ parsing_notes: "Question text replaced from the PDF by a reviewer (2026-11-07); Figure check: stored version kept by a reviewer (2026-11-07)" })).length === 0);

// ── Owner item 3: notes about the old key go when the key changes ──
const stemAudit = "Semantic audit: Stem is truncated mid-sentence ('the drugs were' cut off)";
const keyFix = `Key fix 2026-10-26: key = "SAT ENGLISH MODULE 2 AK" (printed on the Module 2 PDF; the two Oct 2024 ENG PDFs carry each other's keys), verified against this PDF's screenshots`;
const oldNotes = [
  "Consensus solve NOT unanimous (B/B/C) — needs human",
  "Auto-settled: 3 independent solves agreed + verified (no answer key available)",
  "Solver self-contradicted (declared A, explained C)",
  'stored the explained answer "C". Please verify.',
  "Answer & explanation generated by AI solver — please verify",
  "Semantic audit: Stored correct answer is C (75°) but the explanation proves 75° is NOT a valid isosceles case",
  "Semantic audit: Explanation is truncated mid-sentence after 'This'",
  keyDoubtNote("C", "A", "x"),
  `${REGEN_DISAGREE_PREFIX} A but the saved key is C — check the key (the explanation argues C).`,
  "Needs review: key says C, AI says A (51.12)",
  "Answer = official key",
  `${AUTO_FIX_NOTE_PREFIX}: regenerated from the saved key, AI's own answer agreed, checked (2026-11-07)`,
  "Pulled for review 2026-11-02 (figure audit): tan C = 3/4 gives AB = 54 (choice A), but the key is C (15/4). Fix the key and explanation.",
  stemAudit,
  keyFix,
  "choices re-extracted from PDF",
].join("; ");
const cleaned = dropStaleKeyNotes(oldNotes, "C", "A");
ok("stale key notes removed", cleaned.removed.length === 13);
ok("stem audit, key-fix history and figure notes kept", noteSegments(cleaned.notes).join(" | ") === [stemAudit, keyFix, "choices re-extracted from PDF"].join(" | "));
ok("same key → nothing removed", dropStaleKeyNotes(oldNotes, "C", "C").removed.length === 0);
ok("[live-fix] tag kept", dropStaleKeyNotes(`${LIVE_FIX_TAG} Key fixed while in a live test; kept Approved — please re-check. Answer = official key`, "A", "B").notes?.startsWith(LIVE_FIX_TAG) === true);
ok("figure-audit about another key kept", dropStaleKeyNotes("Pulled for review (figure audit): x (choice A), but the key is D.", "C", "A").removed.length === 0);
ok("Keep key also settles the module-key note", isKeyQuestionNote("Needs review: the PDF's answer key disagrees with the solved answer on 6 of 17 questions in this module — the key page may be for a different module.", "B"));

// ── Figure notes ──
ok("figure note kinds", ["still needs review (figure/choices)", "Image re-extracted by admin self-repair (1 region).", "choices re-extracted from PDF", "Needs review: Choice misalignment — 4 of the stored answer choices don't match the PDF"].every(isFigureNote));
ok("not figure notes", !["Answer = official key", STEM_CUT_OFF_NOTE, "choice A text corrected from PDF"].some(isFigureNote));
const fn = dropFigureNotes("Choices re-extracted from PDF; verified; Needs review: the question has a Markdown table AND an image; we could not confirm automatically whether the image is the same table (duplicate screenshot) or a real chart/figure — check it (QA 2026-10-26)\n\nImage re-extracted by admin self-repair (1 region).; Answer = official key");
ok("figure notes dropped incl. blank-line-joined and orphan 'verified'", fn.notes === "Answer = official key" && fn.removed.length === 5);
ok("isFigureTarget", isFigureTarget(row({ parsing_notes: "still needs review (figure/choices)" })) && !isFigureTarget(row({ parsing_status: "Approved", parsing_notes: "still needs review (figure/choices)" })));
const diffNote = figureDiffNote(["figure"], "https://x.public.blob.vercel-storage.com/figure-compare/q1-abc.json");
ok("diff note carries the proposal url", figureProposalUrl(`Answer = official key; ${diffNote}`) === "https://x.public.blob.vercel-storage.com/figure-compare/q1-abc.json");
ok("diff note is one segment and a figure note", noteSegments(`a; ${diffNote}`).length === 2 && isFigureNote(diffNote));
ok("diff note blocks approval", approvalBlockers(row({ parsing_notes: diffNote })).length > 0);
ok("stale choice audit", isStaleChoiceAudit("Semantic audit: Choice B is truncated/garbled: 'Untitled (Two Heads on Gold) and Ja' — text cut off mid-word, Explanation is truncated mid-sentence: ends with 'By using the word' and no conclusion"));
ok("choice audit about the stem is not stale", !isStaleChoiceAudit("Semantic audit: All four answer choices have empty text, Stem appears incomplete"));

// ── Tables / choices ──
const T1 = "Intro\n\n| x | y |\n| --- | --- |\n| 1 | $-5$ |\n| 2 | 7 |\n\nWhat is y?";
ok("same table, different math markup", diffTables(T1, "| $x$ | $y$ |\n|---|---|\n| 1 | −5 |\n| 2 | 7 |").length === 0);
ok("table cell differs", diffTables(T1, "| x | y |\n|---|---|\n| 1 | 5 |\n| 2 | 7 |")[0]?.includes("row 2 cell 2"));
ok("table row count differs", diffTables(T1, "| x | y |\n|---|---|\n| 1 | -5 |")[0]?.includes("rows"));
ok("replaceTableBlock keeps the prose", replaceTableBlock(T1, "| x | y |\n|---|---|\n| 1 | 5 |") === "Intro\n\n| x | y |\n|---|---|\n| 1 | 5 |\n\nWhat is y?");
ok("strictChoice keeps punctuation", strictChoice("Ortelius,") !== strictChoice("Ortelius;") && strictChoice("“Next,”") === strictChoice('"Next,"'));

// ── decideFigure ──
const match = (o: Partial<Extract<FigureCompareResult, { outcome: "match" }>> = {}): FigureCompareResult => ({ outcome: "match", checked: ["choices"], removeDuplicateImage: false, detail: [], ...o });
const d1 = decideFigure(row({ parsing_notes: "Explanation matches official answer; still needs review (figure/choices); choices re-extracted from PDF" }), match(), false, null);
ok("match + nothing else → Approved, figure notes cleared", d1.group === "match_approved" && d1.update?.parsing_status === "Approved" && !String(d1.update?.parsing_notes).includes("figure/choices") && String(d1.update?.parsing_notes).includes(FIGURE_MATCH_PREFIX));
ok("match never writes key/choices/text", !["correct_answer", "choices", "question_text", "explanation"].some((k) => k in (d1.update ?? {})));
const d2 = decideFigure(row({ parsing_notes: `still needs review (figure/choices); ${STEM_CUT_OFF_NOTE}` }), match(), false, null);
ok("match + stem note → stays NR", d2.group === "match_still_review" && !("parsing_status" in (d2.update ?? {})) && d2.blockers.some((b) => b.includes("cut off")));
const d3 = decideFigure(row({ parsing_notes: "still needs review (figure/choices); Answer & explanation generated by AI solver — please verify" }), match(), false, null);
ok("match + AI-solver note → stays NR", d3.group === "match_still_review");
const d4 = decideFigure(row({ parsing_notes: "still needs review (figure/choices)" }), match(), true, null);
ok("live → status kept + [live-fix]", d4.group === "match_live_held" && !("parsing_status" in (d4.update ?? {})) && String(d4.update?.parsing_notes).startsWith(LIVE_FIX_TAG));
const d5 = decideFigure(
  row({ parsing_notes: "Needs review: the question has a Markdown table AND an image; we could not confirm automatically", has_image: true, image_urls: ["https://x/a.png"], question_text: T1 }),
  match({ checked: ["choices", "table", "duplicate table image"], removeDuplicateImage: true }),
  false,
  null,
);
ok("duplicate table image removed, approved", d5.group === "match_approved" && d5.update?.has_image === false && Array.isArray(d5.update?.image_urls) && (d5.update?.image_urls as unknown[]).length === 0);
const auditNote = "Semantic audit: Choice B is truncated/garbled: 'Untitled (Two Heads on Gold) and Ja' — text cut off mid-word, Explanation is truncated mid-sentence: ends with 'By using the word'";
const d6 = decideFigure(row({ parsing_notes: `${auditNote}; choices re-extracted from PDF; ${AUTO_FIX_NOTE_PREFIX}: regenerated (2026-11-07)` }), match(), false, null);
ok("stale choice audit dropped after explanation auto-fix → Approved", d6.group === "match_approved" && d6.removedNotes.includes(auditNote));
const d6b = decideFigure(row({ parsing_notes: `${auditNote}; choices re-extracted from PDF` }), match(), false, null);
ok("choice audit kept when the explanation wasn't re-checked", d6b.group === "match_still_review");
const differs: FigureCompareResult = {
  outcome: "differs",
  checked: ["figure"],
  detail: [],
  proposal: { version: 1, questionId: "q1", checkedAt: "", pages: "3", parts: ["figure"], diffs: ["figure: cut off"], stored: { imageUrls: ["a"] }, pdf: { imageUrls: ["b"] } },
};
const d7 = decideFigure(row({ parsing_notes: "Image re-extracted by admin self-repair (1 region)." }), differs, false, "https://x.public.blob.vercel-storage.com/p.json");
ok("differs → diff note with url, status untouched", d7.group === "differs" && !("parsing_status" in (d7.update ?? {})) && figureProposalUrl(String(d7.update?.parsing_notes)) === "https://x.public.blob.vercel-storage.com/p.json" && !String(d7.update?.parsing_notes).includes("Image re-extracted"));
const d8 = decideFigure(row({ parsing_notes: "still needs review (figure/choices)" }), { outcome: "unverifiable", checked: [], detail: ["x"] }, false, null);
ok("unverifiable → left as-is", d8.group === "unverifiable" && d8.update === null);

// ── Decision gate ──
ok("decideBlockers: cut-off explanation blocks", decideBlockers(row({ explanation: "Choice A is correct because the" })).some((b) => b.startsWith("explanation:")));
ok("decideBlockers: clean row passes", decideBlockers(row()).length === 0);
ok("removeNotes", removeNotes("a; b; c", (s) => s === "b").notes === "a; c");

// ── Summary: automatic fixes ──
ok("autoFixedGroup figure", autoFixedGroup({ parsing_status: "Approved", parsing_notes: `${FIGURE_MATCH_PREFIX} (choices, 2026-11-07)` }) === "figure");
ok("autoFixedGroup explanation", autoFixedGroup({ parsing_status: "Approved", parsing_notes: `${AUTO_FIX_NOTE_PREFIX}: x` }) === "explanation");
ok("autoFixedGroup ignores Needs Review", autoFixedGroup({ parsing_status: "Needs Review", parsing_notes: `${AUTO_FIX_NOTE_PREFIX}: x` }) === null);

// ── Code-review fixes (async: wrapped, the script is CommonJS) ──
async function reviewFixes() {

// Tiny in-memory stand-in for the Supabase query builder (one table).
function fakeDb(rows: Record<string, unknown>[]) {
  const writes: Record<string, unknown>[] = [];
  const from = () => {
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    let patch: Record<string, unknown> | null = null;
    let single = false;
    const run = () => {
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (patch) {
        for (const r of hit) Object.assign(r, patch);
        writes.push(patch);
      }
      return { data: single ? (hit[0] ?? null) : hit.map((r) => ({ ...r })), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (u: Record<string, unknown>) => ((patch = u), b),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), b),
      maybeSingle: () => ((single = true), Promise.resolve(run())),
      then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, writes };
}

// HIGH 1: "approve" refuses anything outside the ready / note / live-test groups.
ok("approveRefusal: clean row may be approved", approveRefusal(row()).length === 0);
ok("approveRefusal: an unclassified note (note group) may be approved", approveRefusal(row({ parsing_notes: "Needs review: something odd about Q19" })).length === 0);
ok("approveRefusal: live-fix re-check may be approved", approveRefusal(row({ parsing_notes: `${LIVE_FIX_TAG} Key/type corrected while this question is in a live test; kept Approved — please re-check.` })).length === 0);
ok("approveRefusal: key dispute refused", approveRefusal(row({ parsing_notes: "Needs review: key says A, AI says C (12)" })).length > 0);
ok("approveRefusal: key ≠ official refused", approveRefusal(row({ official_answer: "C" })).some((b) => /differs from the official/.test(b)));
ok("approveRefusal: missing figure refused", approveRefusal(row({ question_text: "The graph above shows f. What is f(2)?", has_image: true, image_urls: [] })).length > 0);
ok("approveRefusal: cut-off explanation refused", approveRefusal(row({ explanation: "Choice A is correct because the" })).some((b) => b.startsWith("explanation:")));
{
  const disputed = { ...row({ parsing_notes: "Needs review: key says A, AI says C (12)" }), image_alts: [], mismatch_with_official: false } as Record<string, unknown>;
  const { db, writes } = fakeDb([disputed]);
  const r = await decide(db, "q1", { action: "approve" }, { expectedUpdatedAt: disputed.updated_at as string });
  ok("decide approve: key-disputed row → 400, nothing written", !r.ok && r.status === 400 && writes.length === 0 && disputed.parsing_status === "Needs Review");
  const clean = { ...row({ parsing_notes: "Needs review: something odd about Q19" }), image_alts: [], mismatch_with_official: false } as Record<string, unknown>;
  const f2 = fakeDb([clean]);
  const r2 = await decide(f2.db, "q1", { action: "approve" }, {});
  ok("decide approve: note-group row → Approved", r2.ok && r2.approved === true && clean.parsing_status === "Approved");
}

// HIGH 2: content changes on a live row lead with [live-fix].
ok("liveFixNotes prepends the tag", liveFixNotes("Answer = official key").startsWith(`${LIVE_FIX_TAG} `) && liveFixNotes("Answer = official key").endsWith("Answer = official key"));
ok("liveFixNotes not twice", liveFixNotes(`${LIVE_FIX_TAG} x; kept Approved — please re-check. y`) === `${LIVE_FIX_TAG} x; kept Approved — please re-check. y`);
ok("liveFixNotes on empty notes", liveFixNotes(null).startsWith(LIVE_FIX_TAG) && liveFixNotes(null).endsWith("re-check."));

// MEDIUM 3: a crop that may show the ✓ mark is not offered.
{
  const spr = row({ question_type: "Student Produced Response", choices: [], correct_answer: "4", official_answer: "4", has_image: true, image_urls: ["https://x.public.blob.vercel-storage.com/old.png"] });
  const res = await compareFigureWithPdf(spr, "", null, {
    crop: async () => ({ kind: "cropped", urls: ["https://x.public.blob.vercel-storage.com/new.png"], alts: ["fig"], choiceUrls: {}, checkMarkLeak: true }),
    same: async () => ({ same: false, reason: "axis cut off" }),
  });
  ok("compare: check-mark crop → differs, flagged, no PDF images", res.outcome === "differs" && res.proposal.checkMarkLeak === true && !res.proposal.pdf.imageUrls);
  const res2 = await compareFigureWithPdf(spr, "", null, {
    crop: async () => ({ kind: "cropped", urls: ["https://x.public.blob.vercel-storage.com/new.png"], alts: ["fig"], choiceUrls: {}, checkMarkLeak: false }),
    same: async () => ({ same: false, reason: "axis cut off" }),
  });
  ok("compare: clean crop → PDF images offered", res2.outcome === "differs" && !res2.proposal.checkMarkLeak && res2.proposal.pdf.imageUrls?.length === 1);
}

// MEDIUM 4: "Keep key" drops only dispute notes.
ok("keep key keeps the auto-fix history", !isKeyQuestionNote(`${AUTO_FIX_NOTE_PREFIX}: regenerated (2026-11-07)`, "A"));
ok("keep key keeps 'Answer verified against official key'", !isKeyQuestionNote("Answer verified against official key", "A"));
ok("keep key keeps 'Answer = official key'", !isKeyQuestionNote("Answer = official key", "A"));
ok("keep key keeps a positive semantic audit", !isKeyQuestionNote("Semantic audit: correct_answer is correct and the explanation supports it", "A"));
ok("keep key drops a key dispute", isKeyQuestionNote("Needs review: key says A, AI says C (12)", "A"));
ok("keep key drops a consensus split", isKeyQuestionNote("Consensus solve NOT unanimous (A/A/C) — needs human", "A"));
ok("keep key drops a key doubt", isKeyQuestionNote(keyDoubtNote("A", "C", "comma splice"), "A"));
ok("keep key drops a disputing semantic audit", isKeyQuestionNote("Semantic audit: the stored correct_answer is likely wrong; B fits better", "A"));
ok("keep key drops the official-answer dispute", isKeyQuestionNote("Answer A differs from the official answer C", "A"));

// MEDIUM 5: the [live-fix] sentence (with its ";") survives note cleanup.
{
  const live = `${LIVE_FIX_TAG} Key/type corrected while this question is in a live test; kept Approved — please re-check. Consensus solve NOT unanimous (A/A/C) — needs human; Answer = official key`;
  const kept = removeNotes(live, (s) => isKeyQuestionNote(s, "A")).notes;
  ok("removeNotes keeps the whole [live-fix] sentence", kept === `${LIVE_FIX_TAG} Key/type corrected while this question is in a live test; kept Approved — please re-check. Answer = official key`);
  const stale = dropStaleKeyNotes(live, "A", "C").notes ?? "";
  ok("dropStaleKeyNotes keeps the [live-fix] sentence", stale.startsWith(`${LIVE_FIX_TAG} Key/type corrected while this question is in a live test; kept Approved — please re-check.`));
  ok("removeNotes with only the live-fix sentence left", removeNotes(`${LIVE_FIX_TAG} x; kept Approved — please re-check. Consensus solve NOT unanimous (A/A/C)`, (s) => s.startsWith("Consensus")).notes === `${LIVE_FIX_TAG} x; kept Approved — please re-check.`);
  ok("dropFigureNotes keeps the [live-fix] sentence", dropFigureNotes(`${LIVE_FIX_TAG} x; kept Approved — please re-check. still needs review (figure/choices)`).notes === `${LIVE_FIX_TAG} x; kept Approved — please re-check.`);
}

// MEDIUM 6: the key change is a compare-and-set on the old key.
{
  const q = { id: "k1", question_text: "Which choice?", choices: row().choices, question_type: "Multiple Choice", correct_answer: "A", parsing_status: "Needs Review", parsing_notes: null };
  // The preview saw A, then someone else changed it to B before this write.
  const { db, writes } = fakeDb([q]);
  const origFrom = (db as unknown as { from: () => Record<string, unknown> }).from;
  let reads = 0;
  (db as unknown as { from: () => Record<string, unknown> }).from = () => {
    const b = origFrom();
    const ms = b.maybeSingle as () => Promise<unknown>;
    b.maybeSingle = () => ms().then((x) => {
      if (reads++ === 0) q.correct_answer = "B"; // concurrent change lands after our read
      return { data: { ...(x as { data: Record<string, unknown> }).data, correct_answer: "A" }, error: null };
    });
    return b;
  };
  const explain = async () => ({ ok: true as const, explanation: "Choice C is correct because the comma closes the phrase.\n\nAnswer: C", aiAnswer: "C", agrees: true, independent: true });
  const r = await applyKeyCorrection(db, { id: "k1", correct_answer: "C", expectedKey: "A", rescore: true, source: "test", explain });
  ok("key change: concurrent change → 409, no write applied", !r.ok && r.status === 409 && q.correct_answer === "B" && writes.length === 1);
}

// Incident 2026-11-07 (J Test M1 Q10): a key change from the queue must
// save a checked explanation WITH the key, or never report "approved".
{
  const goodC = "Choice C is correct: a semicolon joins the two independent clauses.\n\nAnswer: C";
  const stub = (r: Partial<{ explanation: string; aiAnswer: string | null; agrees: boolean; independent: boolean }>) => async () =>
    ({ ok: true as const, explanation: goodC, aiAnswer: "C", agrees: true, independent: true, ...r });
  const setKey = async (explain: ExplainFn, o: Partial<FigureRow> = {}) => {
    const r = { ...row({ official_answer: null, ...o }), image_alts: [], mismatch_with_official: false } as Record<string, unknown>;
    const f = fakeDb([r]);
    const res = await decide(f.db, "q1", { action: "set_key", key: "C", expectedKey: "A", rescore: true }, { explain });
    return { res, r, writes: f.writes };
  };

  const a = await setKey(stub({}));
  ok("set_key + checked explanation → approved", a.res.ok && a.res.approved === true && a.res.explanation === "regenerated");
  ok("set_key: key and explanation saved in ONE write", a.writes[0]?.correct_answer === "C" && a.writes[0]?.explanation === goodC);

  const b = await setKey(stub({ explanation: "", aiAnswer: "A", agrees: false }));
  ok("set_key, AI disagrees → NOT approved", b.res.ok && b.res.approved === false && b.res.explanation === "ai_disagrees" && !!b.res.warning);
  ok("set_key, AI disagrees → key kept, old explanation removed, Needs Review", b.r.correct_answer === "C" && b.r.explanation === null && b.r.parsing_status === "Needs Review");
  ok("set_key, AI disagrees → note names the AI's answer", String(b.r.parsing_notes).includes(`${REGEN_DISAGREE_PREFIX} A but the saved key is C`));

  // The Q10 failure mode: the draft computes one value and states another.
  const c = await setKey(stub({ explanation: "Net change: $\\frac{200 - 100}{100} \\times 100\\% = 120\\%$. Only choice C fits.\n\nAnswer: C" }));
  ok("set_key, draft fails the numeric check twice → failed, NOT approved", c.res.approved === false && c.res.explanation === "failed" && c.r.parsing_status === "Needs Review" && c.r.explanation === null);
  ok("set_key failure note says why", String(c.r.parsing_notes).includes(KEY_EXPLANATION_FAILED_PREFIX));

  const d = await setKey(stub({ independent: false }));
  ok("set_key, answer not from an independent solve → NOT approved", d.res.approved === false && d.res.explanation === "failed");

  const e = await setKey(stub({}), { parsing_status: "Approved" });
  ok("set_key on an Approved (not live) row with a checked explanation stays Approved", e.res.approved === true && e.r.parsing_status === "Approved");
  const e2 = await setKey(stub({ explanation: "", aiAnswer: "B", agrees: false }), { parsing_status: "Approved" });
  ok("set_key failure on an Approved, NOT live row → Needs Review", e2.res.approved === false && e2.r.parsing_status === "Needs Review");

  // Live rows (pure patch): never demoted, explanation hidden, [live-fix] leads.
  const liveRow = { ...row({ parsing_status: "Approved", correct_answer: "C", official_answer: null, parsing_notes: "Answer key check: key A → C (applied by x)" }) };
  const lp = keyExplanationPatch(liveRow, { outcome: "failed", explanation: null, aiAnswer: null, reason: "the AI call failed" }, true);
  ok("live failure: status untouched", !("parsing_status" in lp.patch) && !lp.ok);
  ok("live failure: stale explanation hidden", lp.patch.explanation === null);
  ok("live failure: [live-fix] note leads", String(lp.patch.parsing_notes).startsWith(LIVE_FIX_TAG) && String(lp.patch.parsing_notes).includes("re-check."));
  const fits = keyExplanationPatch({ ...liveRow, explanation: goodC }, { outcome: "failed", explanation: null, aiAnswer: null, reason: "x" }, true, false);
  ok("key unchanged: a current explanation that passes every check is kept on failure", !("explanation" in fits.patch));
  // H1: after a REAL key change, text written for the old key never stays,
  // even when the checks can't tell how it argues.
  const oldTexts = ["B is correct because the semicolon joins two clauses.", "The comma closes the phrase, which matches option B.", "**B** — the passage says beta.", "The phrase is closed by the comma after the name."];
  for (const t of oldTexts) {
    const p = keyExplanationPatch({ ...liveRow, correct_answer: "C", explanation: t }, { outcome: "failed", explanation: null, aiAnswer: null, reason: "x" }, false, true);
    ok(`key changed + failure: old text removed ("${t.slice(0, 28)}…")`, p.patch.explanation === null && p.patch.parsing_status === "Needs Review");
  }
  // L2: key unchanged and the current text only too long → status left alone.
  const longOk = `${Array.from({ length: 360 }, () => "word").join(" ")}. Choice C is correct.\n\nAnswer: C`;
  const lp2 = keyExplanationPatch({ ...liveRow, parsing_status: "Approved", explanation: longOk }, { outcome: "failed", explanation: null, aiAnswer: null, reason: "x" }, false, false);
  ok("key unchanged, current text only too long → kept, not demoted", !("explanation" in lp2.patch) && !("parsing_status" in lp2.patch));
  const okp = keyExplanationPatch({ ...liveRow, parsing_notes: `${KEY_EXPLANATION_FAILED_PREFIX} C (x) — write and check it by hand` }, { outcome: "regenerated", explanation: goodC, aiAnswer: "C", reason: null }, false);
  ok("success: explanation saved, failure note cleared", okp.ok && okp.patch.explanation === goodC && !String(okp.patch.parsing_notes ?? "").includes(KEY_EXPLANATION_FAILED_PREFIX));

  const ek = await explanationForKey(row({ explanation: goodC, correct_answer: "C" }), "C", { keepCurrent: true, explain: async () => { throw new Error("not called"); } });
  ok("keepCurrent: a current explanation that passes is kept without an AI call", ek.outcome === "kept");
}

// Decimal keys in notes: "0.018" is not a sentence end (live row, set_key).
{
  const live = {
    ...row({ question_type: "Student Produced Response", choices: [], correct_answer: "0.018", official_answer: null, parsing_status: "Approved", question_text: "What is the probability, as a fraction?", parsing_notes: "Answer = official key; checked 0.5 times" }),
    image_alts: [], mismatch_with_official: false,
  } as Record<string, unknown>;
  const test = { id: "t1", status: "Published", is_adaptive: false, module_id: "m1", module_1_id: null, module_2_id: null, module_2_easy_id: null, module_2_hard_id: null, question_ids: [] };
  const assignment = { test_id: "t1", student_ids: ["s1"], class_group_ids: [] };
  const f = fakeDb([live, test, assignment]);
  const goodSpr = "The probability is 4 out of 225.\n\nAnswer: 4/225";
  const res = await decide(f.db, "q1", { action: "set_key", key: "4/225", expectedKey: "0.018", rescore: true }, {
    explain: async () => ({ ok: true as const, explanation: goodSpr, aiAnswer: "4/225", agrees: true, independent: true }),
  });
  const notes = String(live.parsing_notes);
  ok("live set_key: stays Approved, key saved", res.ok && live.parsing_status === "Approved" && live.correct_answer === "4/225");
  ok("live set_key: [live-fix] note leads", notes.startsWith(LIVE_FIX_TAG));
  ok("decimal key kept whole in the note (0.018 → 4/225)", notes.includes("key 0.018 → 4/225") && !/re-check\. 018/.test(notes));
  ok("other decimals in notes untouched", notes.includes("checked 0.5 times"));
}

// Review round 2.
{
  // M3: no second (paid) attempt after a figure conflict or a disagreement.
  let calls = 0;
  const fig = await explanationForKey(row({ correct_answer: "C" }), "C", { explain: async () => { calls++; return { ok: false as const, error: "Figure read conflict: min (2,-3) → (2,-4)", kind: "figure_conflict" as const }; } });
  ok("figure conflict → failed after ONE attempt, reason kept", fig.outcome === "failed" && calls === 1 && /Figure read conflict/.test(fig.reason ?? ""));
  calls = 0;
  const dis = await explanationForKey(row({ correct_answer: "C" }), "C", { explain: async () => { calls++; return { ok: true as const, explanation: "", aiAnswer: "B", agrees: false, independent: true }; } });
  ok("AI disagrees → stops after ONE attempt", dis.outcome === "ai_disagrees" && calls === 1);

  // M4: keep_key whose explanation refresh fails is never reported approved.
  const bad = { ...row({ parsing_status: "Approved", official_answer: null, explanation: "Choice B is correct because the comma is wrong." }), image_alts: [], mismatch_with_official: false } as Record<string, unknown>;
  const fk = fakeDb([bad]);
  const kk = await decide(fk.db, "q1", { action: "keep_key" }, { explain: async () => ({ ok: false as const, error: "x", kind: "failed" as const }) });
  ok("keep_key + failed refresh → approved:false + warning", kk.ok && kk.approved === false && !!kk.warning);

  // H2: a stale page can't write its old key / explanation back.
  const prior = row({ correct_answer: "C", explanation: "new text", updated_at: "2026-11-07T10:00:00Z" });
  ok("stale: base key differs → 409", staleSave(prior, { base: { correct_answer: "A", explanation: "new text" } }));
  ok("stale: base explanation differs (hidden live one = null) → 409", staleSave({ ...prior, explanation: null }, { base: { correct_answer: "C", explanation: "old text" } }));
  ok("stale: expected_updated_at differs → 409", staleSave(prior, { expected_updated_at: "2026-11-07T09:00:00Z" }));
  ok("fresh page → not stale", !staleSave(prior, { base: { correct_answer: "C", explanation: "new text" }, expected_updated_at: "2026-11-07T10:00:00Z" }));
  ok("no base (API caller) → not stale", !staleSave(prior, {}));
  const next = { ...prior, correct_answer: "C" };
  ok("changed explanation that argues another letter (key unchanged) → refused", editedExplanationProblem(prior, next, { explanation: "Choice A is correct because the comma closes it." }) !== null);
  ok("changed explanation that fits → allowed", editedExplanationProblem(prior, next, { explanation: "Choice C is correct because a semicolon joins two independent clauses.\n\nAnswer: C" }) === null);
  ok("L3: emptied explanation → no check (it gets rewritten)", editedExplanationProblem(prior, next, { explanation: "" }) === null);
  ok("unchanged explanation → no check", editedExplanationProblem(prior, next, { explanation: "new text" }) === null);

  // L1: an automatic key change refuses a question that is live right now.
  {
    const lr = { ...row({ parsing_status: "Approved", official_answer: null }), image_alts: [], mismatch_with_official: false } as Record<string, unknown>;
    const t = { id: "t1", status: "Published", is_adaptive: false, module_id: "m1", module_1_id: null, module_2_id: null, module_2_easy_id: null, module_2_hard_id: null, question_ids: [] };
    const f = fakeDb([lr, t, { test_id: "t1", student_ids: ["s1"], class_group_ids: [] }]);
    const r = await applyKeyCorrection(f.db, { id: "q1", correct_answer: "C", expectedKey: "A", rescore: true, source: "auto", refuseLive: true, explain: async () => { throw new Error("not called"); } });
    ok("refuseLive: live question → 409, nothing written", !r.ok && r.status === 409 && f.writes.length === 0 && lr.correct_answer === "A");
  }

  // Decimal-safe live-fix tag (the splitter cut "0.018" at "0.").
  ok("stripLiveFixNote: tag without 're-check.' keeps decimals", stripLiveFixNote("[live-fix] Key 0.018 changed in a live test. Answer key check: key 0.018 → 4/225") === "Answer key check: key 0.018 → 4/225");
  ok("stripLiveFixNote: tag spanning a line break", stripLiveFixNote("[live-fix] Key/type corrected;\nkept Approved — please re-check. Answer key check: key 0.018 → 4/225") === "Answer key check: key 0.018 → 4/225");
  const withDec = "[live-fix] Key 0.018 changed in a live test. Answer key check: key 0.018 → 4/225; Needs review: key says 0.018, AI says 0.02";
  ok("removeNotes keeps the whole decimal note", removeNotes(withDec, (x) => x.startsWith("Needs review: key says")).notes === "[live-fix] Key 0.018 changed in a live test. Answer key check: key 0.018 → 4/225");
  ok("noteSegments with decimals", JSON.stringify(noteSegments("Answer key check: key 0.018 → 4/225; checked 3.5 times")) === JSON.stringify(["Answer key check: key 0.018 → 4/225", "checked 3.5 times"]));
  ok("liveFixNotes keeps decimals", liveFixNotes("Answer key check: key 0.018 → 4/225").endsWith("re-check. Answer key check: key 0.018 → 4/225"));
}

// MEDIUM 8 / LOW: stale proposals, multiple tables.
{
  const r0 = row({ question_text: "Intro\n\n| x | y |\n|---|---|\n| 1 | 4 |\n\nWhat is y?", has_image: true, image_urls: ["https://x.public.blob.vercel-storage.com/a.png"] });
  const stored = currentStored(r0, ["choices", "table", "figure"]);
  ok("currentStored", !!(stored.table === "| x | y |\n|---|---|\n| 1 | 4 |" && stored.imageUrls?.[0]?.endsWith("a.png") && stored.choices?.length === 4));
  ok("proposalIsCurrent: same row", proposalIsCurrent({ stored }, r0));
  ok("proposalIsCurrent: figure replaced since", !proposalIsCurrent({ stored: { imageUrls: stored.imageUrls } }, { ...r0, image_urls: ["https://x.public.blob.vercel-storage.com/b.png"] }));
  ok("proposalIsCurrent: choices edited since", !proposalIsCurrent({ stored: { choices: stored.choices } }, { ...r0, choices: [{ label: "A", text: "Ortelius" }] }));
  ok("proposalIsCurrent: only the compared parts count", proposalIsCurrent({ stored: { imageUrls: stored.imageUrls } }, { ...r0, choices: [] }));
  ok("tableBlockCount", tableBlockCount(r0.question_text) === 1 && tableBlockCount("| a |\n|---|\n\ntext\n\n| b |\n|---|") === 2 && tableBlockCount("none") === 0);

  // decide use_pdf against a proposal served by a stubbed fetch.
  const url = "https://x.public.blob.vercel-storage.com/figure-compare/q1.json";
  const proposalFor = (o: Record<string, unknown>) => ({ version: 1, questionId: "q1", checkedAt: "", pages: "3", parts: ["figure"], diffs: ["figure: cut off"], stored: { imageUrls: r0.image_urls }, pdf: { imageUrls: ["https://x.public.blob.vercel-storage.com/new.png"] }, ...o });
  const realFetch = globalThis.fetch;
  const usePdf = async (prop: Record<string, unknown>, o: Partial<FigureRow> = {}) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(prop), { status: 200 })) as typeof fetch;
    const r = { ...r0, ...o, parsing_notes: figureDiffNote(["figure"], url), image_alts: [], mismatch_with_official: false } as Record<string, unknown>;
    const f = fakeDb([r]);
    try {
      return { res: await decide(f.db, "q1", { action: "use_pdf" }, {}), writes: f.writes };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const a = await usePdf(proposalFor({ checkMarkLeak: true, pdf: {} }));
  ok("use_pdf refuses a check-mark crop", !a.res.ok && a.res.status === 400 && /answer mark/.test(a.res.error ?? "") && a.writes.length === 0);
  const b = await usePdf(proposalFor({}), { image_urls: ["https://x.public.blob.vercel-storage.com/changed.png"] });
  ok("use_pdf refuses a stale proposal with 409", !b.res.ok && b.res.status === 409 && b.writes.length === 0);
  const two = "| a |\n|---|\n| 1 |\n\nand\n\n| b |\n|---|\n| 2 |";
  const c = await usePdf(proposalFor({ parts: ["table"], stored: { table: tableBlock2(two) }, pdf: { table: "| a |\n|---|\n| 9 |" } }), { question_text: two });
  ok("use_pdf refuses a question with two tables", !c.res.ok && c.res.status === 400 && /more than one table/.test(c.res.error ?? "") && c.writes.length === 0);
}
}
function tableBlock2(t: string) {
  return currentStored({ question_text: t, choices: [], image_urls: [] }, ["table"]).table;
}

void reviewFixes().then(
  () => {
    console.log(fail ? `\n${fail} FAILED` : "\nall passed");
    process.exit(fail ? 1 : 0);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
