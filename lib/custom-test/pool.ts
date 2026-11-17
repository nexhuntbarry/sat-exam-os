// lib/custom-test/pool.ts
//
// The questions a Custom test may pick (plan "Which questions can be
// picked"): Approved, no key doubt / review / live-fix / PDF-difference tag,
// domain + skill + difficulty set, an answer key, the figure and graph
// choices complete, and (for real admins) not from a QA account's upload.
// Each is annotated with its official domain/skill (lib/sat-skills) and a
// duplicate key, so copies imported from more than one PDF and repeated
// R&W passages are never picked twice. Questions of Custom test stage
// modules don't exist (stage modules own none), so nothing here is a copy
// of a Custom test.

import type { SupabaseClient } from "@supabase/supabase-js";
import { hasReviewTags } from "@/lib/key-doubt";
import { incompleteGraphChoices, stemFigureMissing } from "@/lib/parse-guards";
import { splitPassageAndStem } from "@/lib/passage-split";
import { canonicalSkill } from "@/lib/sat-skills";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { DIFFICULTIES, type Difficulty, type PartKey } from "@/lib/custom-test/rules";
import type { PoolQuestion } from "@/lib/custom-test/select";

export interface BankRow {
  id: string;
  module_id: string | null;
  section: string | null;
  domain: string | null;
  skill: string | null;
  difficulty: string | null;
  parsing_status: string | null;
  parsing_notes: string | null;
  correct_answer: string | null;
  question_text: string | null;
  choices: unknown;
  has_image: boolean | null;
  has_table: boolean | null;
  image_urls: unknown;
  original_question_number?: number | null;
}

export const BANK_COLUMNS =
  "id, module_id, section, domain, skill, difficulty, parsing_status, parsing_notes, correct_answer, question_text, choices, has_image, has_table, image_urls, original_question_number";

/** Why a bank question can't go into a Custom test, or null when it can. */
export function ineligibleReason(q: BankRow): string | null {
  if (q.parsing_status !== "Approved") return "not Approved";
  if (hasReviewTags(q.parsing_notes)) return "in the review queue (key doubt / live-fix / PDF tag)";
  if (!q.domain?.trim() || !q.skill?.trim() || !DIFFICULTIES.includes(q.difficulty as Difficulty)) return "domain, skill or difficulty missing";
  if (!q.correct_answer?.trim()) return "no answer key";
  if (stemFigureMissing(q)) return "figure missing";
  if (incompleteGraphChoices(q.choices).length > 0) return "graph choices incomplete";
  return null;
}

/** Text with tags, markdown and spacing removed, lower-cased. */
export function normalizeText(s: string): string {
  return s
    // Inline tags (<u>, <b>) vanish; block breaks become spaces.
    .replace(/<\/?(br|p|div|li|tr|td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_`#>~|\\]/g, "")
    .replace(/\$+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Duplicate key: R&W = the passage (splitPassageAndStem, else the whole
 * text), first 300 normalised characters — two questions on one passage
 * count as a repeat. Math = the whole normalised stem plus the choices.
 */
export function dupKey(part: PartKey, q: Pick<BankRow, "question_text" | "choices">): string {
  const text = q.question_text ?? "";
  if (part === "rw") {
    const { passage } = splitPassageAndStem(text);
    return `rw:${normalizeText(passage ?? text).slice(0, 300)}`;
  }
  const choices = Array.isArray(q.choices)
    ? (q.choices as { text?: string | null }[]).map((c) => normalizeText(c?.text ?? "")).join("|")
    : "";
  return `math:${normalizeText(text)}#${choices}`;
}

export function partOfSection(section: string | null | undefined): PartKey | null {
  return section === "Math" ? "math" : section === "Reading & Writing" ? "rw" : null;
}

/** A bank row as a pool question, or null when it isn't eligible. */
export function toPoolQuestion(q: BankRow, moduleSection?: string | null): PoolQuestion | null {
  if (ineligibleReason(q)) return null;
  const part = partOfSection(q.section) ?? partOfSection(moduleSection);
  if (!part) return null;
  const canon = canonicalSkill(part === "math" ? "Math" : "Reading & Writing", q.domain, q.skill, {
    quantitative: Boolean(q.has_table || q.has_image),
  });
  return { id: q.id, part, domain: canon.domain, skill: canon.skill, difficulty: q.difficulty as Difficulty, dupKey: dupKey(part, q) };
}

export interface LoadedPool {
  questions: PoolQuestion[];
  /** Bank rows by id (summaries for the preview). */
  rows: Map<string, BankRow & { module_name: string | null }>;
}

/**
 * Every eligible question, annotated. QA uploads are left out unless the
 * viewer is a QA account (the nightly harness). Throws on a lookup error.
 */
export async function loadPool(db: SupabaseClient, opts: { qaUploaders: Set<string>; viewerIsQa: boolean }): Promise<LoadedPool> {
  type Row = BankRow & { modules: { section: string | null; uploaded_by: string | null; module_name: string | null } | null };
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    db
      .from("questions")
      .select(`${BANK_COLUMNS}, modules!inner(section, uploaded_by, module_name)`)
      .eq("parsing_status", "Approved")
      .order("id")
      .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>,
  );
  if (error) throw new Error(`question bank lookup failed: ${(error as { message?: string }).message ?? error}`);
  const questions: PoolQuestion[] = [];
  const rows = new Map<string, BankRow & { module_name: string | null }>();
  for (const r of data) {
    const by = r.modules?.uploaded_by ?? null;
    if (!opts.viewerIsQa && by && opts.qaUploaders.has(by)) continue;
    const q = toPoolQuestion(r, r.modules?.section);
    if (!q) continue;
    questions.push(q);
    const { modules, ...rest } = r;
    rows.set(r.id, { ...rest, module_name: modules?.module_name ?? null });
  }
  return { questions, rows };
}
