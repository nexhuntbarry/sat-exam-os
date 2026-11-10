// lib/key-check.ts
//
// Answer-key / question-type scanner (owner-approved 2026-11-07). Finds:
//   - fill-in (SPR) questions with a letter key or a key that isn't an
//     accepted SPR number, or that ignores "round to the nearest …";
//   - fill-in questions that still carry answer choices;
//   - Multiple choice questions whose key isn't A–D;
//   - AI-solved keys (no official answer) whose own explanation ends on a
//     different answer.
// …and proposes a correction where one can be worked out without AI.
// Read-only. Used by scripts/scan-key-type-mismatch.ts and the admin
// "Answer key check" page; applying a correction goes through
// /api/admin/key-check/{preview,apply} (preview of affected attempts first,
// rescoring only on explicit confirm).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MC_TYPE,
  SPR_TYPE,
  answersAgreeForQuestion,
  formatSprAnswer,
  keyCandidates,
  keyTypeProblem,
  normalizeKeyText,
  roundingInstruction,
  sprEntryProblem,
  sprValue,
  type KeyProblemCode,
} from "@/lib/answer-key";
import { extractFinalAnswer, inferImpliedAnswer } from "@/lib/ai/solve-question";
import { answersMatch } from "@/lib/grade-submission";
import { scaleSectionScore } from "@/lib/scoring";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { liveQuestionIds } from "@/lib/live-questions";
import { labelFullLengthChildren } from "@/lib/full-length";
import { tryEvaluate } from "@/lib/math/safe-eval";

export type QType = typeof MC_TYPE | typeof SPR_TYPE;

export interface KeyCheckRow {
  id: string;
  module_id: string | null;
  original_question_number: number | null;
  question_type: string | null;
  question_text: string | null;
  choices: unknown;
  correct_answer: string | null;
  official_answer: string | null;
  explanation: string | null;
  parsing_status: string | null;
  section: string | null;
}

export interface KeyCorrection {
  correct_answer?: string;
  question_type?: QType;
  /** Remove the choices (fill-in questions never have any). */
  clear_choices?: boolean;
}

export interface KeyCheckFinding {
  id: string;
  moduleId: string | null;
  moduleName: string | null;
  number: number | null;
  status: string | null;
  questionType: string | null;
  key: string | null;
  officialAnswer: string | null;
  code: KeyProblemCode | "ai-explanation-disagrees";
  reason: string;
  suggestion: KeyCorrection | null;
  /** Where the suggestion comes from (plain language). */
  suggestionWhy: string | null;
  /** Published + assigned test: never demoted, fixes get a [live-fix] note. */
  live: boolean;
  /** Question text excerpt for the list. */
  excerpt: string;
}

function choiceList(choices: unknown): { label: string; text: string; image_url?: string | null }[] {
  return Array.isArray(choices) ? (choices as { label: string; text: string; image_url?: string | null }[]).filter((c) => c && typeof c === "object") : [];
}

function fullChoiceSet(choices: unknown): boolean {
  const ch = choiceList(choices);
  return ch.length === 4 && ch.every((c) => (c.text ?? "").trim() || c.image_url);
}

/** The explanation's own final answer ("Final answer: X", else the last value it argues). */
export function explainedAnswer(row: Pick<KeyCheckRow, "explanation" | "question_type">): string | null {
  const e = row.explanation ?? "";
  if (!e.trim()) return null;
  return extractFinalAnswer(e) ?? (row.question_type === MC_TYPE ? inferImpliedAnswer(e, true) : null);
}

