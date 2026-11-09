// lib/key-source.ts
//
// Where did a question's answer key come from? (Premier request 2026-11-07.)
// [Test #14] J Test Math M1 Q5 showed "OFFICIAL ANSWER KEY: B" plus a "Trust
// answer key" button, but that PDF has no answer key: the AI extractor made
// "B" up while parsing. The review page now labels the key by its real
// source and offers "Trust answer key" only for a key that really came from
// the PDF's answer page / ✓ marks.
//
// Derived from existing data only (no DB column):
//   - official_answer, and whether it can be real (a letter on a fill-in
//     question never is; lib/answer-marks.ts),
//   - module facts: another fill-in question in the same module given a
//     letter by the same extracted key (the parse-time "key disagrees with
//     the solved answers on N of M" note, lib/parse-guards
//     keyDisagreementNote, is only shown as a caution),
//   - parsing_notes history: "Answer key check: key X → Y (applied by …)"
//     (lib/key-change.ts), "AI-only key verified (…)" (lib/verify-ai-key.ts),
//     the AI-solver notes, and "the answer key read from the PDF was not
//     used" (lib/answer-marks.ts keyRejectedNote).
// Pure and client-safe: the note prefixes are repeated here (the modules
// that write them pull in server code); scripts/test-key-source.ts checks
// they still match what those modules write.

import { SPR_TYPE, answersAgreeForQuestion, keyCandidates, normalizeKeyText } from "@/lib/answer-key";

export type KeySourceKind = "official-pdf" | "reviewer" | "ai-checked" | "ai-agreed" | "ai" | "ai-parsed" | "other-version" | "unknown";

export interface KeySource {
  kind: KeySourceKind;
  /** Short label shown next to the key. */
  label: string;
  /** One sentence on where the key came from. */
  detail: string;
  /** official_answer really comes from the PDF's answer page / marks. */
  officialFromPdf: boolean;
  /** Why official_answer can't be trusted (null when it can, or there is none). */
  officialProblem: string | null;
}

// Wording owner-approved 2026-11-08 (Premier retest): every key says how it
// was set, so a reviewer knows how much to trust it.
export const KEY_SOURCE_LABELS: Record<KeySourceKind, string> = {
  "official-pdf": "Official answer key (PDF)",
  reviewer: "Set by a reviewer",
  "ai-checked": "Solved by AI · checked by code",
  "ai-agreed": "Solved by AI · confirmed by a second solve",
  ai: "Solved by AI · not yet checked",
  "ai-parsed": "Made up by AI while reading the PDF",
  "other-version": "From another version's answer key · not checked",
  unknown: "Source not recorded",
};

/**
 * Backfilled / recorded source of the CURRENT key (scripts/backfill-key-source.ts,
 * lib/review-auto.ts): "Key source for <key>: <kind> — <detail>". Tied to the
 * key it describes, so it stops counting once the key changes.
 */
export const KEY_SOURCE_NOTE_PREFIX = "Key source for";
const KEY_SOURCE_NOTE_RE = /^Key source for (.+?): (official-pdf|reviewer|ai-checked|ai-agreed|ai|ai-parsed|other-version) — (.+)$/;

export function keySourceNote(key: string, kind: Exclude<KeySourceKind, "unknown">, detail: string): string {
  const safe = (s: string) => s.replace(/;/g, ",").replace(/\s+/g, " ").trim();
  return `${KEY_SOURCE_NOTE_PREFIX} ${safe(key)}: ${kind} — ${safe(detail)}`;
}

/** "2026-11-07T20:45:23Z" → "Nov 7, 2026" (null when missing / invalid). */
function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}

/** Facts about the module's extracted key (see moduleKeyFacts). */
export interface ModuleKeyFacts {
  /** Some question of the module has an official (PDF) key. Undefined: not known. */
  hasOfficialKey?: boolean;
  /** Fill-in questions of this module that the extracted key gave a choice letter. */
  sprLetterQuestions: number[];
  /** The parse-time "key disagrees with the solved answer on N of M" note, if any. */
  keyDisagreement: string | null;
}

