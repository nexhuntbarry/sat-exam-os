// node --experimental-strip-types .omc/qa/unit/fix-proposal.test.ts
// "No correct choice: likely typo" (Premier ticket 3e0af153): the stored fix
// proposal (lib/fix-proposal.ts), its review-queue group, the fix_choice
// decision (lib/review-decide.ts) and the RAMBLE additions.
import assert from "node:assert/strict";
import "./_resolve.ts";
import { fakeDb } from "./_fake-db.ts";
const fp = await import("../../../lib/fix-proposal.ts");
const rq = await import("../../../lib/review-queue.ts");
const { decide } = await import("../../../lib/review-decide.ts");
const { RAMBLE, draftRejection } = await import("../../../lib/explanation-autofix.ts");
const { undoPlan } = await import("../../../lib/review-queue-view.ts");
const { regenDisagreeNote } = await import("../../../lib/ai/solve-question.ts");
type ExplainFn = import("../../../lib/key-change.ts").ExplainFn;

const QID = "q-13-m1-2";
const choices = () => [
  { label: "A", text: "$\\pi r^2 + 4$" },
  { label: "B", text: "$\\pi r^3 + 4r^2$" },
  { label: "C", text: "$4\\pi r^2$" },
  { label: "D", text: "$4\\pi r^3 + 4\\pi r^2$" },
];
const PROPOSAL = {
  kind: "no_correct_choice" as const,
  summary: "V = πr²(r+4) = πr³ + 4πr², but choice D reads 4πr³ + 4πr²",
  closestChoice: "D",
  whatDiffers: "an extra factor 4 on the πr³ term",
  fix: [{ field: "D" as const, from: "$4\\pi r^3 + 4\\pi r^2$", to: "$\\pi r^3 + 4\\pi r^2$" }],
  keyAfterFix: "D",
  origin: "source" as const,
  createdBy: "local run",
};
const GOOD_EX = "Distribute $\\pi r^2$ over $(r + 4)$: $V = \\pi r^2 \\cdot r + \\pi r^2 \\cdot 4 = \\pi r^3 + 4\\pi r^2$. That is choice D.\n\nAnswer: D";

function question(extra: Record<string, unknown> = {}) {
  return {
    id: QID,
    module_id: "m1",
    original_question_number: 2,
    section: "Math",
    question_type: "Multiple Choice",
    question_text: "The volume of a cylinder is $V = \\pi r^2 (r + 4)$. Which expression is equivalent to $V$?",
    choices: choices(),
    correct_answer: "D",
    official_answer: "D",
    explanation: "Expanding gives D only if the terms are reordered.\n\nAnswer: D",
    parsing_status: "Needs Review",
    parsing_notes: regenDisagreeNote("A", "D"),
    has_image: false,
    image_urls: null,
    image_alts: null,
    has_table: false,
    mismatch_with_official: false,
    updated_at: "2026-11-18T00:00:00.000Z",
    ...extra,
  };
}
const explainOk = (answer = "D"): ExplainFn => async () => ({ ok: true, explanation: GOOD_EX.replace(/D/g, answer), aiAnswer: answer, agrees: true, independent: true });
const explainFails: ExplainFn = async () => ({ ok: false, error: "x", kind: "failed" });

// ── proposal parsing / note / edits ──
assert.ok(fp.parseFixProposal({ ...PROPOSAL, createdAt: "2026-11-18" }));
assert.equal(fp.parseFixProposal({ ...PROPOSAL, kind: "other" }), null, "unknown kind");
assert.equal(fp.parseFixProposal({ ...PROPOSAL, fix: [] }), null, "no edits");
assert.equal(fp.parseFixProposal({ ...PROPOSAL, fix: [{ field: "E", from: "a", to: "b" }] }), null, "unknown field");
assert.equal(fp.parseFixProposal({ ...PROPOSAL, origin: "pdf" }), null, "unknown origin");
assert.equal(fp.parseFixEdits([{ field: "D", from: "a", to: "a" }]), null, "a no-op edit");
const note = fp.fixProposalNote({ kind: "two_correct", summary: "B and C; both work [see p3]" });
assert.ok(note.startsWith(rq.FIX_PROPOSAL_NOTE) && note.includes("Two correct choices:"), note);
assert.ok(!note.includes(";") && !note.includes("[see"), "no separators in the note");

