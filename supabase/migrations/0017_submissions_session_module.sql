-- ============================================================
-- SAT Exam OS — Migration 0017
-- Two-module submission threading.
--
-- An adaptive test attempt is now two submission rows linked by a
-- shared session_id. The first row belongs to module_1; once it's
-- graded the route picker (adaptive_threshold) inserts a second
-- In-Progress row for the chosen Module 2 (easy or hard track).
-- The session is what represents "one attempt" — attempt_number is
-- incremented at the session level on retake.
--
-- Legacy single-module submissions stay as one row per attempt with
-- session_id NULL and module_id taken from the test.
-- ============================================================

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS session_id UUID,
  ADD COLUMN IF NOT EXISTS module_id UUID REFERENCES modules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS adaptive_track TEXT;

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_adaptive_track_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_adaptive_track_check
    CHECK (adaptive_track IS NULL OR adaptive_track IN ('module_1', 'module_2_easy', 'module_2_hard'));

-- Backfill module_id for existing single-module submissions so the
-- submit/grade path can read it uniformly. Adaptive submissions are
-- introduced by this migration so there are none to backfill.
UPDATE submissions s
SET module_id = t.module_id
FROM tests t
WHERE s.test_id = t.id
  AND s.module_id IS NULL
  AND t.module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_session
  ON submissions (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_test_student_attempt
  ON submissions (test_id, student_id, attempt_number);

-- The legacy UNIQUE (test_id, student_id, attempt_number) forbids the
-- second submission row of an adaptive attempt (Module 1 + Module 2
-- share an attempt_number). Drop it and replace with two partial
-- uniques: legacy single-module attempts stay 1-row-per-attempt as
-- before, adaptive attempts allow at most one row per (slot).
ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_test_id_student_id_attempt_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_submissions_attempt_legacy
  ON submissions (test_id, student_id, attempt_number)
  WHERE adaptive_track IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_submissions_attempt_adaptive
  ON submissions (test_id, student_id, attempt_number, adaptive_track)
  WHERE adaptive_track IS NOT NULL;

COMMENT ON COLUMN submissions.session_id IS
  'Groups two submissions of the same adaptive attempt (Module 1 + chosen Module 2). NULL for legacy single-module submissions.';

COMMENT ON COLUMN submissions.module_id IS
  'Which module this submission graded against. For non-adaptive tests this duplicates tests.module_id; for adaptive tests it is one of tests.module_1_id / module_2_easy_id / module_2_hard_id.';

COMMENT ON COLUMN submissions.adaptive_track IS
  'Slot label: module_1 / module_2_easy / module_2_hard. NULL for legacy submissions.';
