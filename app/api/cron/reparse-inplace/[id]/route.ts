import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import {
  parsePdfToQuestions,
  simpleEmbedding,
  extractAnswerKey,
  fetchPdfAsBase64,
} from "@/lib/ai/parse-pdf";
import { solveQuestionsAndPersist, explainOfficialAndPersist, regenerateTruncatedExplanations } from "@/lib/ai/solve-question";
import { autoFixModuleExplanations } from "@/lib/explanation-autofix";
import { runPostParseCleanup } from "@/lib/post-parse-cleanup";
import { runSemanticAudit } from "@/lib/ai/semantic-audit";
import { recoverMissingFigures, recoverBrokenChoices } from "@/lib/repair-ops";
import {
  enforceCompleteness,
  checkNumberContiguity,
  keyModuleMismatchNote,
  keyDisagreementNote,
  flagQuestionsForReview,
  enforceStemIntegrity,
  enforceAnswerKeyForm,
} from "@/lib/parse-guards";
import { autoPromoteModule } from "@/lib/auto-promote";
import { applyLiveHold, liveQuestionIds, type LiveHoldRow } from "@/lib/live-questions";
import { KEY_ROW_SELECT } from "@/lib/key-change";
import { markNotRescored, rescoreOfficialKeyChanges } from "@/lib/reparse-rescore";
import { withQueueInvalidation } from "@/lib/review-queue-cache";
import { explanationArguesOther } from "@/lib/explanation-autofix";
import { restoreStoredKeys } from "@/lib/reparse-key-restore";
import { extractChoicesFromPdfText, readLabelTicks } from "@/lib/pdf-text-choices";
import {
  deterministicTicks,
  reparseKeyDecision,
  storedKeyAfterSolve,
  type ReparseKeyDecision,
  type TickEvidence,
} from "@/lib/answer-key-merge";

export const maxDuration = 800;

