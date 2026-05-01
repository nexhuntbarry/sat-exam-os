-- ============================================================
-- SAT Exam OS — Migration 0009
-- Add official answer + mismatch flag to questions.
--
-- Goal: when a module's PDF includes an answer key on the last page,
-- the parser stores the official answer alongside the AI-derived
-- correct_answer. If they disagree, mismatch_with_official=true and
-- the question is auto-flagged for review.
-- ============================================================

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS official_answer TEXT,
  ADD COLUMN IF NOT EXISTS mismatch_with_official BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN questions.official_answer IS
  'Answer extracted from the PDF answer key (last page of the module). NULL when no answer key was detected. When non-null, this is treated as authoritative — correct_answer is overwritten to match.';

COMMENT ON COLUMN questions.mismatch_with_official IS
  'TRUE when the AI solver answer disagreed with the official answer at parse time. Forces parsing_status=Needs Review and surfaces a hint in parsing_notes for the admin to investigate.';

CREATE INDEX IF NOT EXISTS idx_questions_mismatch_with_official
  ON questions (mismatch_with_official)
  WHERE mismatch_with_official = TRUE;