const applied = fp.applyFixEdits({ question_text: "Q", choices: choices() }, PROPOSAL.fix);
assert.deepEqual(applied.conflicts, []);
assert.equal(applied.patch.choices?.find((c) => c.label === "D")?.text, "$\\pi r^3 + 4\\pi r^2$");
assert.equal(applied.patch.question_text, undefined, "text untouched");
const again = fp.applyFixEdits({ question_text: "Q", choices: applied.patch.choices }, PROPOSAL.fix);
assert.deepEqual(again, { patch: {}, conflicts: [] }, "already fixed (by hand): nothing to do, no conflict");
const moved = fp.applyFixEdits({ question_text: "Q", choices: choices().map((c) => (c.label === "D" ? { ...c, text: "$7$" } : c)) }, PROPOSAL.fix);
assert.equal(moved.conflicts.length, 1, "changed since: conflict");
const grow = fp.applyFixEdits({ question_text: "x = 2. Find y.", choices: [] }, [{ field: "questionText", from: "x = 2.", to: "x = 2. y = x + 1." }]);
assert.equal(grow.patch.question_text, "x = 2. y = x + 1. Find y.");
assert.deepEqual(fp.applyFixEdits({ question_text: grow.patch.question_text!, choices: [] }, [{ field: "questionText", from: "x = 2.", to: "x = 2. y = x + 1." }]).patch, {}, "an insert isn't applied twice");
assert.equal(fp.fixDecisionLine(PROPOSAL, "D"), "Fix choice D and keep key D");
assert.equal(fp.fixDecisionLine({ ...PROPOSAL, keyAfterFix: "B" }, "D"), "Fix choice D and change the key D → B");

// ── store: save / load / clear ──
{
  const { db, client } = fakeDb({ questions: [question()], app_settings: [] });
  const res = await fp.saveFixProposal(client, QID, PROPOSAL);
  assert.ok(res.ok);
  const res2 = await fp.saveFixProposal(client, QID, { ...PROPOSAL, summary: "second" });
  assert.ok(res2.ok);
  assert.equal(db.tables.app_settings.length, 1, "one row per question (upsert on key)");
  assert.equal(db.tables.app_settings[0].key, `fix_proposal:${QID}`);
  const notes = db.tables.questions[0].parsing_notes as string;
  assert.equal(notes.split(rq.FIX_PROPOSAL_NOTE).length - 1, 1, "the note is replaced, not added twice");
  assert.ok(notes.includes("second") && notes.includes("AI's own answer is A"), notes);
  assert.equal(db.tables.questions[0].parsing_status, "Needs Review", "status untouched");
  const loaded = await fp.loadFixProposals(client, [QID, "other"]);
  assert.equal(loaded.size, 1);
  assert.equal(loaded.get(QID)!.summary, "second");
  assert.equal((await fp.saveFixProposal(client, QID, { ...PROPOSAL, fix: [] })).ok, false, "malformed refused");
  await fp.clearFixProposal(client, QID);
  assert.equal((await fp.loadFixProposals(client, [QID])).size, 0);
  assert.equal(fp.dropFixProposalNote(notes), regenDisagreeNote("A", "D"));
}

