// lib/explanation-scan.ts
//
// Patterns a student must never see in an explanation (used by
// scripts/scan-explanation-key-mismatch.ts and the restore script).

import {
  concludedLetters,
  explanationArguesOther,
  explanationWords,
  HEDGE,
  MAX_EXPLANATION_WORDS,
  numericProblems,
  RAMBLE,
  type AutoFixRow,
} from "@/lib/explanation-autofix";
import { chainMismatches, statedLetters } from "@/lib/explanation-consistency";
import { SPR_TYPE } from "@/lib/answer-key";

export type Pattern = "wait" | "let-me" | "re-check" | "hmm" | "other-narration" | "hedging" | "self-contradiction" | "very-long" | "final-not-key";
export const PATTERNS: Pattern[] = ["wait", "let-me", "re-check", "hmm", "other-narration", "hedging", "self-contradiction", "very-long", "final-not-key"];

/** Thinking-aloud patterns (the RAMBLE regex). */
export const NARRATION_PATTERNS: Pattern[] = ["wait", "let-me", "re-check", "hmm", "other-narration"];

/** Which patterns this explanation matches (empty = clean). */
export function scanPatterns(r: AutoFixRow): { patterns: Pattern[]; details: string[] } {
  const ex = r.explanation ?? "";
  const own = ex.replace(/"[^"\n]*"|“[^”]*”|'[^'\n]{3,}'|‘[^’\n]{3,}’/g, " ");
  const patterns = new Set<Pattern>();
  const details: string[] = [];
  const ramble = own.match(RAMBLE);
  if (ramble) {
    const t = ramble[0].toLowerCase();
    patterns.add(/^wait/.test(t) ? "wait" : /^let/.test(t) ? "let-me" : /re-?check/.test(t) ? "re-check" : /^hmm/.test(t) ? "hmm" : "other-narration");
    details.push(`narration "${ramble[0]}"`);
  }
  const hedge = own.match(HEDGE);
  if (hedge) {
    patterns.add("hedging");
    details.push(`hedge "${hedge[0]}"`);
  }
  const letters = new Set([...concludedLetters(ex), ...statedLetters(ex)]);
  const chains = chainMismatches(ex);
  if ((r.question_type !== SPR_TYPE && letters.size > 1) || chains.length) {
    patterns.add("self-contradiction");
    details.push(letters.size > 1 ? `names ${[...letters].join(" and ")}` : `writes ${chains[0].text.slice(0, 60)} (= ${+chains[0].computed.toPrecision(6)})`);
  }
  const words = explanationWords(ex);
  if (words > MAX_EXPLANATION_WORDS) {
    patterns.add("very-long");
    details.push(`${words} words`);
  }
  const other = explanationArguesOther(ex, r.correct_answer, r.question_type, r.question_text);
  const num = numericProblems(r, ex).filter((p) => !p.startsWith("writes "));
  if (other || num.length) {
    patterns.add("final-not-key");
    details.push(other ?? num[0]);
  }
  return { patterns: PATTERNS.filter((p) => patterns.has(p)), details };
}