/** Try to turn a malformed fill-in key into an accepted one ("1,000" → 1000, "3 1/2" → 7/2, "50%" → 50). */
export function cleanSprKey(key: string, questionText: string | null): string | null {
  const rule = roundingInstruction(questionText);
  const parts: string[] = [];
  for (const c of keyCandidates(key)) {
    let s = normalizeKeyText(c)
      .replace(/^\\?\$\s*/, "")
      .replace(/\s*%$/, "")
      .replace(/(\d),(?=\d{3}\b)/g, "$1")
      .replace(/^[a-z]\s*=\s*/i, "")
      .replace(/\s*(?:cm|mm|m|km|in|ft|yd|mi|g|kg|lb|s|sec|min|hr|hours?|days?|dollars?|cents?|degrees?|°|units?|meters?|feet|inches|miles|percent)\.?$/i, "")
      .trim();
    const mixed = s.match(/^(-?)(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
    if (mixed) {
      const [, sign, whole, n, d] = mixed;
      if (Number(d) === 0) return null;
      s = `${sign}${Number(whole) * Number(d) + Number(n)}/${d}`;
    }
    const v = sprValue(s) ?? tryEvaluate(s);
    if (v === null) return null;
    const ok = !sprEntryProblem(s) && (!rule || formatSprAnswer(v, rule) === s);
    const fixed = ok ? s : formatSprAnswer(v, rule);
    if (!fixed) return null;
    // Without a rounding instruction the value itself must survive (a key
    // like 1905.12 that can't be entered is flagged, not silently changed).
    const fv = sprValue(fixed);
    if (!rule && (fv === null || Math.abs(fv - v) > 1e-9)) return null;
    if (!parts.includes(fixed)) parts.push(fixed);
  }
  return parts.length > 0 ? parts.join(" or ") : null;
}

/** A fill-in key taken from another answer (official key, explanation), in accepted form. */
function sprFrom(value: string | null | undefined, questionText: string | null): string | null {
  if (!value) return null;
  if (/^\(?[A-Da-d]\)?$/.test(normalizeKeyText(value))) return null;
  return cleanSprKey(value, questionText);
}

/** Pure: what's wrong with this row's key, and a proposed fix. */
export function analyzeKeyRow(row: KeyCheckRow): Omit<KeyCheckFinding, "moduleName" | "live" | "excerpt"> | null {
  const base = {
    id: row.id,
    moduleId: row.module_id,
    number: row.original_question_number,
    status: row.parsing_status,
    questionType: row.question_type,
    key: row.correct_answer,
    officialAnswer: row.official_answer,
  };
  const p = keyTypeProblem(row);
  const text = row.question_text;
  if (p) {
    let suggestion: KeyCorrection | null = null;
    let why: string | null = null;
    const key = (row.correct_answer ?? "").trim();
    switch (p.code) {
      case "spr-letter-key": {
        if (fullChoiceSet(row.choices)) {
          suggestion = { question_type: MC_TYPE };
          why = "it has four answer choices, so it's probably Multiple choice";
          break;
        }
        // The official key is a letter too: the PDF treats it as Multiple
        // choice whose choices got lost — that needs Re-extract, not a number.
        if (/^\(?[A-Da-d]\)?$/.test(normalizeKeyText(row.official_answer ?? ""))) break;
        const fromOfficial = sprFrom(row.official_answer, text);
        const trailer = sprFrom(explainedAnswer(row), text);
        const plainExpl = (row.explanation ?? "").replace(/\\d?frac\{\s*(-?\d+)\s*\}\{\s*(\d+)\s*\}/g, "$1/$2");
        const lastValue = sprFrom(inferImpliedAnswer(plainExpl, false), text);
        const clear = choiceList(row.choices).length > 0 || undefined;
        if (fromOfficial) {
          suggestion = { correct_answer: fromOfficial, clear_choices: clear };
          why = "the official answer";
        } else if (trailer) {
          suggestion = { correct_answer: trailer, clear_choices: clear };
          why = "the explanation's final answer";
        } else if (lastValue) {
          suggestion = { correct_answer: lastValue, clear_choices: clear };
          why = "the last value in the explanation — check it before applying";
        }
        break;
      }
      case "spr-invalid-form":
      case "spr-rounding": {
        const fixed = cleanSprKey(key, text);
        if (fixed && fixed !== key) {
          suggestion = { correct_answer: fixed };
          why = p.code === "spr-rounding" ? "the key rounded in code as the question asks" : "the same value in an accepted fill-in form";
        }
        break;
      }
      case "spr-has-choices": {
        // Students already answer it as fill-in and are graded on the number,
        // so removing the leftover choices changes nothing for them.
        suggestion = { clear_choices: true };
        why = "fill-in questions have no choices (students are graded on the number either way)";
        break;
      }
      case "mc-invalid-key": {
        const ch = choiceList(row.choices);
        if (ch.length === 0 && sprValue(normalizeKeyText(key)) !== null) {
          suggestion = { question_type: SPR_TYPE };
          why = "no choices and a number key, so it's probably Fill-in";
          break;
        }
        const norm = (s: string) => normalizeKeyText(s).replace(/\s+/g, " ").toLowerCase();
        const byText = ch.find((c) => (c.text ?? "").trim() && norm(c.text) === norm(key));
        const byValue = ch.find((c) => {
          const v = sprValue(normalizeKeyText(c.text ?? ""));
          return v !== null && (answersMatch(key, c.text) || answersAgreeForQuestion(key, c.text));
        });
        const hit = byText ?? byValue;
        if (hit) {
          suggestion = { correct_answer: hit.label.toUpperCase() };
          why = `the key is the text of choice ${hit.label}`;
        }
        break;
      }
    }
    return { ...base, code: p.code, reason: p.reason, suggestion, suggestionWhy: why };
  }

  // AI-solved key (no official answer) whose explanation ends elsewhere.
  if (!row.official_answer && row.correct_answer && row.explanation) {
    const expl = extractFinalAnswer(row.explanation);
    if (expl && !answersAgreeForQuestion(expl, row.correct_answer, text)) {
      let suggestion: KeyCorrection | null = null;
      if (row.question_type === SPR_TYPE) {
        const v = sprFrom(expl, text);
        if (v) suggestion = { correct_answer: v };
      } else if (row.question_type === MC_TYPE) {
        const l = normalizeKeyText(expl).replace(/^\(?([A-Da-d])\)?.*$/, "$1").toUpperCase();
        if (/^[A-D]$/.test(l)) suggestion = { correct_answer: l };
      }
      return {
        ...base,
        code: "ai-explanation-disagrees",
        reason: `the AI-solved key is "${row.correct_answer}" but its explanation ends with "${expl}"`,
        suggestion,
        suggestionWhy: suggestion ? "the explanation's final answer — check it, the explanation may be the wrong one" : null,
      };
    }
  }
  return null;
}

/** Scan every non-Rejected question. Read-only. */
export async function scanKeyTypeMismatch(db: SupabaseClient): Promise<KeyCheckFinding[]> {
  const { data: rows, error } = await fetchAllRows<KeyCheckRow>((from, to) =>
    db
      .from("questions")
      .select("id, module_id, original_question_number, question_type, question_text, choices, correct_answer, official_answer, explanation, parsing_status, section")
      .neq("parsing_status", "Rejected")
      .order("id")
      .range(from, to),
  );
  if (error) throw new Error(`scanKeyTypeMismatch: ${String((error as { message?: string }).message ?? error)}`);
  const found = rows.map((r) => ({ r, f: analyzeKeyRow(r) })).filter((x) => x.f !== null);
  if (found.length === 0) return [];
  const moduleIds = [...new Set(found.map((x) => x.r.module_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  for (let i = 0; i < moduleIds.length; i += 200) {
    const { data } = await db.from("modules").select("id, module_name").in("id", moduleIds.slice(i, i + 200));
    for (const m of data ?? []) names.set(m.id as string, m.module_name as string);
  }
  const live = await liveQuestionIds(db, found.filter((x) => x.r.parsing_status === "Approved").map((x) => x.r.id));
  return found
    .map(({ r, f }) => ({
      ...f!,
      moduleName: r.module_id ? names.get(r.module_id) ?? null : null,
      live: live.has(r.id),
      excerpt: (r.question_text ?? "").replace(/\s+/g, " ").slice(0, 140),
    }))
    .sort((a, b) => Number(b.live) - Number(a.live) || (a.moduleName ?? "").localeCompare(b.moduleName ?? "") || (a.number ?? 0) - (b.number ?? 0));
}

// ── Score preview for a key change ──────────────────────────────────

export interface AttemptPreview {
  submissionId: string;
  studentId: string | null;
  studentName: string;
  testName: string;
  studentAnswer: string | null;
  wasCorrect: boolean;
  nowCorrect: boolean;
  oldCorrect: number;
  newCorrect: number;
  total: number;
  oldScaled: number | null;
  newScaled: number;
}

export interface KeyChangePreview {
  questionId: string;
  oldKey: string | null;
  newKey: string;
  /** Graded answers for this question in total. */
  attempts: number;
  /** Only the attempts whose correctness changes. */
  changes: AttemptPreview[];
}

/**
 * What rescoring would do if the key became `newKey` — computed the same way
 * lib/rescore.ts recomputes, but nothing is written. `includeStudent` lets
 * the caller hide the other QA side's students.
 */
export async function previewKeyChange(
  db: SupabaseClient,
  questionId: string,
  newKey: string,
  includeStudent: (studentId: string | null) => boolean = () => true,
): Promise<KeyChangePreview> {
  const { data: q } = await db.from("questions").select("id, correct_answer, question_text").eq("id", questionId).maybeSingle();
  const oldKey = (q?.correct_answer as string | null) ?? null;
  const questionText = (q?.question_text as string | null) ?? null;
  const { data: records } = await fetchAllRows<{ id: string; submission_id: string; student_answer: string | null; is_correct: boolean | null }>((from, to) =>
    db
      .from("answer_records")
      .select("id, submission_id, student_answer, is_correct")
      .eq("question_id", questionId)
      .order("id")
      .range(from, to),
  );
  const flips = records
    .map((r) => ({ r, now: answersMatch(r.student_answer, newKey, questionText) }))
    .filter((x) => x.now !== !!x.r.is_correct);
  const subIds = [...new Set(flips.map((x) => x.r.submission_id))];
  const subs = new Map<string, { student_id: string | null; test_id: string | null; scaled_score: number | null }>();
  const counts = new Map<string, { correct: number; total: number }>();
  for (let i = 0; i < subIds.length; i += 100) {
    const chunk = subIds.slice(i, i + 100);
    const { data: s } = await db.from("submissions").select("id, student_id, test_id, scaled_score").in("id", chunk);
    for (const row of s ?? []) subs.set(row.id as string, row as { student_id: string | null; test_id: string | null; scaled_score: number | null });
    const { data: recs } = await fetchAllRows<{ submission_id: string; is_correct: boolean | null }>((from, to) =>
      db.from("answer_records").select("id, submission_id, is_correct").in("submission_id", chunk).order("id").range(from, to),
    );
    for (const r of recs) {
      const c = counts.get(r.submission_id) ?? { correct: 0, total: 0 };
      c.total++;
      if (r.is_correct) c.correct++;
      counts.set(r.submission_id, c);
    }
  }
  const studentIds = [...new Set([...subs.values()].map((s) => s.student_id).filter(Boolean))] as string[];
  const testIds = [...new Set([...subs.values()].map((s) => s.test_id).filter(Boolean))] as string[];
  const [users, tests] = await Promise.all([
    studentIds.length ? db.from("users").select("id, display_name, email").in("id", studentIds) : null,
    testIds.length ? db.from("tests").select("id, test_name").in("id", testIds) : null,
  ]);
  const userName = new Map(((users?.data ?? []) as { id: string; display_name: string | null; email: string | null }[]).map((u) => [u.id, u.display_name || u.email || "Student"]));
  const testName = new Map(((tests?.data ?? []) as { id: string; test_name: string | null }[]).map((t) => [t.id, t.test_name || "Test"]));
  await labelFullLengthChildren(db, testName);

  const changes: AttemptPreview[] = [];
  for (const { r, now } of flips) {
    const sub = subs.get(r.submission_id);
    if (!includeStudent(sub?.student_id ?? null)) continue;
    const c = counts.get(r.submission_id) ?? { correct: 0, total: 0 };
    const newCorrect = c.correct + (now ? 1 : -1);
    const pct = c.total ? Math.round((newCorrect / c.total) * 100 * 10) / 10 : 0;
    changes.push({
      submissionId: r.submission_id,
      studentId: sub?.student_id ?? null,
      studentName: (sub?.student_id && userName.get(sub.student_id)) || "Unknown student",
      testName: (sub?.test_id && testName.get(sub.test_id)) || "Unknown test",
      studentAnswer: r.student_answer,
      wasCorrect: !!r.is_correct,
      nowCorrect: now,
      oldCorrect: c.correct,
      newCorrect,
      total: c.total,
      oldScaled: sub?.scaled_score ?? null,
      newScaled: scaleSectionScore(pct),
    });
  }
  changes.sort((a, b) => a.testName.localeCompare(b.testName) || a.studentName.localeCompare(b.studentName));
  return { questionId, oldKey, newKey, attempts: records.length, changes };
}