// ── group assignment ──
{
  const row = (notes: string) => ({ ...question(), explanation: GOOD_EX, parsing_notes: notes });
  for (const kind of ["no_correct_choice", "two_correct", "merged", "missing_text"] as const) {
    const g = rq.groupRow(row(`${regenDisagreeNote("A", "D")}; ${fp.fixProposalNote({ kind, summary: "x" })}`));
    assert.equal(g.primary, "typo_fix", `${kind}: above key_dispute`);
    assert.ok(g.groups.includes("key_dispute"));
    assert.ok(g.reasons[0].text.includes(rq.FIX_KIND_LABEL[kind]), "the reason names the kind");
  }
  // Even with a broken-stem note (merged / missing text): the fix leads.
  assert.equal(rq.groupRow(row(`question text looks cut off; ${fp.fixProposalNote({ kind: "missing_text", summary: "x" })}`)).primary, "typo_fix");
  assert.ok(rq.approvalBlockers(row(fp.fixProposalNote({ kind: "merged", summary: "two problems" }))).length > 0, "a proposal blocks approval");
  assert.equal(rq.GROUP_BY_ID.typo_fix.label, "No correct choice: likely typo");
  assert.equal(rq.isStaleKeyNote(fp.fixProposalNote(PROPOSAL), "D"), false);
  assert.equal(rq.isKeyQuestionNote(fp.fixProposalNote(PROPOSAL), "D"), false);
  // Notes housekeeping: the "AI's own answer is A" note goes on any key change.
  assert.equal(rq.dropStaleKeyNotes(regenDisagreeNote("A", "D"), "D", "B").notes, null);
  assert.equal(rq.isKeyQuestionNote(regenDisagreeNote("A", "D"), "D"), true, "and on keeping the key");
}

// ── fix_choice: key unchanged (no rescore) ──
assert.equal(draftRejection({ ...question(), choices: applied.patch.choices } as never, GOOD_EX), null, "the stub explanation passes the checks");
{
  const { db, client } = fakeDb({ questions: [question()], app_settings: [], answer_records: [] });
  await fp.saveFixProposal(client, QID, PROPOSAL);
  db.log.length = 0;
  const res = await decide(client, QID, { action: "fix_choice" }, { userId: "u1", userName: "Premier", explain: explainOk() });
  assert.equal(res.ok, true, JSON.stringify(res));
  const q = db.tables.questions[0];
  assert.equal((q.choices as { label: string; text: string }[]).find((c) => c.label === "D")!.text, "$\\pi r^3 + 4\\pi r^2$");
  assert.equal(q.correct_answer, "D");
  assert.equal(q.explanation, GOOD_EX, "explanation rewritten for the fixed question");
  const notes = (q.parsing_notes as string | null) ?? "";
  assert.ok(!notes.includes(rq.FIX_PROPOSAL_NOTE), notes);
  assert.ok(!notes.includes("AI's own answer is A"), "stale AI note about another answer dropped");
  assert.ok(notes.includes(rq.FIX_APPLIED_PREFIX), notes);
  assert.equal(res.approved, true, JSON.stringify(res));
  assert.equal(q.parsing_status, "Approved");
  assert.equal(db.tables.app_settings.length, 0, "proposal cleared");
  assert.ok(!db.log.includes("answer_records:select"), "key unchanged: nothing rescored");
}

// ── fix_choice: explanation can't be written → stays in the queue, bad text never saved ──
{
  const { db, client } = fakeDb({ questions: [question()], app_settings: [], answer_records: [] });
  await fp.saveFixProposal(client, QID, PROPOSAL);
  const res = await decide(client, QID, { action: "fix_choice" }, { userId: "u1", explain: explainFails });
  assert.equal(res.ok, true);
  assert.equal(res.approved, false);
  assert.ok(res.warning);
  const q = db.tables.questions[0];
  assert.equal(q.parsing_status, "Needs Review");
  assert.equal(q.explanation, question().explanation, "no new text saved");
  assert.ok((q.parsing_notes as string).includes(rq.FIX_EXPLANATION_NOTE));
  // No independent agreement: the "AI's own answer is A" note stays (key decision), the explanation is next too.
  assert.equal(rq.groupRow(q as never).primary, "key_dispute");
  assert.ok(rq.groupRow(q as never).groups.includes("explanation"), "and the explanation group");
  assert.equal(db.tables.app_settings.length, 0, "the fix itself is applied: proposal cleared");
  // A checked rewrite later settles the note.
  const again = await decide(client, QID, { action: "regen_explanation" }, { explain: explainOk() });
  assert.equal(again.ok, true);
  assert.ok(!((db.tables.questions[0].parsing_notes as string | null) ?? "").includes(rq.FIX_EXPLANATION_NOTE));
}

