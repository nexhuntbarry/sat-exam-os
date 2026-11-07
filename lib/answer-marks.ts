// lib/answer-marks.ts
//
// Does this PDF actually carry answers? Guards against an "official" answer
// key the AI extractor made up (2026-11-07, [Test #14] J Test Math M1: the
// upload probe said "no key", the parse-time call then returned 22 answers
// for a student printout with no marks — four of them letters on fill-in
// questions). See .omc/reports/module-key-investigation-2026-11-07.md.
//
// Rules (deterministic, read from the PDF text layer):
//  - A Premier "Survey: print page" printout carries answers ONLY when its
//    footer URL has `answer_token` AND choices show ✓ marks, or when an
//    answer-key page was appended to it. The student copy (no token, no
//    marks, no key page) never yields a key.
//  - Other PDFs can't be judged from text: several are screenshots with an
//    OCR text layer whose key pages are images (March 2026 Math/English).
//    There the extractor's own found=false applies, plus the fill-in letter
//    check below.
// Checked against every module PDF on 2026-11-07: no module with a real
// official key is blocked; the 6 Premier student copies are.
//  - An extracted key that gives a choice letter to a fill-in (SPR) question
//    is rejected as a whole: a real key never does that.

import { loadPdfDocument } from "@/lib/pdf-text-choices";
import { CHECK_GLYPH } from "@/lib/printout-layout";
import { SPR_TYPE } from "@/lib/answer-key";

export interface AnswerMarkFacts {
  /** The PDF has a usable text layer (enough characters to judge). */
  textLayer: boolean;
  /** Footer/print URL of a premierdigitalsat.com survey printout. */
  premierPrintout: boolean;
  /** That URL carries `answer_token` (the answer version of the printout). */
  answerToken: boolean;
  /** Check-mark glyphs (✓ / FontAwesome check icons) in the text layer. */
  checkMarks: number;
  /** Text that looks like an answer-key page / roster. */
  keyPageCue: boolean;
}

const PREMIER_URL = /premierdigitalsat\.com\/survey\/print\//i;
const KEY_PAGE_CUE =
  /\banswer\s*key\b|\banswer\s+explanations?\b|\bAK\b|^\s*answers\s*$|(?:\b\d{1,2}\s*[.):]\s*\(?[A-D]\)?\s+){5,}/im;
const MIN_TEXT_CHARS = 200;

export function answerMarkFactsFromText(text: string): AnswerMarkFacts {
  const chars = text.replace(/\s+/g, "").length;
  return {
    textLayer: chars >= MIN_TEXT_CHARS,
    premierPrintout: PREMIER_URL.test(text),
    answerToken: /[?&]answer_token=/i.test(text),
    checkMarks: (text.match(new RegExp(CHECK_GLYPH.source, "g")) ?? []).length,
    keyPageCue: KEY_PAGE_CUE.test(text),
  };
}

/** Read the facts from the PDF's text layer (every page). */
export async function readAnswerMarkFacts(pdfBase64: string): Promise<AnswerMarkFacts> {
  const { doc } = await loadPdfDocument(pdfBase64);
  try {
    let text = "";
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      // Items on one line are joined with spaces; a line break per item keeps
      // "^answers$" style headings matchable.
      text += (tc.items as { str?: string; hasEOL?: boolean }[]).map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : " ")).join("") + "\n";
    }
    return answerMarkFactsFromText(text);
  } finally {
    await doc.destroy();
  }
}

/**
 * Why no answer key may be taken from this PDF (null = a key may be present).
 * Shown as the probe's note and logged by the parse route.
 */
export function noAnswerMarksReason(f: AnswerMarkFacts): string | null {
  // An appended answer-key page still counts ([Test #12] L Test M1 p14).
  if (f.premierPrintout && !(f.answerToken && f.checkMarks > 0) && !f.keyPageCue) {
    return f.answerToken
      ? "This printout's choices carry no ✓ marks and it has no answer-key page, so it has no answer key — answers will be solved by AI and marked unverified."
      : "This is the student copy of the printout (its print URL has no answer_token, no choice is ✓-marked and there is no answer-key page), so it has no answer key — answers will be solved by AI and marked unverified.";
  }
  return null;
}

const LETTER = /^\(?\s*[A-Da-d]\s*\)?\.?$/;

/**
 * Fill-in questions that an extracted key gives a choice letter (null = none).
 * `questions` carries each question's number and type after parsing.
 */
export function sprLetterKeyQuestions(
  key: Record<number, string> | null | undefined,
  questions: { original_question_number: number; question_type: string | null | undefined }[],
): number[] | null {
  if (!key) return null;
  const bad = questions
    .filter((q) => q.question_type === SPR_TYPE && LETTER.test((key[q.original_question_number] ?? "").trim()))
    .map((q) => q.original_question_number)
    .sort((a, b) => a - b);
  return bad.length > 0 ? bad : null;
}

export const KEY_REJECTED_PREFIX = "Needs review: the answer key read from the PDF was not used";

/** parsing_notes segment (no ";") when an extracted key is thrown out. */
export function keyRejectedNote(reason: string): string {
  return `${KEY_REJECTED_PREFIX} — ${reason.replace(/;/g, ",").replace(/\.$/, "")}. Answers are AI-solved — verify them.`;
}

export function sprLetterKeyReason(numbers: number[]): string {
  return `it gives a choice letter to fill-in question${numbers.length > 1 ? "s" : ""} Q${numbers.join(", Q")}, which a real key never does`;
}
