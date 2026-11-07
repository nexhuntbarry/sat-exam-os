// scripts/reextract-quote-cutoffs.ts
//
// One pass over the 13 Test #14 English questions whose stem / choices were
// cut at a quotation mark (.omc/reports/module-key-investigation-2026-11-07.md
// §3). Each is re-read from its PDF with the fixed (tagged-text) extractor via
// lib/repair-ops readQuestionFromPdf. Stem and choices are overwritten ONLY
// when the re-read is complete. Keys are never touched (they are ✓-marked
// official keys). Live-test questions keep their status and get a
// "[live-fix]" note. Rows are backed up to .omc/backups first.
//
//   node --env-file=.env.local --import tsx scripts/reextract-quote-cutoffs.ts           # dry run
//   node --env-file=.env.local --import tsx scripts/reextract-quote-cutoffs.ts --apply
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { fetchPdfBase64, readQuestionFromPdf, rereadIsComplete, type ReextractProposal } from "../lib/repair-ops";
import { liveQuestionIds, LIVE_FIX_TAG } from "../lib/live-questions";
import { splitNotes } from "../lib/explanation-autofix";
import { CHOICE_CUT_OFF_NOTE, STEM_CUT_OFF_NOTE, choiceLooksBroken } from "../lib/parse-guards";
import { normalizeChoiceText } from "../lib/pdf-text-choices";
import { answersAgreeForQuestion } from "../lib/answer-key";

const APPLY = process.argv.includes("--apply");
const TARGETS: Record<string, number[]> = {
  "487dadd7-9550-4445-91fe-6e11905d4dc1": [5, 6, 7, 8, 10, 11], // [Test #14] SAT English Module 1
  "d97da084-42a1-4454-b5a7-bdadb204267e": [1, 2, 3, 5, 9, 12, 17], // [Test #14] SAT English Module 2
};
const TODAY = "2026-11-07";
const FIX_NOTE = `Needs review: stem and choices re-extracted from the PDF (quote cut-off fix, ${TODAY}) — check the explanation against the full question, then approve.`;
// Notes about the old cut stem / empty choices: stale once the text is whole.
const STALE = /stem (?:is |appears )?(?:severely )?(?:truncated|incomplete|cut off)|question text looks cut off|choices? (?:have|has|are) empty|answer choices have empty text|choices are missing|options are missing|stem is scrambled|^Semantic audit:.*(?:truncat|incomplete|empty text|missing)/i;

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = {
  id: string;
  module_id: string;
  original_question_number: number;
  question_type: string;
  question_text: string | null;
  choices: { label: string; text: string; image_url?: string | null }[] | null;
  correct_answer: string | null;
  official_answer: string | null;
  parsing_status: string;
  parsing_notes: string | null;
  page_number: number | null;
  source_pdf_url: string | null;
};

