import type { getServiceClient } from "@/lib/supabase";
import { checkChoiceAlignment, type PdfTextChoices } from "@/lib/pdf-text-choices";

type DbClient = ReturnType<typeof getServiceClient>;

// ── Parser-placeholder detector ──────────────────────────────────────
// The AI parser sometimes writes placeholder text instead of real content
// ("(not visible — page cut off)", "[Bar chart: …]"). Such a question must
// never be Approved — every approve path (manual, bulk, auto-promote, repair)
// checks this first. Returns the offending snippet, or null when clean.
const PARSE_PLACEHOLDER = /not (fully )?visible|partially visible|page (is )?cut off|\[(bar chart|graph|table|figure|image)[:\]]/i;

export function findParsePlaceholder(questionText: string | null | undefined, choices: unknown): string | null {
  const texts = [questionText ?? ""];
  if (Array.isArray(choices)) {
    for (const c of choices) texts.push((typeof c === "string" ? c : (c as { text?: string } | null)?.text) || "");
  }
  for (const t of texts) {
    const m = PARSE_PLACEHOLDER.exec(t);
    if (m) return m[0];
  }
  return null;
}

export function placeholderNote(snippet: string): string {
  return `Needs review: contains parser placeholder text (${snippet})`;
}

// ── Per-question completeness gate ───────────────────────────────────
// A question is only fit to be Approved/live if it's actually complete:
// a real stem, four non-empty choices for MCQ, and a stored answer. Anything
// missing gets demoted to Needs Review so an incomplete question never reaches
// students. Runs before auto-promote.
export async function enforceCompleteness(
  moduleId: string,
  db: DbClient,
): Promise<{ checked: number; demoted: number; reasons: Record<string, number> }> {
  const { data } = await db
    .from("questions")
    .select("id, original_question_number, question_text, choices, correct_answer, question_type, parsing_status, parsing_notes")
    .eq("module_id", moduleId);
  const rows = (data ?? []) as {
    id: string;
    original_question_number: number;
    question_text: string | null;
    choices: unknown;
    correct_answer: string | null;
    question_type: string | null;
    parsing_status: string;
    parsing_notes: string | null;
  }[];

  const reasons: Record<string, number> = {};
  let demoted = 0;
  for (const q of rows) {
    if (q.parsing_status === "Needs Review" || q.parsing_status === "Rejected") continue; // already flagged
    const problems: string[] = [];
    if (!q.question_text || q.question_text.trim().length < 15) problems.push("empty/short stem");
    if (q.question_type === "Multiple Choice") {
      const ch = Array.isArray(q.choices) ? q.choices : [];
      const good = ch.filter((c) => {
        const t = (typeof c === "string" ? c : (c as { text?: string })?.text) || "";
        return t.trim().length > 0 && !/partially visible|no text|placeholder|not visible/i.test(t);
      });
      if (good.length < 4) problems.push(`${good.length}/4 choices`);
    }
    if (!q.correct_answer || !q.correct_answer.trim()) problems.push("no answer");
    const placeholder = findParsePlaceholder(q.question_text, q.choices);
    if (placeholder) problems.push(`parser placeholder text (${placeholder})`);
    if (problems.length === 0) continue;

    demoted++;
    for (const p of problems) reasons[p] = (reasons[p] ?? 0) + 1;
    const base = (q.parsing_notes || "").trim();
    // Plain-language reason for the review page's reviewer-flag banner.
    const note = `Needs review: incomplete question (completeness gate) — ${problems.join(", ")}`;
    await db
      .from("questions")
      .update({
        parsing_status: "Needs Review",
        parsing_notes: base && !base.toLowerCase().includes("completeness gate") ? `${base}; ${note}` : note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", q.id);
  }
  console.log(`[completeness-gate] module=${moduleId} checked=${rows.length} demoted=${demoted} reasons=${JSON.stringify(reasons)}`);
  return { checked: rows.length, demoted, reasons };
}

// ── Question-number contiguity check ─────────────────────────────────
// SAT modules number their questions 1..N with no gaps. A gap means the parser
// dropped a question. This reports the gap so the module can be flagged /
// re-parsed (it can't invent the missing question, so it doesn't auto-fix).
export async function checkNumberContiguity(
  moduleId: string,
  db: DbClient,
): Promise<{ count: number; expectedMax: number; missing: number[] }> {
  const { data } = await db
    .from("questions")
    .select("original_question_number")
    .eq("module_id", moduleId)
    .order("original_question_number");
  const nums = (data ?? []).map((r) => r.original_question_number).filter((n) => typeof n === "number");
  if (nums.length === 0) return { count: 0, expectedMax: 0, missing: [] };
  const max = Math.max(...nums);
  const present = new Set(nums);
  const missing: number[] = [];
  for (let i = 1; i <= max; i++) if (!present.has(i)) missing.push(i);
  if (missing.length > 0) {
    console.warn(`[contiguity] module=${moduleId} has gaps — missing question numbers: ${missing.join(", ")}`);
  }
  return { count: nums.length, expectedMax: max, missing };
}

// ── Choice-alignment gate ────────────────────────────────────────────
// Last line of defence against choices bound to the wrong stem (stem at the
// bottom of page N, choices on page N+1 picked up by the stem BELOW them).
// Compares every non-flagged MCQ against the PDF text layer (when reliable)
// or its neighbour's choice set, and demotes mismatches to Needs Review so
// they can never be auto-promoted. Runs before auto-promote.
export async function enforceChoiceAlignment(
  moduleId: string,
  db: DbClient,
  pdfText: PdfTextChoices | null,
): Promise<{ checked: number; demoted: number }> {
  const { data } = await db
    .from("questions")
    .select("id, original_question_number, question_type, choices, parsing_status, parsing_notes")
    .eq("module_id", moduleId);
  const rows = (data ?? []) as {
    id: string;
    original_question_number: number;
    question_type: string | null;
    choices: unknown;
    parsing_status: string;
    parsing_notes: string | null;
  }[];
  const live = rows.filter((r) => r.parsing_status !== "Rejected");
  const issues = checkChoiceAlignment(live, pdfText);
  let demoted = 0;
  for (const q of live) {
    const issue = issues.get(q.original_question_number);
    if (!issue) continue;
    const base = (q.parsing_notes || "").trim();
    if (q.parsing_status === "Needs Review" && base.toLowerCase().includes("choice misalignment")) continue;
    demoted++;
    await db
      .from("questions")
      .update({
        parsing_status: "Needs Review",
        parsing_notes: base && !base.toLowerCase().includes("choice misalignment") ? `${base}; ${issue.note}` : issue.note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", q.id);
  }
  console.log(`[choice-alignment-gate] module=${moduleId} checked=${live.length} demoted=${demoted}`);
  return { checked: live.length, demoted };
}

// ── Answer-key guards ────────────────────────────────────────────────
// A PDF can carry the answer-key page of a DIFFERENT module (Oct 2024 English:
// each module's PDF ended with the other module's key). Trusting it stores a
// key at chance level. Two checks: the key page's own title vs the question
// pages' "Section N, Module M" header, and a statistical solver-vs-key check.

/** Module number (1 or 2) named in a label like "Section 1, Module 2", "MODULE 2 AK", "Reading 2", "Math 1". */
export function moduleNumberFromLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const m =
    /\bmodule\s*[-#:]?\s*([12])\b/i.exec(label) ??
    /\b(?:reading|writing|english|eng|math|r\s*&\s*w|rw)\s*[-#]?\s*([12])\b/i.exec(label) ??
    /\bM\s?([12])\b/.exec(label);
  return m ? Number(m[1]) : null;
}

/**
 * Note when the key page's module number disagrees with the questions' module
 * (from the question-page header, else the module's own name/number). Null
 * when they agree or either side is unknown.
 */
export function keyModuleMismatchNote(
  keyTitle: string | null | undefined,
  questionHeader: string | null | undefined,
  moduleName: string | null | undefined,
  moduleNumber: number | null | undefined,
): string | null {
  const keyMod = moduleNumberFromLabel(keyTitle);
  if (keyMod == null) return null;
  const qMod =
    moduleNumberFromLabel(questionHeader) ??
    moduleNumberFromLabel(moduleName) ??
    (moduleNumber === 1 || moduleNumber === 2 ? moduleNumber : null);
  if (qMod == null || qMod === keyMod) return null;
  return `Needs review: the answer-key page in this PDF says Module ${keyMod} but the questions are Module ${qMod} — the key may belong to a different module. Check the PDF.`;
}

/** Note when the key disagrees with the solver on more than 30% of compared MC questions. */
export function keyDisagreementNote(disagree: number, total: number): string | null {
  if (total < 5 || disagree / total <= 0.3) return null;
  return `Needs review: the PDF's answer key disagrees with the solved answer on ${disagree} of ${total} questions in this module — the key page may be for a different module.`;
}

/**
 * Demote questions to Needs Review with `note` appended (once). `numbers` limits
 * it to those question numbers; omitted → every question in the module.
 * Rejected rows are left alone. Run after the passes that can Approve a row.
 */
export async function flagQuestionsForReview(
  moduleId: string,
  db: DbClient,
  note: string,
  numbers?: number[],
): Promise<number> {
  let q = db
    .from("questions")
    .select("id, parsing_status, parsing_notes")
    .eq("module_id", moduleId)
    .neq("parsing_status", "Rejected");
  if (numbers) {
    if (numbers.length === 0) return 0;
    q = q.in("original_question_number", numbers);
  }
  const { data } = await q;
  let flagged = 0;
  for (const r of (data ?? []) as { id: string; parsing_status: string; parsing_notes: string | null }[]) {
    const base = (r.parsing_notes || "").trim();
    if (r.parsing_status === "Needs Review" && base.includes(note)) continue;
    flagged++;
    await db
      .from("questions")
      .update({
        parsing_status: "Needs Review",
        parsing_notes: base && !base.includes(note) ? `${base}; ${note}` : note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", r.id);
  }
  return flagged;
}

// ── Cut-off stem guard ───────────────────────────────────────────────
// Structured output ends a JSON string at the first unescaped double quote, so
// a stem can stop right before a quoted title ("…1926 short story, ") or come
// back empty when the passage opens with a quote.
export const STEM_CUT_OFF_NOTE = "Needs review: question text looks cut off — compare with the PDF.";

export function stemLooksCutOff(text: string | null | undefined): boolean {
  const t = (text ?? "").trimEnd();
  if (!t) return true;
  if (t.endsWith(",")) return true;
  // A word followed by one trailing space is where the quote that ended the
  // string sat ("…exposed to Metallica's "). Real stems end on punctuation.
  if (/[^\s] $/.test(text ?? "")) return true;
  const count = (re: RegExp) => (t.match(re) ?? []).length;
  if (count(/“/g) > count(/”/g)) return true;
  // Odd straight quotes where the last one opens a quotation (not an inch mark after a digit).
  if (count(/"/g) % 2 === 1 && /(^|[\s(\[—–-])"[^"]*$/.test(t)) return true;
  return false;
}

export async function enforceStemIntegrity(
  moduleId: string,
  db: DbClient,
): Promise<{ checked: number; flagged: number }> {
  const { data } = await db
    .from("questions")
    .select("original_question_number, question_text")
    .eq("module_id", moduleId)
    .neq("parsing_status", "Rejected");
  const rows = (data ?? []) as { original_question_number: number; question_text: string | null }[];
  const cut = rows.filter((r) => stemLooksCutOff(r.question_text)).map((r) => r.original_question_number);
  const flagged = await flagQuestionsForReview(moduleId, db, STEM_CUT_OFF_NOTE, cut);
  if (cut.length > 0) console.warn(`[stem-guard] module=${moduleId} cut-off stems: Q${cut.join(", Q")}`);
  return { checked: rows.length, flagged };
}
