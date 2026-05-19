-- ============================================================
-- SAT Exam OS — Migration 0022
-- Non-adaptive two-module tests.
--
-- Real SAT delivers each section as Module 1 → Module 2 even when
-- there's no adaptive routing. Adding tests.module_2_id lets admins
-- build a normal (non-adaptive) test that still serves both modules
-- in sequence; legacy single-module tests stay supported by leaving
-- module_2_id NULL.
--
-- We also widen submissions.adaptive_track to allow the plain
-- 'module_2' label for the non-adaptive case (the existing values
-- module_2_easy / module_2_hard remain reserved for adaptive routing).
-- ============================================================

ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS module_2_id UUID REFERENCES modules(id) ON DELETE SET NULL;

COMMENT ON COLUMN tests.module_2_id IS
  'Optional Module 2 for non-adaptive tests. When set, the take flow serves Module 1 (tests.module_id) then Module 2 in sequence with no routing decision. Adaptive tests ignore this column and use module_2_easy_id / module_2_hard_id instead.';

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_adaptive_track_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_adaptive_track_check
    CHECK (
      adaptive_track IS NULL
      OR adaptive_track IN ('module_1', 'module_2', 'module_2_easy', 'module_2_hard')
    );

COMMENT ON COLUMN submissions.adaptive_track IS
  'Slot label: module_1 / module_2 (non-adaptive) / module_2_easy / module_2_hard (adaptive). NULL for legacy single-module submissions.';