export interface KeySourceRow {
  question_type: string | null | undefined;
  correct_answer: string | null | undefined;
  official_answer: string | null | undefined;
  question_text?: string | null;
  parsing_notes?: string | null;
  /** A person approved the question (questions.reviewed_by / reviewed_at). */
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  /** The reviewer's name, when the caller looked it up. */
  reviewer_name?: string | null;
}

const LETTER = /^\(?\s*[A-Da-d]\s*\)?\.?$/;
// lib/parse-guards.ts keyDisagreementNote
const MODULE_DISAGREE_RE = /the PDF's answer key disagrees with the solved answer on (\d+) of (\d+) questions/i;
// lib/answer-marks.ts KEY_REJECTED_PREFIX
const KEY_REJECTED_RE = /^Needs review: the answer key read from the PDF was not used\b/i;
// Hand-written notes saying the same ("the key was invented by the AI parser").
const KEY_INVENTED_RE = /\bkey was (?:invented|made up)\b|\bthis PDF has no answer key\b/i;
// lib/verify-ai-key.ts AI_KEY_VERIFIED_PREFIX
const AI_VERIFIED_RE = /^AI-only key verified\b/i;
// lib/verify-ai-key.ts AI_ONLY_KEY_NOTES + lib/ai/consensus-solve.ts
const AI_SOLVED_RES: RegExp[] = [
  /^Answer & explanation generated by AI solver\b/i,
  /^Solver self-contradicted\b/i,
  /^stored the explained answer\b/i,
  /^Consensus solve NOT unanimous\b/i,
  /^\d+ solves agreed on .+ but verifier disagreed\b/i,
  /^No official answer in key for Q\d+\b/i,
  /^Auto-settled: 3 independent solves agreed\b/i,
];
// lib/key-change.ts: "Answer key check: key X → Y (applied by WHO[, DATE])",
// also after a "[live-fix] … " lead-in on the same segment. WHO may hold one
// level of parentheses ("a reviewer (review queue)").
const REVIEWER_KEY_RE = /Answer key check: (?:[^,]*, )?key (.+?) → (.+?)(?:, (?:choices removed|type .+?))? \(applied by ((?:[^()]|\([^()]*\))*)\)/i;
// Hand fixes written into notes: "Key fix 2026-11-04 (approved by Barry): A → B",
// "Key corrected C → B (Premier checked by hand 2026-11-07)", "key corrected
// C→B per the PDF answer key (p28)".
const HAND_KEY_RE = /\bkey (?:corrected|fix(?:ed)?)\b([^;]*?)(?:key )?([A-D]|-?[\d./]+)\s*→\s*([A-D]|-?[\d./]+)\b([^;]*)/i;
// "explanation rewritten by hand for key A (Premier confirmed the key, 2026-11-07)"
const CONFIRMED_KEY_RE = /\b(Premier|Barry) (?:confirmed the key|checked (?:it )?by hand)(?:,? (\d{4}-\d{2}-\d{2}))?/;
// lib/explanation-autofix.ts autoFixNote: an independent solve (never shown the key) agreed with it.
const AI_AGREED_RE = /^Explanation auto-fixed: regenerated from the saved key, AI's own answer agreed\b/i;
const DIFFERENT_VERSION_RE = /read from a different version's PDF/i;
/** Set by the system (lib/review-auto.ts, scripts/auto-key-no-key-modules.ts): two solves agreed. */
const AUTO_KEY_BY_RE = /^(?:auto-key\b|the system\b)/i;