// POST /api/admin/modules/[id]/reparse-inplace
//
// Re-parses a module IN PLACE: re-extracts every question from the PDF and
// overwrites the existing question rows BY question-number (keeping their ids),
// so answer_records FKs stay intact — no duplicate rows, no student-history
// loss. Seeds correct_answer from the official answer key (auto-extracted, or
// the official_answer already stored on the rows), runs the solver, reconciles
// against official, then cleanup + semantic audit + auto-promote.
//
// Gated by CRON_SECRET (Authorization: Bearer <CRON_SECRET>) rather than Clerk
// so it can be driven from a script. Meant for repairing the handful of modules
// that were badly parsed before the current pipeline existed.
async function handlePOST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = getServiceClient();
  const t0 = Date.now();

  const { data: mod } = await db
    .from("modules")
    .select("id, module_name, pdf_url, section, difficulty, module_number")
    .eq("id", id)
    .single();
  if (!mod) return NextResponse.json({ error: "Module not found" }, { status: 404 });

  // Existing rows (preserve ids) + the keys already on file. A stored key is
  // never changed here: a disagreeing ✓ or probe only sends the row to Needs
  // Review (lib/answer-key-merge.ts reparseKeyDecision).
  const { data: existing } = await db
    .from("questions")
    .select("id, original_question_number, official_answer, parsing_status, parsing_notes, correct_answer")
    .eq("module_id", id);
  const idByNum = new Map<number, string>();
  const storedByNum = new Map<number, { official: string | null; correct: string | null }>();
  for (const r of existing ?? []) {
    idByNum.set(r.original_question_number, r.id);
    storedByNum.set(r.original_question_number, {
      official: (r.official_answer as string | null) ?? null,
      correct: (r.correct_answer as string | null) ?? null,
    });
  }
  // Approved rows in a live test are not overwritten (that would clear their
  // figures and answer mid-exam) — they're only tagged for re-check.
  const existingById = new Map((existing ?? []).map((r) => [r.id as string, r as LiveHoldRow]));
  const live = await liveQuestionIds(
    db,
    (existing ?? []).filter((r) => r.parsing_status === "Approved").map((r) => r.id as string),
  );

  // This run's reading of the PDF's answer key (printed numbering until the
  // questions are renumbered below).
  let probeKey: Record<number, string> = {};
  // Key page titled for a different module than the questions → not applied.
  let keyModuleNote: string | null = null;
  let b64: string | null = null;
  try {
    b64 = await fetchPdfAsBase64(mod.pdf_url);
    const key = await extractAnswerKey(b64);
    keyModuleNote = key.found
      ? keyModuleMismatchNote(key.keyTitle, key.questionHeader, mod.module_name, mod.module_number)
      : null;
    if (keyModuleNote) {
      console.warn(`[reparse-inplace] answer key NOT applied — key page "${key.keyTitle}" vs questions "${key.questionHeader ?? mod.module_name}"`);
    } else if (key.found) {
      probeKey = { ...key.answers };
    }
  } catch (err) {
    console.error("[reparse-inplace] answer-key extract failed (using stored):", err);
  }

  // Re-extract questions.
  let parsed;
  try {
    parsed = await parsePdfToQuestions(mod.pdf_url, {
      section: mod.section as "Math" | "Reading & Writing",
      difficulty_hint: (mod.difficulty ?? "Mixed") as "Easy" | "Medium" | "Hard" | "Mixed",
      moduleNumber: mod.module_number ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Parse failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  if (!parsed.length) {
    return NextResponse.json({ error: "Parse returned 0 questions — module left untouched" }, { status: 422 });
  }

  // Normalize to 1..N so a booklet-slice numbered e.g. 137–163 maps onto the
  // existing 1..27 rows (mapping below is by original_question_number).
  // The probe's key is renumbered the same way (as in the parse route).
  let numberOffset = 0;
  {
    const minNum = Math.min(...parsed.map((q) => q.original_question_number));
    const offset = minNum - 1;
    if (offset > 0) {
      numberOffset = offset;
      for (const q of parsed) q.original_question_number -= offset;
      probeKey = Object.fromEntries(Object.entries(probeKey).map(([n, v]) => [Number(n) - offset, v]));
    }
  }

  // The PDF's own ✓ (no AI), then one key decision per question: the stored
  // key stays (disagreement → Needs Review); a row without one takes this
  // run's probe under the parse route's probe rules.
  let ticks = new Map<number, TickEvidence>();
  let tickReaderNotes: string[] = [];
  if (b64) {
    try {
      const pdfText = await extractChoicesFromPdfText(b64);
      const labelTicks = pdfText.hasTextLayer ? await readLabelTicks(b64) : null;
      ({ ticks, notes: tickReaderNotes } = deterministicTicks(
        parsed.map((q) => ({ n: q.original_question_number, question_type: q.question_type ?? null, choices: q.choices })),
        pdfText,
        labelTicks,
        numberOffset,
      ));
      for (const note of tickReaderNotes) console.warn(`[reparse-inplace] ${note}`);
    } catch (err) {
      console.error("[reparse-inplace] PDF ✓ pass failed (non-fatal):", err);
    }
  }
  const keyByNum = new Map<number, ReparseKeyDecision>();
  for (const q of parsed) {
    const n = q.original_question_number;
    const stored = storedByNum.get(n);
    keyByNum.set(n, reparseKeyDecision(
      { storedOfficial: stored?.official ?? null, storedCorrect: stored?.correct ?? null, probe: probeKey[n] ?? null, type: q.question_type ?? null },
      ticks.get(n),
    ));
  }
  const keyEntries = [...keyByNum.values()].filter((d) => d.official).length;
  /** Rows a person must decide (stored key vs the PDF): kept in review, never promoted or rescored. */
  const keyReviewIds = new Map<string, ReparseKeyDecision>();
  /** Written rows that already had a key: it goes back after the solver. */
  const storedKeyIds = new Map<string, ReparseKeyDecision>();
  console.log(
    `[reparse-inplace] ${ticks.size} ✓ read from the PDF, ${[...keyByNum.values()].filter((d) => d.note).length} replaced the probe's answer, ${[...keyByNum.values()].filter((d) => d.review.length).length} sent to review`,
  );

  // Overwrite rows in place by question number.
  let updated = 0, inserted = 0;
  const seen = new Set<number>();
  for (const q of parsed) {
    seen.add(q.original_question_number);
    const decision = keyByNum.get(q.original_question_number);
    const official = decision?.official ?? null;
    const review = decision?.review ?? [];
    const fields: Record<string, unknown> = {
      section: mod.section,
      question_text: q.question_text,
      choices: q.choices,
      correct_answer: decision?.seed ?? null,
      explanation: null,
      difficulty: q.difficulty,
      domain: q.domain,
      skill: q.skill,
      concept: q.concept,
      question_type: q.question_type,
      has_image: q.has_image,
      has_table: q.has_table,
      has_formula: q.has_formula,
      source_pdf_url: mod.pdf_url,
      page_number: q.page_number,
      parsing_status: review.length ? "Needs Review" : "Draft",
      parsing_notes: ["Re-parsed in place", decision?.note, ...review].filter(Boolean).join("; "),
      ai_confidence_score: q.ai_confidence_score,
      question_text_embedding: simpleEmbedding(q.question_text),
      official_answer: official,
      image_urls: [],
      image_alts: [],
      updated_at: new Date().toISOString(),
    };
    const existingId = idByNum.get(q.original_question_number);
    const cur = existingId ? existingById.get(existingId) : undefined;
    if (existingId && cur && live.has(existingId) && cur.parsing_status === "Approved") {
      const { update } = applyLiveHold(
        cur,
        { parsing_status: "Draft", parsing_notes: "Re-parse not applied to this question.", updated_at: new Date().toISOString() },
        "Module re-parsed",
        live,
      );
      await db.from("questions").update(update).eq("id", existingId);
    } else if (existingId) {
      await db.from("questions").update(fields).eq("id", existingId);
      if (review.length && decision) keyReviewIds.set(existingId, decision);
      if (decision?.storedKey) storedKeyIds.set(existingId, decision);
      updated++;
    } else {
      const { data: ins } = await db
        .from("questions")
        .insert({ module_id: id, original_question_number: q.original_question_number, ...fields })
        .select("id")
        .maybeSingle();
      if (review.length && decision && ins?.id) keyReviewIds.set(ins.id as string, decision);
      inserted++;
    }
  }
  const orphans = [...idByNum.keys()].filter((n) => !seen.has(n));

  await db
    .from("modules")
    .update({
      parsing_status: "parsed",
      total_questions: parsed.length,
      parsing_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  // Solve, then reconcile the official key over the solver's guesses.
  const solverStats = await solveQuestionsAndPersist(parsed, new Map(), id, db);
  // A stored key is never overwritten by the solver: put it back on every row
  // that had one. A solver answer that disagrees → Needs Review ("solver says
  // X, stored key Y"), and the row is never rescored. Rows with no stored key
  // keep the solver / official-key flow below.
  const solverById = new Map<string, string | null>();
  /** updated_at of the run's own write putting the stored key back (the restore's "ours" check). */
  const solverWrittenAt = new Map<string, string>();
  for (const [qid, d] of storedKeyIds) {
    const { data: row, error: readErr } = await db.from("questions").select("correct_answer, parsing_notes, parsing_status, updated_at").eq("id", qid).maybeSingle();
    if (readErr) console.error(`[reparse-inplace] read ${qid} after the solver:`, readErr.message);
    if (!row || !d.seed) continue;
    const solver = (row.correct_answer as string | null) ?? null;
    solverById.set(qid, solver);
    const after = storedKeyAfterSolve(d.seed, solver);
    const review = [...d.review, ...(after.review ? [after.review] : [])];
    const notes = ((row.parsing_notes as string | null) ?? "").split(";").map((x) => x.trim()).filter(Boolean);
    for (const r of review) if (!notes.includes(r)) notes.push(r);
    const update: Record<string, unknown> = { correct_answer: after.correct, updated_at: new Date().toISOString() };
    if (review.length) {
      update.parsing_status = "Needs Review";
      update.parsing_notes = notes.join("; ");
      keyReviewIds.set(qid, d);
    }
    // The solver's explanation argues its own answer, not the stored key.
    if (after.review) update.explanation = null;
    // Compare-and-set: only over what the solver left.
    let w = db.from("questions").update(update).eq("id", qid);
    w = row.updated_at == null ? w.is("updated_at", null) : w.eq("updated_at", row.updated_at);
    w = solver == null ? w.is("correct_answer", null) : w.eq("correct_answer", solver);
    const { data: wrote, error: wErr } = await w.select("updated_at");
    if (wErr) console.error(`[reparse-inplace] put back stored key ${qid}:`, wErr.message);
    else if (wrote?.[0]?.updated_at) solverWrittenAt.set(qid, wrote[0].updated_at as string);
    // Otherwise the row changed under us: the final restore treats it as a person's edit.
  }
  /** id → stored key: explain-official and the truncation guard explain these, never rewrite the key. */
  const storedKeyMap = new Map([...storedKeyIds].map(([qid, d]) => [qid, d.seed!] as [string, string]));

  let reconciled = 0;
  const { data: rows } = await db
    .from("questions")
    .select(KEY_ROW_SELECT)
    .eq("module_id", id)
    .not("official_answer", "is", null);
  let keyCompared = 0;
  const keyDisagreeNums: number[] = [];
  /** Rows whose key was set to the official one here (rescored after the key guards). */
  const keyChangedIds: string[] = [];
  for (const r of rows ?? []) {
    const off = r.official_answer as string;
    const storedRow = storedKeyIds.has(r.id as string);
    const ai = storedRow ? (solverById.get(r.id as string) ?? null) : (r.correct_answer as string | null);
    const agree =
      !!ai && !!off &&
      (ai.trim().length === 1 && off.trim().length === 1
        ? ai.trim().toUpperCase() === off.trim().toUpperCase()
        : ai.trim().replace(/\s+/g, "") === off.trim().replace(/\s+/g, ""));
    const isMc = r.question_type === "Multiple Choice";
    if (isMc && ai) keyCompared++;
    if (!agree && isMc && ai && storedRow) keyDisagreeNums.push(r.original_question_number as number);
    // Stored-key rows were settled above: their key is not replaced here.
    if (storedRow) continue;
    if (!agree) {
      if (isMc && ai) keyDisagreeNums.push(r.original_question_number as number);
      reconciled++;
      const notes = `Re-parse: official key=${off}, solver said ${ai ?? "?"} — verify`;
      const { update, held } = applyLiveHold(
        r as LiveHoldRow,
        { correct_answer: off, parsing_status: "Needs Review", parsing_notes: notes, updated_at: new Date().toISOString() },
        "Official key disagrees with the stored answer",
        live,
      );
      // A live question keeps its key (held above). Otherwise the official
      // key is saved with NO explanation (the old one argued the solver's
      // answer) and the row stays in Needs Review; the explanation is written
      // and checked later by the explain / auto-fix passes. No AI here and no
      // rescoring yet: the key is only trusted after the module-level key
      // guards below.
      if (!held) {
        update.explanation = null;
        keyChangedIds.push(r.id as string);
      }
      await db.from("questions").update(update).eq("id", r.id);
    }
  }
  // Stored key vs the PDF: put the stored key back (the solver may have
  // overwritten it), keep the row in Needs Review with its notes, and leave it
  // out of rescoring — a person decides.
  for (const [qid, d] of keyReviewIds) {
    if (storedKeyIds.has(qid)) continue;
    const { data: row } = await db.from("questions").select("parsing_notes").eq("id", qid).maybeSingle();
    const notes = ((row?.parsing_notes as string | null) ?? "").split(";").map((x) => x.trim()).filter(Boolean);
    for (const r of d.review) if (!notes.includes(r)) notes.push(r);
    await db
      .from("questions")
      .update({ correct_answer: d.seed, parsing_status: "Needs Review", parsing_notes: notes.join("; "), updated_at: new Date().toISOString() })
      .eq("id", qid);
  }
  const heldForPerson = keyChangedIds.filter((x) => keyReviewIds.has(x));
  if (heldForPerson.length) {
    keyChangedIds.splice(0, keyChangedIds.length, ...keyChangedIds.filter((x) => !keyReviewIds.has(x)));
    await markNotRescored(db, heldForPerson, "the stored key disagrees with the PDF — a person decides");
  }

  let cleanup, explained, audit, figures, choicesRecovery, promote;
  let rescored: { rescored: number; held: number } | undefined;
  try { cleanup = await runPostParseCleanup(id, db); } catch (e) { cleanup = { error: String(e) }; }
  // Explain toward the official answer BEFORE the audit — same as the parse
  // pipeline's Phase 4b — so the audit sees consistent answer↔explanation pairs.
  try { explained = await explainOfficialAndPersist(id, db, undefined, storedKeyMap); } catch (e) { explained = { error: String(e) }; }
  try { await regenerateTruncatedExplanations(id, db, undefined, storedKeyMap); } catch (e) { console.error("[reparse-inplace] truncation-guard:", e); }
  try { audit = await runSemanticAudit(id, db); } catch (e) { audit = { error: String(e) }; }
  try { figures = await recoverMissingFigures(id, db); } catch (e) { figures = { error: String(e) }; }
  try { choicesRecovery = await recoverBrokenChoices(id, db); } catch (e) { choicesRecovery = { error: String(e) }; }
  // Explanation-only problems: regenerate from the key, approve when nothing else is wrong.
  try { await autoFixModuleExplanations(id, db); } catch (e) { console.error("[reparse-inplace] explanation-autofix:", e); }
  try { await enforceCompleteness(id, db); } catch (e) { console.error("[reparse-inplace] completeness-gate:", e); }
  try { await enforceAnswerKeyForm(id, db); } catch (e) { console.error("[reparse-inplace] key-form gate:", e); }
  // Answer-key + stem guards — after every pass that can Approve, before auto-promote.
  // undefined = the guards didn't get as far as deciding (then nothing is rescored).
  let moduleKeyWarning: string | null | undefined;
  try {
    if (keyModuleNote) await flagQuestionsForReview(id, db, keyModuleNote);
    const disagreeNote = keyDisagreementNote(keyDisagreeNums.length, keyCompared);
    moduleKeyWarning = keyModuleNote ?? disagreeNote ?? null;
    if (disagreeNote) await flagQuestionsForReview(id, db, disagreeNote, keyDisagreeNums);
    await enforceStemIntegrity(id, db);
  } catch (e) { console.error("[reparse-inplace] key/stem guards:", e); }
  // Safety net, after every AI pass and before rescoring / auto-promote.
  // explain-official and the truncation guard got storedKeyMap and never write
  // these keys; this only puts the stored key back where the run's own solver
  // answer is still there — compare-and-set, never over a person's edit, live
  // rows only tagged (lib/reparse-key-restore.ts). If it can't finish, the
  // module is not auto-promoted.
  let keysRestored = 0;
  let skipPromote = false;
  try {
    const res = await restoreStoredKeys(
      [...storedKeyIds].map(([qid, d]) => ({ id: qid, stored: d.seed!, solver: solverById.get(qid) ?? null, solverWrittenAt: solverWrittenAt.get(qid) ?? null })),
      {
        db,
        liveIds: (ids) => liveQuestionIds(db, ids),
        arguesOther: (r, key) => explanationArguesOther(r.explanation, key, r.question_type, r.question_text),
        markNotRescored: (ids, why) => markNotRescored(db, ids, why),
      },
    );
    keysRestored = res.restored;
    skipPromote = res.skipPromote;
    if (res.restored || res.personEdits.length || res.liveHeld.length || res.failed.length) {
      console.warn(`[reparse-inplace] stored-key restore: ${res.restored} restored, ${res.personEdits.length} person edits kept, ${res.liveHeld.length} live tagged, ${res.failed.length} failed`);
    }
  } catch (e) {
    console.error("[reparse-inplace] stored-key restore:", e);
    skipPromote = true;
    await markNotRescored(db, [...storedKeyIds.keys()], "the re-parse couldn't confirm the stored key");
  }
  // Rescoring to the official key runs on its own: whatever stops it, the
  // rows get the "not rescored" note so a person sees it.
  try {
    if (moduleKeyWarning === undefined) {
      await markNotRescored(db, keyChangedIds, "the module's key checks didn't finish");
      rescored = { rescored: 0, held: keyChangedIds.length };
    } else {
      rescored = await rescoreOfficialKeyChanges(db, id, keyChangedIds, moduleKeyWarning);
    }
  } catch (e) {
    console.error("[reparse-inplace] rescore:", e);
    await markNotRescored(db, keyChangedIds, `rescoring failed (${e instanceof Error ? e.message.slice(0, 80) : "error"})`);
  }
  try { await checkNumberContiguity(id, db); } catch (e) { console.error("[reparse-inplace] contiguity:", e); }
  if (skipPromote) promote = { skipped: "stored-key restore didn't finish — not auto-promoted" };
  else try { promote = await autoPromoteModule(id, db, 0.9); } catch (e) { promote = { error: String(e) }; }

  return NextResponse.json({
    ok: true,
    module: mod.module_name,
    elapsed_s: Math.round((Date.now() - t0) / 1000),
    keyEntries,
    keyReview: keyReviewIds.size,
    keysRestored,
    ...(tickReaderNotes.length ? { tickReaderNotes } : {}),
    reExtracted: parsed.length,
    updated,
    inserted,
    orphanQnums: orphans,
    solver: solverStats,
    reconciledToOfficial: reconciled,
    rescored,
    cleanup,
    explained,
    audit,
    figures,
    choicesRecovery,
    promote,
  });
}

// The review queue's cached grouping is revalidated after every call.
export const POST = withQueueInvalidation(handlePOST);