// ── fix_choice: key changes → preview / rescore flag required ──
const KEY_B = { ...PROPOSAL, kind: "two_correct" as const, fix: [{ field: "D" as const, from: "$4\\pi r^3 + 4\\pi r^2$", to: "$4\\pi r^3$" }], keyAfterFix: "B" };
{
  const { db, client } = fakeDb({ questions: [question({ choices: [...choices().slice(0, 1), { label: "B", text: "$\\pi r^3 + 4\\pi r^2$" }, ...choices().slice(2)] })], app_settings: [], answer_records: [] });
  await fp.saveFixProposal(client, QID, KEY_B);
  db.log.length = 0;
  const no = await decide(client, QID, { action: "fix_choice" }, { explain: explainOk("B") });
  assert.equal(no.ok, false);
  assert.equal(no.status, 409);
  assert.match(no.error!, /preview/);
  const stale = await decide(client, QID, { action: "fix_choice", rescore: true, expectedKey: "C" }, { explain: explainOk("B") });
  assert.equal(stale.ok, false, "preview made for another key");
  assert.ok(!db.log.some((l) => l === "questions:update" || l === "answer_records:select"), "nothing written or rescored");

  const yes = await decide(client, QID, { action: "fix_choice", rescore: true, expectedKey: "D" }, { userName: "Premier", explain: explainOk("B") });
  assert.equal(yes.ok, true, JSON.stringify(yes));
  const q = db.tables.questions[0];
  assert.equal(q.correct_answer, "B");
  assert.equal((q.choices as { label: string; text: string }[]).find((c) => c.label === "D")!.text, "$4\\pi r^3$");
  assert.ok(db.log.includes("answer_records:select"), "rescored through applyKeyCorrection");
  assert.equal(yes.key && yes.key.ok && yes.key.keyChanged, true);
  assert.ok(!((q.parsing_notes as string | null) ?? "").includes(rq.FIX_PROPOSAL_NOTE));
  assert.ok(!((q.parsing_notes as string | null) ?? "").includes("AI's own answer is A"));
  assert.equal(db.tables.app_settings.length, 0);
}