/** "; "-separated notes, keeping ";" inside (…) / […] together. */
function noteSegments(notes: string | null | undefined): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of notes ?? "") {
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    if (ch === ";" && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Module-level facts from the module's questions (number, type, official key, notes). */
export function moduleKeyFacts(
  rows: Array<{ original_question_number: number | null; question_type: string | null; official_answer: string | null; parsing_notes?: string | null }>,
): ModuleKeyFacts {
  const sprLetterQuestions = rows
    .filter((r) => r.question_type === SPR_TYPE && LETTER.test(normalizeKeyText(r.official_answer)))
    .map((r) => r.original_question_number ?? 0)
    .sort((a, b) => a - b);
  let keyDisagreement: string | null = null;
  for (const r of rows) {
    const m = (r.parsing_notes ?? "").match(MODULE_DISAGREE_RE);
    if (m && r.official_answer) {
      keyDisagreement = `${m[1]} of ${m[2]}`;
      break;
    }
  }
  return { sprLetterQuestions, keyDisagreement, hasOfficialKey: rows.some((r) => !!normalizeKeyText(r.official_answer)) };
}

/** Why this official_answer isn't a real key from the PDF (null = it is, or there is none). */
export function officialKeyProblem(q: KeySourceRow, mod?: ModuleKeyFacts | null): string | null {
  const official = normalizeKeyText(q.official_answer);
  if (!official) return null;
  if (q.question_type === SPR_TYPE && keyCandidates(official).some((c) => LETTER.test(normalizeKeyText(c)))) {
    return `it gives the choice letter "${official}" to a fill-in question, which a real answer key never does`;
  }
  const segs = noteSegments(q.parsing_notes);
  if (segs.some((s) => KEY_REJECTED_RE.test(s) || KEY_INVENTED_RE.test(s))) {
    return "the PDF has no answer key, so this value was made up while the PDF was read";
  }
  if (mod?.sprLetterQuestions.length) {
    const qs = mod.sprLetterQuestions;
    return `the key read from this module's PDF gives a choice letter to fill-in question${qs.length > 1 ? "s" : ""} Q${qs.join(", Q")}, so it can't be trusted`;
  }
  // mod.keyDisagreement alone doesn't disqualify a key: [Test #23] Nov 2023
  // INT English M2 has a real ✓-marked key and still disagrees with the AI
  // on 9 of 27. The review page shows it as a caution instead.
  return null;
}

/** Where the current correct_answer came from. */
export function keySource(q: KeySourceRow, mod?: ModuleKeyFacts | null): KeySource {
  const official = normalizeKeyText(q.official_answer);
  const officialProblem = officialKeyProblem(q, mod);
  const officialFromPdf = !!official && officialProblem === null;
  const key = normalizeKeyText(q.correct_answer);
  const agrees = (a: string, b: string) => !!a && !!b && (answersAgreeForQuestion(a, b, q.question_text) || answersAgreeForQuestion(b, a, q.question_text));
  const make = (kind: KeySourceKind, detail: string): KeySource => ({ kind, label: KEY_SOURCE_LABELS[kind], detail, officialFromPdf, officialProblem });

  if (officialFromPdf && agrees(key, official)) {
    return make("official-pdf", "Read from the answer key page / ✓ marks of the source PDF.");
  }

  const segs = noteSegments(q.parsing_notes);
  // A recorded source for exactly this key (backfill / the system).
  for (let i = segs.length - 1; i >= 0; i--) {
    const m = segs[i].match(KEY_SOURCE_NOTE_RE);
    if (m && agrees(key, normalizeKeyText(m[1]))) {
      const kind = m[2] as Exclude<KeySourceKind, "unknown">;
      if (kind === "official-pdf" && !officialFromPdf) continue;
      const src = make(kind, m[3].trim());
      if (kind === "reviewer") src.label = reviewerLabel(m[3], null, "Set");
      return src;
    }
  }
  // The latest key change that set the current key.
  for (let i = segs.length - 1; i >= 0; i--) {
    const m = segs[i].match(REVIEWER_KEY_RE);
    if (m && agrees(key, normalizeKeyText(m[2]))) {
      const { who, date } = splitWhoDate(m[3]);
      if (AUTO_KEY_BY_RE.test(who)) {
        return make("ai-checked", `Set automatically from ${m[1].trim()} to ${m[2].trim()}: no answer key in the PDF, and the code-checked solve and a second independent solve agree.`);
      }
      const src = make("reviewer", `Changed from ${m[1].trim()} to ${m[2].trim()} by ${who}${date ? ` on ${shortDate(date)}` : ""}.`);
      src.label = reviewerLabel(who === "a reviewer (review queue)" || /^an? (?:admin|reviewer)\b/i.test(who) ? q.reviewer_name ?? null : who, date ?? q.reviewed_at ?? null, "Set");
      return src;
    }
  }
  if (official && !officialFromPdf && agrees(key, official)) {
    return make("ai-parsed", `Not an official key: ${officialProblem}.`);
  }
  // A hand fix recorded in words.
  for (let i = segs.length - 1; i >= 0; i--) {
    const m = segs[i].match(HAND_KEY_RE);
    if (!m || !agrees(key, normalizeKeyText(m[3]))) continue;
    const text = `${m[1]} ${m[4]}`;
    if (/per the PDF answer key|matches the PDF answer key/i.test(text)) {
      return make("reviewer", `Corrected from ${m[2]} to ${m[3]} by hand to match the PDF's answer key.`);
    }
    const who = text.match(/approved by ([A-Z][\w ]*?)\)/)?.[1] ?? text.match(/\(([A-Z][\w ]*?) checked by hand/)?.[1] ?? null;
    const date = segs[i].match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    const src = make("reviewer", `Changed from ${m[2]} to ${m[3]} by hand${who ? ` (${who})` : ""}${date ? ` on ${shortDate(date)}` : ""}.`);
    src.label = reviewerLabel(who, date, "Set");
    return src;
  }
  for (const s of segs) {
    const m = s.match(CONFIRMED_KEY_RE);
    if (m) {
      const src = make("reviewer", `${m[1]} confirmed this key${m[2] ? ` on ${shortDate(m[2])}` : ""}.`);
      src.label = reviewerLabel(m[1], m[2] ?? null, "Confirmed");
      return src;
    }
  }
  const verified = segs.find((s) => AI_VERIFIED_RE.test(s));
  if (verified) {
    return make("ai-checked", "No answer key in the PDF. The AI's answer was re-solved and checked in code (computation, plug-back, second solve).");
  }
  // A person approved the question with this key.
  if (q.reviewed_by && q.reviewed_at) {
    const src = make("reviewer", `No answer key in the PDF; ${q.reviewer_name ?? "a reviewer"} approved the question with this key${shortDate(q.reviewed_at) ? ` on ${shortDate(q.reviewed_at)}` : ""}.`);
    src.label = reviewerLabel(q.reviewer_name ?? null, q.reviewed_at, "Confirmed");
    return src;
  }
  if (!officialFromPdf && segs.some((s) => AI_AGREED_RE.test(s))) {
    return make("ai-agreed", "No answer key in the PDF. The explanation was rewritten from a solve that never saw the key, and that solve reached the same answer.");
  }
  if (segs.some((s) => AI_SOLVED_RES.some((re) => re.test(s)))) {
    return make("ai", "No answer key in the PDF. The AI solved it and nothing has checked it yet — verify before trusting it.");
  }
  if (officialFromPdf) {
    // Differs from a real official key and no reviewer note explains it.
    return make("ai", `Differs from the official key ${official}; it was probably the AI's answer.`);
  }
  if (segs.some((s) => DIFFERENT_VERSION_RE.test(s))) {
    return make("other-version", "The answer key read at import belonged to a different version of the test (its official field was cleared). Nothing records a check of the saved key for this version.");
  }
  if (mod && mod.hasOfficialKey === false) {
    // No answer key anywhere in this module's PDF: the key can only have come from the AI at import.
    return make("ai", "This module's PDF has no answer key, so the AI set this key when the PDF was imported. Nothing has checked it yet.");
  }
  return make("unknown", "There is no official key for this question and no note records who set this one.");
}

/** "WHO, 2026-11-09" → { who, date }. */
function splitWhoDate(s: string): { who: string; date: string | null } {
  const m = s.trim().match(/^(.*?),\s*(\d{4}-\d{2}-\d{2})$/);
  return m ? { who: m[1].trim(), date: m[2] } : { who: s.trim(), date: null };
}

/** "Set by a reviewer (Premier Plus Education, Nov 7, 2026)". */
function reviewerLabel(who: string | null, date: string | null, verb: "Set" | "Confirmed"): string {
  const parts: string[] = [];
  // A backfill detail ("confirmed by NAME on DATE"): pull the name / date out of it.
  const fromDetail = who?.match(/by (.+?)(?: on ([A-Z][a-z]{2} \d{1,2}, \d{4}))?\.?$/);
  const name = (fromDetail ? fromDetail[1] : who)?.replace(/\s*\([^()]*\)$/, "").replace(/[()]/g, "").trim() || null;
  const when = fromDetail?.[2] ?? shortDate(date);
  if (name && !/^an? (?:admin|reviewer)\b/i.test(name)) parts.push(name);
  if (when) parts.push(when);
  return `${verb} by a reviewer${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
