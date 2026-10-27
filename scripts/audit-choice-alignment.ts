// scripts/audit-choice-alignment.ts
//
// "Do the stored A/B/C/D choices actually belong to each question's stem?"
//
// READ-ONLY. For every multiple-choice question in the selected modules,
// compares the stored choices against the source PDF and reports mismatches
// (stored vs PDF). Never writes question data.
//
// Per module:
//   1. PDF text layer (free, deterministic): walks the PDF in reading order
//      and binds each "N." stem to the A–D choices that follow it — immune to
//      the page-break mis-binding that produced the bug. Also reads the
//      check-circle glyph printouts use to mark the correct answer.
//   2. AI re-extraction fallback (repairChoicesForQuestion in dryRun mode,
//      stem page ± 1 only): for questions the text layer can't vouch for
//      (scanned PDFs, math choices whose text-layer form doesn't match the
//      stored LaTeX). Capped by --max-ai; runs sequentially.
//   3. Neighbour check: identical choice sets on consecutive questions.
//
//   npx tsx scripts/audit-choice-alignment.ts --name "Test #19"
//   npx tsx scripts/audit-choice-alignment.ts --module <id> [--module <id>]
//   npx tsx scripts/audit-choice-alignment.ts --section "Reading & Writing"
//   npx tsx scripts/audit-choice-alignment.ts --section Math --max-ai 300
//   flags: --no-ai (text layer + neighbour only), --out <path>
//
// Results are MERGED into .omc/qa/choice-audit.json keyed by module id, so
// successive runs (Test #19 → all R&W → Math) accumulate in one file.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const envText = readFileSync(".env.local", "utf-8");
for (const l of envText.split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const argv = process.argv.slice(2);
const argAll = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const arg = (flag: string) => argAll(flag)[0];
const MODULE_IDS = argAll("--module");
const NAME = arg("--name");
const SECTION = arg("--section");
const NO_AI = argv.includes("--no-ai");
let aiBudget = NO_AI ? 0 : Number(arg("--max-ai") ?? 200);
const OUT = arg("--out") ?? ".omc/qa/choice-audit.json";

type Choice = { label: string; text: string };

interface Mismatch {
  question_id: string;
  question_number: number;
  parsing_status: string;
  source: "pdf-text" | "ai-reextract" | "neighbour-duplicate";
  stored: Choice[];
  pdf: Choice[] | null;
  differing_labels: string[];
  note?: string;
}

interface AnswerMismatch {
  question_id: string;
  question_number: number;
  parsing_status: string;
  pdf_checkmark: string;
  correct_answer: string | null;
  official_answer: string | null;
}

interface ModuleReport {
  module_id: string;
  module_name: string;
  section: string;
  audited_at: string;
  mc_questions: number;
  text_layer: "reliable" | "partial" | "none";
  verified_by_text: number;
  verified_by_ai: number;
  unverified: number;
  ai_calls: number;
  mismatches: Mismatch[];
  answer_mismatches: AnswerMismatch[];
  errors: string[];
}

async function main() {
  const { getServiceClient } = await import("../lib/supabase");
  const { fetchPdfAsBase64 } = await import("../lib/ai/parse-pdf");
  const { repairChoicesForQuestion } = await import("../lib/repair-ops");
  const pt = await import("../lib/pdf-text-choices");
  const db = getServiceClient();

  let q = db.from("modules").select("id, module_name, section, pdf_url").order("module_name");
  if (MODULE_IDS.length) q = q.in("id", MODULE_IDS);
  if (NAME) q = q.ilike("module_name", `%${NAME}%`);
  if (SECTION) q = q.eq("section", SECTION);
  const { data: mods, error } = await q;
  if (error) throw new Error(error.message);
  console.log(`Auditing ${mods?.length ?? 0} module(s); AI budget ${aiBudget}`);

  const existing: Record<string, ModuleReport> = existsSync(OUT)
    ? (JSON.parse(readFileSync(OUT, "utf-8")).modules ?? {})
    : {};

  for (const mod of mods ?? []) {
    const rep: ModuleReport = {
      module_id: mod.id,
      module_name: mod.module_name,
      section: mod.section,
      audited_at: new Date().toISOString(),
      mc_questions: 0,
      text_layer: "none",
      verified_by_text: 0,
      verified_by_ai: 0,
      unverified: 0,
      ai_calls: 0,
      mismatches: [],
      answer_mismatches: [],
      errors: [],
    };
    const { data: rows } = await db
      .from("questions")
      .select("id, original_question_number, question_type, choices, correct_answer, official_answer, parsing_status, source_pdf_url")
      .eq("module_id", mod.id)
      .neq("parsing_status", "Rejected")
      .order("original_question_number");
    const qs = rows ?? [];
    const mc = qs.filter((r) => r.question_type === "Multiple Choice");
    rep.mc_questions = mc.length;
    const pdfUrl = (mod.pdf_url as string | null) ?? (qs[0]?.source_pdf_url as string | null);
    if (!pdfUrl || mc.length === 0) {
      if (!pdfUrl) rep.errors.push("no PDF url");
      existing[mod.id] = rep;
      continue;
    }

    let pdfBase64: string;
    try {
      pdfBase64 = await fetchPdfAsBase64(pdfUrl);
    } catch (e) {
      rep.errors.push(`PDF fetch: ${e instanceof Error ? e.message : e}`);
      existing[mod.id] = rep;
      continue;
    }
    let pdfText: Awaited<ReturnType<typeof pt.extractChoicesFromPdfText>> | null = null;
    try {
      pdfText = await pt.extractChoicesFromPdfText(pdfBase64);
    } catch (e) {
      rep.errors.push(`text layer: ${e instanceof Error ? e.message : e}`);
    }
    const reliable = !!pdfText && pt.isTextLayerReliable(pdfText, qs.length);
    rep.text_layer = reliable ? "reliable" : pdfText?.hasTextLayer ? "partial" : "none";

    // Checkmark answers (printouts) vs stored answers — only when most are marked.
    if (reliable && pdfText) {
      const marked = [...pdfText.byNumber.values()].filter((t) => t.checked).length;
      if (marked >= Math.ceil(pdfText.byNumber.size * 0.5)) {
        for (const r of mc) {
          const tq = pt.lookupPdfTextQuestion(pdfText, r.original_question_number);
          if (!tq?.checked) continue;
          const ca = (r.correct_answer ?? "").trim().toUpperCase();
          const oa = (r.official_answer ?? "").trim().toUpperCase();
          if (ca !== tq.checked || (oa && oa !== tq.checked)) {
            rep.answer_mismatches.push({
              question_id: r.id,
              question_number: r.original_question_number,
              parsing_status: r.parsing_status,
              pdf_checkmark: tq.checked,
              correct_answer: r.correct_answer,
              official_answer: r.official_answer,
            });
          }
        }
      }
    }

    const flagged = new Set<number>();
    for (const r of mc) {
      const stored = (Array.isArray(r.choices) ? r.choices : []) as Choice[];
      const tq = reliable && pdfText ? pt.lookupPdfTextQuestion(pdfText, r.original_question_number) : null;
      if (tq) {
        const { comparable, diffs } = pt.diffChoices(stored, tq.choices);
        if (diffs.length > 0) {
          flagged.add(r.original_question_number);
          rep.mismatches.push({
            question_id: r.id,
            question_number: r.original_question_number,
            parsing_status: r.parsing_status,
            source: "pdf-text",
            stored,
            pdf: tq.choices,
            differing_labels: diffs.map((d) => d.label),
          });
          continue;
        }
        // Word choices all agree, or (math) the normalized text matches exactly.
        const strictAgree = tq.choices.every((p) => {
          const s = stored.find((c) => (c?.label ?? "").toUpperCase() === p.label);
          return s && pt.normalizeChoiceText(s.text) === pt.normalizeChoiceText(p.text);
        });
        if (comparable === 4 || strictAgree) {
          rep.verified_by_text++;
          continue;
        }
      }

      // Text layer can't vouch → AI dry-run re-extraction (budgeted).
      if (aiBudget <= 0) {
        rep.unverified++;
        continue;
      }
      aiBudget--;
      rep.ai_calls++;
      try {
        const res = await repairChoicesForQuestion(r.id, { dryRun: true, pdfBase64, pdfText });
        const ai = (res.choices ?? []) as Choice[];
        // Blank/garbled re-extraction (scanned page) is "couldn't verify", not a mismatch.
        if (ai.length !== 4 || ai.some((c) => !c.text?.trim())) {
          rep.unverified++;
          rep.errors.push(`Q${r.original_question_number}: ${res.message}`);
          continue;
        }
        const differing = ai
          .filter((a) => {
            const s = stored.find((c) => (c?.label ?? "").toUpperCase() === a.label);
            return !s || !pt.choiceTextsAgree(s.text, a.text);
          })
          .map((a) => a.label);
        if (differing.length > 0) {
          flagged.add(r.original_question_number);
          rep.mismatches.push({
            question_id: r.id,
            question_number: r.original_question_number,
            parsing_status: r.parsing_status,
            source: "ai-reextract",
            stored,
            pdf: ai,
            differing_labels: differing,
            note: res.ok ? undefined : res.message,
          });
        } else {
          rep.verified_by_ai++;
        }
      } catch (e) {
        rep.unverified++;
        rep.errors.push(`Q${r.original_question_number}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Neighbour duplicates the PDF checks didn't already catch.
    const dup = pt.checkChoiceAlignment(mc, null);
    for (const [n, issue] of dup) {
      if (flagged.has(n)) continue;
      const r = mc.find((x) => x.original_question_number === n)!;
      rep.mismatches.push({
        question_id: r.id,
        question_number: n,
        parsing_status: r.parsing_status,
        source: "neighbour-duplicate",
        stored: (r.choices ?? []) as Choice[],
        pdf: null,
        differing_labels: [],
        note: issue.note,
      });
    }
    rep.mismatches.sort((a, b) => a.question_number - b.question_number);

    existing[mod.id] = rep;
    console.log(
      `${mod.module_name}: MC=${rep.mc_questions} text=${rep.text_layer} verifiedText=${rep.verified_by_text} verifiedAI=${rep.verified_by_ai} unverified=${rep.unverified} mismatches=${rep.mismatches.length} [${rep.mismatches.map((m) => `Q${m.question_number}`).join(",")}] answerMismatches=${rep.answer_mismatches.length}`,
    );
    // Persist after every module so an interrupted run keeps its progress.
    writeReport(existing);
  }
  writeReport(existing);
  console.log(`Wrote ${OUT}`);
}

function writeReport(modules: Record<string, ModuleReport>) {
  const all = Object.values(modules);
  const summary = {
    modules: all.length,
    mc_questions: all.reduce((s, m) => s + m.mc_questions, 0),
    mismatched_questions: all.reduce((s, m) => s + m.mismatches.length, 0),
    answer_mismatches: all.reduce((s, m) => s + m.answer_mismatches.length, 0),
    unverified: all.reduce((s, m) => s + m.unverified, 0),
    modules_with_mismatches: all.filter((m) => m.mismatches.length > 0).map((m) => `${m.module_name} (${m.mismatches.length})`),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), summary, modules }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