// ── edited fix (the inline editor) ──
{
  const { db, client } = fakeDb({ questions: [question()], app_settings: [], answer_records: [] });
  await fp.saveFixProposal(client, QID, PROPOSAL);
  const res = await decide(client, QID, { action: "fix_choice", fix: [{ field: "D", from: "$4\\pi r^3 + 4\\pi r^2$", to: "$\\pi r^3+4\\pi r^2$" }] }, { explain: explainOk() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((db.tables.questions[0].choices as { label: string; text: string }[])[3].text, "$\\pi r^3+4\\pi r^2$");
  const none = await decide(client, QID, { action: "fix_choice" }, { explain: explainOk() });
  assert.equal(none.status, 400, "no stored proposal");
}

// ── Accept is not a key decision: unrelated disputes and the official answer stay ──
{
  const keySays = "Needs review: key says D, AI says A (from the PDF key page)";
  const { db, client } = fakeDb({ questions: [question({ parsing_notes: keySays, official_answer: "C", mismatch_with_official: true })], app_settings: [], answer_records: [] });
  await fp.saveFixProposal(client, QID, PROPOSAL);
  const res = await decide(client, QID, { action: "fix_choice" }, { explain: explainOk() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.approved, false);
  const q = db.tables.questions[0];
  assert.ok((q.parsing_notes as string).includes(keySays), "the key dispute stays for the key decision");
  assert.equal(q.official_answer, "C", "official answer not overruled");
  assert.equal(q.mismatch_with_official, true);
  assert.equal(rq.groupRow(q as never).primary, "key_dispute", "next: the key decision");
  assert.equal((q.choices as { text: string }[])[3].text, "$\\pi r^3 + 4\\pi r^2$", "the fix itself is applied");
}

// ── key change validated before any write; a failing key write leaves nothing behind ──
{
  const { db, client } = fakeDb({ questions: [question()], app_settings: [], answer_records: [] });
  await fp.saveFixProposal(client, QID, { ...PROPOSAL, keyAfterFix: "E" });
  db.log.length = 0;
  const bad = await decide(client, QID, { action: "fix_choice", rescore: true, expectedKey: "D" }, { explain: explainOk("E") });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400, JSON.stringify(bad));
  assert.ok(!db.log.includes("questions:update"), "a key that doesn't fit the fixed choices: nothing written");
}
{
  const before = question({ choices: [...choices().slice(0, 1), { label: "B", text: "$\\pi r^3 + 4\\pi r^2$" }, ...choices().slice(2)] });
  const { db, client } = fakeDb({ questions: [structuredClone(before)], app_settings: [], answer_records: [] });
  await fp.saveFixProposal(client, QID, KEY_B);
  const snap = structuredClone(db.tables.questions[0]);
  // The key step's write fails (a concurrent change, a DB error…).
  const realFrom = db.from.bind(db);
  db.from = (table: string) => {
    const q = realFrom(table);
    if (table === "questions") {
      const upd = q.update.bind(q);
      q.update = (p: Record<string, unknown>) => {
        db.errors.questions = { message: "write failed" };
        return upd(p);
      };
    }
    return q;
  };
  db.log.length = 0;
  const res = await decide(client, QID, { action: "fix_choice", rescore: true, expectedKey: "D" }, { explain: explainOk("B") });
  delete db.errors.questions;
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(res.error!, /Nothing was saved/);
  assert.deepEqual(db.tables.questions[0], snap, "no fixed text with the old key, no stale explanation");
  assert.ok(!db.log.includes("answer_records:select"), "nothing rescored");
  assert.equal(db.tables.app_settings.length, 1, "proposal kept for another try");
  db.from = realFrom;
}

// ── live test: [live-fix] note, snapshot across both writes, Undo holds the old key ──
const { snapshotValid } = await import("../../../lib/live-fix.ts");
const liveWorld = (q: Record<string, unknown>) =>
  fakeDb({
    questions: [q],
    app_settings: [],
    answer_records: [],
    tests: [{ id: "T", status: "Published", is_adaptive: false, module_id: "m1", module_1_id: null, module_2_id: null, module_2_easy_id: null, module_2_hard_id: null, question_ids: null, parent_test_id: null, section_order: null }],
    test_assignments: [{ test_id: "T", student_ids: ["s1"], class_group_ids: [] }],
  });
{
  const { db, client } = liveWorld(question({ parsing_status: "Approved" }));
  await fp.saveFixProposal(client, QID, PROPOSAL);
  const res = await decide(client, QID, { action: "fix_choice" }, { userName: "Premier", explain: explainOk() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.live, true);
  const q = db.tables.questions[0];
  assert.equal(q.parsing_status, "Approved", "never demoted");
  assert.ok((q.parsing_notes as string).startsWith("[live-fix]"), q.parsing_notes as string);
  const snapRow = db.tables.app_settings.find((r) => r.key === `live_fix_before:${QID}`);
  assert.ok(snapRow, "earlier version recorded");
  const snap = snapRow!.value as { fields: Record<string, unknown> };
  assert.equal((snap.fields.choices as { text: string }[])[3].text, "$4\\pi r^3 + 4\\pi r^2$", "what students saw before");
  assert.ok(snapshotValid(snap as never, q.parsing_notes as string));
  assert.equal(undoPlan({ action: "fix_choice", live: true, keyChanged: undefined, keyAfter: "D", updatedAt: "x" }).kind, "undo_live_fix");
}
{
  const { db, client } = liveWorld(question({ parsing_status: "Approved", choices: [...choices().slice(0, 1), { label: "B", text: "$\\pi r^3 + 4\\pi r^2$" }, ...choices().slice(2)] }));
  await fp.saveFixProposal(client, QID, KEY_B);
  const res = await decide(client, QID, { action: "fix_choice", rescore: true, expectedKey: "D" }, { userName: "Premier", explain: explainOk("B") });
  assert.equal(res.ok, true, JSON.stringify(res));
  const q = db.tables.questions[0];
  assert.equal(q.correct_answer, "B");
  assert.equal(q.parsing_status, "Approved");
  assert.ok((q.parsing_notes as string).startsWith("[live-fix]"));
  assert.ok(!(q.parsing_notes as string).includes(rq.FIX_PROPOSAL_NOTE));
  const snap = db.tables.app_settings.find((r) => r.key === `live_fix_before:${QID}`)!.value as { fields: Record<string, unknown> };
  assert.equal(snap.fields.correct_answer, "D", "old key recorded");
  assert.equal((snap.fields.choices as { text: string }[])[3].text, "$4\\pi r^3 + 4\\pi r^2$", "old choices recorded");
  assert.ok(snapshotValid(snap as never, q.parsing_notes as string), "the snapshot still belongs to the change after the notes write");
  const rec = { action: "fix_choice", live: !!(res.live ?? (res.key && res.key.ok && res.key.live)), keyChanged: res.key && res.key.ok ? res.key.keyChanged : undefined, oldKey: res.key && res.key.ok ? res.key.oldKey : null, newKey: "B", keyAfter: "B", updatedAt: "x" };
  assert.deepEqual(undoPlan(rec), { kind: "undo_live_fix", restoreKey: "D" });
}

// ── Dismiss: the note and the stored row go, nothing else changes ──
{
  const { db, client } = fakeDb({ questions: [question({ parsing_notes: fp.fixProposalNote(PROPOSAL) })], app_settings: [] });
  const res = await decide(client, QID, { action: "dismiss_fix" }, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const q = db.tables.questions[0];
  assert.ok(!((q.parsing_notes as string | null) ?? "").includes(rq.FIX_PROPOSAL_NOTE), "stuck note (no stored row) cleared");
  assert.equal(q.parsing_status, "Needs Review", "never approved by a dismiss");
  assert.equal((q.choices as { text: string }[])[3].text, "$4\\pi r^3 + 4\\pi r^2$");
  await fp.saveFixProposal(client, QID, PROPOSAL);
  await decide(client, QID, { action: "dismiss_fix" }, {});
  assert.equal(db.tables.app_settings.length, 0);
}

// ── edit limits ──
assert.equal(fp.parseFixEdits([{ field: "D", from: "a", to: "" }]), null, "a choice is never emptied");
assert.equal(fp.parseFixEdits([{ field: "questionText", from: "a", to: "x".repeat(fp.MAX_FIX_TEXT + 1) }]), null, "too long");
assert.ok(fp.parseFixEdits([{ field: "questionText", from: "a", to: "" }]), "text may be cut");

// ── Undo plan ──
assert.equal(undoPlan({ action: "fix_choice", live: false, keyAfter: "D", updatedAt: "x" }).kind, "none");
assert.deepEqual(undoPlan({ action: "fix_choice", live: true, keyChanged: true, oldKey: "D", newKey: "B", keyAfter: "B", updatedAt: "x" }), { kind: "undo_live_fix", restoreKey: "D" });

// ── RAMBLE: self-correcting narration is never saved ──
for (const s of [
  "So the answer is $4\\pi r^3$ … wait — no, the first term is $\\pi r^3$.",
  "This matches D only if the terms are reordered.",
  "It equals choice B only if the factors are rearranged.",
]) assert.ok(RAMBLE.test(s), s);
for (const s of ["Customers wait, on average, 4 minutes.", "The equation holds only if the terms are equal.", "Reorder the terms to get $\\pi r^3 + 4\\pi r^2$."]) assert.ok(!RAMBLE.test(s), s);
assert.ok(draftRejection({ ...question(), choices: applied.patch.choices } as never, question().explanation), "the old ramble explanation is rejected");

console.log("fix-proposal: all assertions passed");
