-- ============================================================
-- SAT Exam OS — Migration 0015
-- Per-submission SAT scaled score (200-800 per section). Computed at
-- submit time via the piecewise-linear estimator in lib/scoring.ts.
-- The percentage column stays the source of truth — scaled_score is
-- derived and shown alongside in the UI.
-- ============================================================

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS scaled_score INTEGER,
  ADD COLUMN IF NOT EXISTS scaled_section TEXT;

COMMENT ON COLUMN submissions.scaled_score IS
  'Estimated SAT section score (200-800). NULL until the submission has been graded.';

COMMENT ON COLUMN submissions.scaled_section IS
  'Section name for the scaled score: "Math" or "Reading & Writing". Cached at submit time so the UI can label without rejoining tests/modules.';