async function main() {
  const rows: Row[] = [];
  for (const [moduleId, nums] of Object.entries(TARGETS)) {
    const { data, error } = await db.from("questions").select("*").eq("module_id", moduleId).in("original_question_number", nums).order("original_question_number");
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
  }
  console.log(`${rows.length} questions (${APPLY ? "APPLY" : "dry run"})`);

  const backupDir = path.join(process.cwd(), ".omc", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `reextract-quote-cutoffs-${TODAY}-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(rows, null, 2));
  console.log(`backup: ${backup}`);

  const live = await liveQuestionIds(db, rows.map((r) => r.id));
  const pdfs = new Map<string, string>();
  const results: { n: string; status: string; detail: string; proposal?: ReextractProposal }[] = [];

  for (const r of rows) {
    const label = `M${r.module_id.startsWith("487d") ? 1 : 2} Q${r.original_question_number}`;
    try {
      const url = r.source_pdf_url!;
      if (!pdfs.has(url)) pdfs.set(url, await fetchPdfBase64(url));
      const res = await readQuestionFromPdf(pdfs.get(url)!, {
        number: r.original_question_number,
        page: r.page_number ?? 1,
        storedText: r.question_text,
        storedChoices: r.choices,
        storedType: r.question_type,
      });
      if (!res.ok) {
        results.push({ n: label, status: "FAILED", detail: res.message });
        continue;
      }
      const p = res.proposal;
      if (p.question_type !== r.question_type) {
        results.push({ n: label, status: "FAILED", detail: `PDF reads as ${p.question_type}`, proposal: p });
        continue;
      }
      // Per field: the stem is taken when the re-read stem is whole; the
      // choices only when all four are whole.
      const stemOk = rereadIsComplete({ question_type: "Student Produced Response", question_text: p.question_text, choices: [], warnings: [] });
      const choicesOk = p.choices.length === 4 && p.choices.every((c) => !!c.image_url || !choiceLooksBroken(c)) && !p.warnings.some((w) => /^choice /.test(w));
      if (!stemOk && !choicesOk) {
        results.push({ n: label, status: "INCOMPLETE", detail: `${p.warnings.join(", ") || "stem and choices still incomplete"}`, proposal: p });
        continue;
      }
      // Keep the stored formatting where the text is the same ($\text{CO}_2$ vs CO2).
      let stem = p.question_text;
      if (/\$\\text\{CO\}_2\$/.test(r.question_text ?? "")) stem = stem.replace(/\bCO2\b/g, "$\\text{CO}_2$");
      const choices = p.choices.map((c) => {
        const old = (r.choices ?? []).find((o) => o.label === c.label);
        return old?.text?.trim() && normalizeChoiceText(old.text) === normalizeChoiceText(c.text) ? old : c;
      });
      // What still differs from the stored copy (choices that were already whole, the ✓ vs the key).
      const diffs: string[] = [];
      if (!stemOk) diffs.push("stem NOT replaced (re-read still incomplete)");
      if (!choicesOk) diffs.push(`choices NOT replaced (re-read: ${p.warnings.join(", ") || "incomplete"}) — stored choices kept`);
      if (choicesOk) {
        for (const c of choices) {
          const old = (r.choices ?? []).find((o) => o.label === c.label);
          if (old?.text?.trim() && normalizeChoiceText(old.text) !== normalizeChoiceText(c.text)) diffs.push(`choice ${c.label}: "${old.text.slice(0, 60)}" → "${c.text.slice(0, 60)}"`);
        }
      }
      if (p.marked_answer && r.correct_answer && !answersAgreeForQuestion(p.marked_answer, r.correct_answer, p.question_text)) {
        diffs.push(`PDF ✓ ${p.marked_answer} ≠ key ${r.correct_answer} (key NOT changed)`);
      }

      const kept = splitNotes(r.parsing_notes).filter((s) => s !== STEM_CUT_OFF_NOTE && s !== CHOICE_CUT_OFF_NOTE && !STALE.test(s) && !s.startsWith("Needs review: stem and choices re-extracted"));
      const keyNote =
        p.marked_answer && r.correct_answer && !answersAgreeForQuestion(p.marked_answer, r.correct_answer, p.question_text)
          ? [`Needs review: the PDF re-read takes ${p.marked_answer} as the marked answer but the key is ${r.correct_answer} (the key's box has no ✓ in the text layer) — check the key; it was not changed.`]
          : [];
      let notes = [...kept, ...keyNote, FIX_NOTE].join("; ");
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (stemOk) update.question_text = stem;
      if (choicesOk) update.choices = choices.map((c) => (c.image_url ? c : { label: c.label, text: c.text }));
      if (live.has(r.id)) {
        notes = `${LIVE_FIX_TAG} Stem/choices re-extracted from the PDF while this question is in a live test; kept ${r.parsing_status} — please re-check. ${notes}`;
      }
      update.parsing_notes = notes;
      // Status and keys stay as they are.
      if (APPLY) {
        const { error } = await db.from("questions").update(update).eq("id", r.id);
        if (error) throw error;
      }
      results.push({ n: label, status: diffs.length ? "UPDATED (differs)" : "UPDATED", detail: diffs.join(" | "), proposal: p });
    } catch (e) {
      results.push({ n: label, status: "FAILED", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log("\n=== Results ===");
  for (const x of results) console.log(`${x.n.padEnd(7)} ${x.status}${x.detail ? ` — ${x.detail}` : ""}`);
  console.log("\n=== Still differ or failed ===");
  const bad = results.filter((x) => x.status !== "UPDATED");
  if (bad.length === 0) console.log("(none)");
  for (const x of bad) console.log(`${x.n}: ${x.status} — ${x.detail}`);
  if (process.env.SHOW) for (const x of results) console.log(`\n--- ${x.n}\n${x.proposal?.question_text}\n${JSON.stringify(x.proposal?.choices)}`);
  console.log(`\nlive questions: ${live.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
