// scripts/apply-choice-audit-fixes.ts
//
// Applies the findings of scripts/audit-choice-alignment.ts
// (.omc/qa/choice-audit.json). Owner rules: content may come ONLY from the
// source PDF; anything that can't be read goes to Needs Review with the
// reason written down; score changes are approved.
//
// DRY RUN by default — prints the before→after table and the score impact,
// writes nothing. `--apply` writes.
//
// Everything is re-checked LIVE against the DB and the PDF (the audit JSON
// only picks which modules/rows to look at):
//   1. Backup: every row that will change (questions, plus the answer_records
//      and submissions a rescore touches) → .omc/backups/ before any write.
//   2. Choices: MCQs whose stored choices disagree with the PDF text layer get
//      the PDF's choices, then the text cross-check (checkChoiceAlignment) is
//      re-run on the corrected module and must come back clean for the row.
//   3. Answer key: where the PDF ticks a different letter, official_answer and
//      correct_answer become the ticked letter. Then — exactly like the admin
//      question PATCH — the explanation is regenerated for the key
//      (explainOneAnswer) and rescoreQuestion regrades answer_records and
//      submissions. Rows whose choices changed also get a fresh explanation
//      (the old one argued about the wrong options).
//   4. Rows the audit could not verify (blank AI re-read of a scanned page,
//      odd choice count) → Needs Review with a "Needs review: …" reason.
//   5. Prints before→after, plus how many submissions' scores change and by
//      how much.
//
//   npx tsx scripts/apply-choice-audit-fixes.ts            # dry run
//   npx tsx scripts/apply-choice-audit-fixes.ts --apply    # write
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const envText = readFileSync(".env.local", "utf-8");
for (const l of envText.split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");
const AUDIT = ".omc/qa/choice-audit.json";
const FIX_DATE = "2026-10-26";

type Choice = { label: string; text: string };
interface QRow {
  id: string;
  module_id: string;
  original_question_number: number;
  question_type: string | null;
  choices: Choice[] | null;
  correct_answer: string | null;
  official_answer: string | null;
  parsing_status: string;
  parsing_notes: string | null;
  explanation: string | null;
}
interface Plan {
  module: string;
  row: QRow;
  newChoices: Choice[] | null;
  newAnswer: string | null; // ticked letter when it differs from correct_answer
  newOfficial: string | null; // ticked letter when it differs from official_answer
  needsReview: string | null;
  notes: string[];
  verified: boolean;
}

const short = (cs: Choice[] | null | undefined) =>
  (cs ?? []).map((c) => `${c.label}) ${(c.text ?? "").slice(0, 28)}`).join(" | ");

async function main() {
  const { getServiceClient } = await import("../lib/supabase");
  const { fetchPdfAsBase64 } = await import("../lib/ai/parse-pdf");
  const pt = await import("../lib/pdf-text-choices");
  const { readPrintoutLayout } = await import("../lib/printout-layout");
  const { segmentPrintout, linesToText, looksLikePrintout } = await import("../lib/printout-parser");
  const { answersMatch } = await import("../lib/grade-submission");
  const { scaleSectionScore } = await import("../lib/scoring");
  const db = getServiceClient();

  const audit = JSON.parse(readFileSync(AUDIT, "utf-8")) as {
    modules: Record<
      string,
      {
        module_id: string;
        module_name: string;
        unverified: number;
        errors: string[];
        mismatches: { question_id: string; question_number: number; source: string; note?: string; pdf?: Choice[] | null }[];
        answer_mismatches: { question_id: string }[];
      }
    >;
  };

  const plans: Plan[] = [];

  for (const m of Object.values(audit.modules)) {
    const textRows = m.mismatches.filter((x) => x.source === "pdf-text");
    const reviewRows = m.mismatches.filter((x) => x.source !== "pdf-text");
    const unverifiedNums = m.errors
      .map((e) => e.match(/^Q(\d+):/))
      .filter((x): x is RegExpMatchArray => !!x)
      .map((x) => Number(x[1]));
    if (textRows.length === 0 && m.answer_mismatches.length === 0 && reviewRows.length === 0 && unverifiedNums.length === 0) continue;

    const { data: rowsData } = await db
      .from("questions")
      .select("id, module_id, original_question_number, question_type, choices, correct_answer, official_answer, parsing_status, parsing_notes, explanation")
      .eq("module_id", m.module_id)
      .neq("parsing_status", "Rejected")
      .order("original_question_number");
    const rows = (rowsData ?? []) as QRow[];

    // ── 4. Unverifiable rows → Needs Review (no PDF content available) ──
    const reviewTargets = new Map<number, string>();
    for (const x of reviewRows) {
      const read = (x.pdf ?? []).filter((c) => c.text?.trim());
      reviewTargets.set(
        x.question_number,
        read.length === 4
          ? `an AI re-read of the source PDF (scanned page, no text layer) gave different answer choices (${pt.formatChoices(read)}) — compare all four choices with the PDF before approving`
          : "the automatic choice check could not read this question's answer choices from the source PDF (scanned page) — compare all four choices with the PDF before approving",
      );
    }
    for (const n of unverifiedNums)
      reviewTargets.set(n, "the automatic choice check got an unexpected number of answer choices when re-reading the source PDF — compare all four choices with the PDF before approving");
    for (const [n, reason] of reviewTargets) {
      const row = rows.find((r) => r.original_question_number === n);
      if (!row) continue;
      plans.push({ module: m.module_name, row, newChoices: null, newAnswer: null, newOfficial: null, needsReview: reason, notes: [`Needs review: ${reason}`], verified: true });
    }
    if (textRows.length === 0 && m.answer_mismatches.length === 0) continue;

    // ── 2/3. Live text-layer comparison for the whole module ──
    const { data: mod } = await db.from("modules").select("pdf_url").eq("id", m.module_id).single();
    const pdfBase64 = await fetchPdfAsBase64(mod!.pdf_url as string);
    const walker = await pt.extractChoicesFromPdfText(pdfBase64);
    if (!pt.isTextLayerReliable(walker, rows.length)) {
      console.warn(`${m.module_name}: text layer not reliable now — skipped`);
      continue;
    }
    // Layout-based choice text (proper spacing, ’ apostrophes) when the PDF is
    // a printout; must agree with the line walker to be used.
    const segs = segmentPrintout(await readPrintoutLayout(pdfBase64));
    const printout = looksLikePrintout(segs);
    const pdfChoicesFor = (n: number): { choices: Choice[]; fromLayout: boolean } | null => {
      const w = pt.lookupPdfTextQuestion(walker, n);
      if (!w) return null;
      const seg = printout ? segs.find((s) => s.number === n) : undefined;
      if (seg && seg.choices.length === 4 && seg.choices.every((c) => c.parts.every((p) => p.kind === "text"))) {
        const fromLayout = seg.choices.map((c) => ({
          label: c.label,
          text: linesToText(c.parts.flatMap((p) => (p.kind === "text" ? p.lines : []))),
        }));
        if (fromLayout.every((c, i) => pt.choiceTextsAgree(c.text, w.choices[i].text))) return { choices: fromLayout, fromLayout: true };
      }
      return {
        choices: w.choices.map((c) => ({ label: c.label, text: c.text.replace(/\s*\u02bc\s*/g, "\u2019").replace(/\s+/g, " ").trim() })),
        fromLayout: false,
      };
    };
    // Plain PDF text can't carry math ($…$, superscripts flattened to "x2")
    // and only the layout reader sees underlines. Any sign of either → don't
    // write the choices; send the row to a human instead.
    const formattingRisk = (stored: Choice[] | null, next: { choices: Choice[]; fromLayout: boolean }): string | null => {
      const all = [...(stored ?? []), ...next.choices].map((c) => c.text ?? "");
      if (all.some((t) => /\$|\^|\\[a-z]+|[A-Za-z]\d/.test(t))) return "math formatting";
      if (!next.fromLayout && all.some((t) => /<u>/.test(t))) return "underlined text";
      return null;
    };

    const marked = [...walker.byNumber.values()].filter((t) => t.checked).length;
    const ticksAreKey = marked >= Math.ceil(walker.byNumber.size * 0.5);
    const corrected = rows.map((r) => ({ ...r }));
    for (const r of corrected) {
      if (r.question_type !== "Multiple Choice") continue;
      const w = pt.lookupPdfTextQuestion(walker, r.original_question_number);
      if (!w) continue;
      const notes: string[] = [];
      let newChoices: Choice[] | null = null;
      let reviewInstead: string | null = null;
      if (pt.diffChoices(r.choices, w.choices).diffs.length > 0) {
        const pdf = pdfChoicesFor(r.original_question_number);
        const risk = pdf ? formattingRisk(r.choices, pdf) : null;
        if (pdf && risk) {
          reviewInstead = `the answer choices don't match the source PDF (they belong to a neighbouring question) and contain ${risk} that the PDF text layer can't reproduce — correct them by hand from the PDF. PDF shows ${pt.formatChoices(pdf.choices)}`;
        } else if (pdf) {
          newChoices = pdf.choices;
          notes.push(`Fixed ${FIX_DATE}: choices corrected from source PDF text layer (were misaligned)`);
        }
      }
      const tick = ticksAreKey ? w.checked : null;
      const newAnswer = tick && (r.correct_answer ?? "").trim().toUpperCase() !== tick ? tick : null;
      const newOfficial = tick && (r.official_answer ?? "").trim().toUpperCase() !== tick ? tick : null;
      if (newAnswer || newOfficial) {
        notes.push(
          `Fixed ${FIX_DATE}: answer key set to ${tick}, the choice ticked in the source PDF (was correct_answer ${r.correct_answer ?? "—"}, official ${r.official_answer ?? "—"})`,
        );
      }
      if (reviewInstead) {
        // Key changes for this row wait for the human fix of its choices.
        plans.push({ module: m.module_name, row: rows.find((x) => x.id === r.id)!, newChoices: null, newAnswer: null, newOfficial: null, needsReview: reviewInstead, notes: [`Needs review: ${reviewInstead}`], verified: true });
        continue;
      }
      if (!newChoices && !newAnswer && !newOfficial) continue;
      if (newChoices) r.choices = newChoices;
      plans.push({ module: m.module_name, row: rows.find((x) => x.id === r.id)!, newChoices, newAnswer, newOfficial, needsReview: null, notes, verified: false });
    }
    // Re-run the cross-check on the corrected module: fixed rows must be clean.
    const issues = pt.checkChoiceAlignment(corrected, walker);
    for (const p of plans) {
      if (p.row.module_id !== m.module_id || p.needsReview) continue;
      p.verified = !issues.has(p.row.original_question_number);
    }
  }

  // ── 5. Score impact (simulated rescoreQuestion for every key change) ──
  const keyChanges = new Map<string, string>(); // question_id → new key
  for (const p of plans) if (p.newAnswer) keyChanges.set(p.row.id, p.newAnswer);
  const records: { id: string; submission_id: string; question_id: string; student_answer: string | null; correct_answer: string | null; is_correct: boolean }[] = [];
  if (keyChanges.size > 0) {
    const { data } = await db
      .from("answer_records")
      .select("id, submission_id, question_id, student_answer, correct_answer, is_correct")
      .in("question_id", [...keyChanges.keys()]);
    records.push(...((data ?? []) as typeof records));
  }
  const subIds = [...new Set(records.map((r) => r.submission_id))];
  const subImpact: { id: string; before: string; after: string; delta: number; scaledDelta: number }[] = [];
  const subRecordsAll: Record<string, unknown>[] = [];
  const subsAll: Record<string, unknown>[] = [];
  for (const sid of subIds) {
    const { data: recs } = await db.from("answer_records").select("id, question_id, student_answer, is_correct").eq("submission_id", sid);
    const { data: sub } = await db.from("submissions").select("*").eq("id", sid).single();
    subRecordsAll.push(...(recs ?? []));
    if (sub) subsAll.push(sub);
    const total = recs?.length ?? 0;
    if (!total) continue;
    const newCorrect = (recs ?? []).filter((r) =>
      keyChanges.has(r.question_id as string) ? answersMatch(r.student_answer as string | null, keyChanges.get(r.question_id as string)!) : r.is_correct,
    ).length;
    const pct = Math.round((newCorrect / total) * 1000) / 10;
    const scaled = scaleSectionScore(pct);
    const beforeCorrect = (sub?.correct_count as number | null) ?? (recs ?? []).filter((r) => r.is_correct).length;
    const beforeScaled = (sub?.scaled_score as number | null) ?? null;
    subImpact.push({
      id: sid,
      before: `${beforeCorrect}/${total} (scaled ${beforeScaled ?? "—"})`,
      after: `${newCorrect}/${total} (scaled ${scaled})`,
      delta: newCorrect - beforeCorrect,
      scaledDelta: beforeScaled == null ? 0 : scaled - beforeScaled,
    });
  }

  // ── Print ──
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${plans.length} question(s)\n`);
  console.log("| Module | Q | Status | Change | Choices before → after | Answer (correct/official) before → after | Cross-check |");
  console.log("|---|---|---|---|---|---|---|");
  for (const p of plans) {
    const r = p.row;
    const kind = p.needsReview ? "→ Needs Review" : [p.newChoices ? "choices" : "", p.newAnswer || p.newOfficial ? "answer key" : ""].filter(Boolean).join(" + ");
    const ans = p.newAnswer || p.newOfficial
      ? `${r.correct_answer ?? "—"}/${r.official_answer ?? "—"} → ${p.newAnswer ?? r.correct_answer}/${p.newOfficial ?? r.official_answer}`
      : `${r.correct_answer ?? "—"}/${r.official_answer ?? "—"} (unchanged)`;
    const ch = p.newChoices ? `${short(r.choices)} → ${short(p.newChoices)}` : "(unchanged)";
    console.log(`| ${p.module} | ${r.original_question_number} | ${r.parsing_status} | ${kind} | ${ch} | ${ans} | ${p.needsReview ? "n/a" : p.verified ? "clean" : "STILL FLAGGED"} |`);
    if (p.needsReview) console.log(`|  |  |  | note: Needs review: ${p.needsReview} |  |  |  |`);
  }
  const changed = subImpact.filter((s) => s.delta !== 0 || s.scaledDelta !== 0);
  console.log(`\nKey changes: ${keyChanges.size} question(s); answer_records touched: ${records.length}; submissions affected: ${subIds.length}; submissions whose score changes: ${changed.length}`);
  if (changed.length) {
    console.log("\n| Submission | Before | After | Δ correct | Δ scaled |\n|---|---|---|---|---|");
    for (const s of changed) console.log(`| ${s.id} | ${s.before} | ${s.after} | ${s.delta > 0 ? "+" : ""}${s.delta} | ${s.scaledDelta > 0 ? "+" : ""}${s.scaledDelta} |`);
  }
  const unverifiedFix = plans.filter((p) => !p.needsReview && !p.verified);
  if (unverifiedFix.length) console.log(`\nWARNING: ${unverifiedFix.length} fix(es) still flagged by the cross-check — they will be skipped on --apply.`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write.");
    return;
  }

  // ── 1. Backup ──
  mkdirSync(".omc/backups", { recursive: true });
  const ids = plans.map((p) => p.row.id);
  const { data: fullRows } = await db.from("questions").select("*").in("id", ids);
  const backup = `.omc/backups/choice-audit-fixes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(backup, JSON.stringify({ questions: fullRows, answer_records: subRecordsAll, submissions: subsAll }, null, 2));
  console.log(`\nBackup written: ${backup}`);

  const { explainOneAnswer } = await import("../lib/ai/solve-question");
  const { rescoreQuestion } = await import("../lib/rescore");
  const now = () => new Date().toISOString();
  for (const p of plans) {
    const r = p.row;
    const base = (r.parsing_notes ?? "").trim();
    const notes = [base, ...p.notes.filter((n) => !base.toLowerCase().includes(n.toLowerCase()))].filter(Boolean).join("; ");
    if (p.needsReview) {
      await db.from("questions").update({ parsing_status: "Needs Review", parsing_notes: notes, updated_at: now() }).eq("id", r.id);
      console.log(`Q${r.original_question_number} ${p.module}: → Needs Review`);
      continue;
    }
    if (!p.verified) {
      console.log(`Q${r.original_question_number} ${p.module}: SKIPPED (cross-check still flags it)`);
      continue;
    }
    const update: Record<string, unknown> = { parsing_notes: notes, updated_at: now() };
    if (p.newChoices) update.choices = p.newChoices;
    if (p.newOfficial) update.official_answer = p.newOfficial;
    if (p.newAnswer) {
      update.correct_answer = p.newAnswer;
      update.mismatch_with_official = false;
    }
    const { error } = await db.from("questions").update(update).eq("id", r.id);
    if (error) {
      console.error(`Q${r.original_question_number} ${p.module}: update failed — ${error.message}`);
      continue;
    }
    // Same downstream steps as the admin question PATCH.
    const finalKey = p.newAnswer ?? r.correct_answer;
    if (finalKey && (p.newAnswer || p.newChoices)) {
      const expl = await explainOneAnswer(r.id, finalKey, db);
      if (!expl) console.warn(`Q${r.original_question_number} ${p.module}: explanation regen failed — old explanation kept`);
    }
    let rescore = "";
    if (p.newAnswer) {
      const res = await rescoreQuestion(db, r.id);
      rescore = ` rescore: ${res.recordsUpdated} records, ${res.submissionsRescored} submissions`;
    }
    console.log(`Q${r.original_question_number} ${p.module}: fixed${rescore}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
