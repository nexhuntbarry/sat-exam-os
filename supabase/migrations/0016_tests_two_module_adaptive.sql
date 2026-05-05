-- ============================================================
-- SAT Exam OS — Migration 0016
-- Two-module adaptive tests.
--
-- Real SAT serves Module 1, then routes the student to either an
-- easier or harder Module 2 based on the Module 1 score. We model
-- this with explicit columns instead of an array so admin UI + take
-- flow stay readable. Legacy single-module tests keep using
-- tests.module_id; new adaptive tests set is_adaptive=true and use
-- the three module_*_id columns plus adaptive_threshold.
--
-- Submission flow (handled in a follow-up batch):
--   1. Student starts test → submission for module_1_id created.
--   2. Module 1 submitted → score computed → if percentage >=
--      adaptive_threshold → module_2_hard_id, else module_2_easy_id.
--   3. New submission row for the chosen Module 2, sharing the test
--      + attempt_number. Combined SAT 200-800 score derived from both.
-- ============================================================

ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS is_adaptive BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS module_1_id UUID REFERENCES modules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS module_2_easy_id UUID REFERENCES modules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS module_2_hard_id UUID REFERENCES modules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS adaptive_threshold INTEGER NOT NULL DEFAULT 60;

COMMENT ON COLUMN tests.is_adaptive IS
  'When TRUE, this test serves Module 1 then routes to Module 2 (easy or hard) based on Module 1 score. When FALSE, falls back to single-module flow using tests.module_id.';

COMMENT ON COLUMN tests.adaptive_threshold IS
  'Module 1 percentage at or above which the student is routed to module_2_hard_id; below routes to module_2_easy_id. Default 60. Range 0..100.';

-- The columns above accept NULL so a draft test can be created and
-- modules picked later. The take-flow code path will refuse to start
-- an adaptive test until module_1_id + at least one Module 2 track
-- is set.

-- Helper view: which modules are referenced by which adaptive test —
-- handy for an admin "tests using this module" lookup before deleting
-- a module.
CREATE OR REPLACE VIEW adaptive_test_modules AS
SELECT
  t.id              AS test_id,
  t.test_name       AS test_name,
  'module_1'        AS slot,
  m.id              AS module_id,
  m.module_name     AS module_name
FROM tests t
JOIN modules m ON m.id = t.module_1_id
WHERE t.is_adaptive = TRUE
UNION ALL
SELECT t.id, t.test_name, 'module_2_easy', m.id, m.module_name
FROM tests t
JOIN modules m ON m.id = t.module_2_easy_id
WHERE t.is_adaptive = TRUE
UNION ALL
SELECT t.id, t.test_name, 'module_2_hard', m.id, m.module_name
FROM tests t
JOIN modules m ON m.id = t.module_2_hard_id
WHERE t.is_adaptive = TRUE;

COMMENT ON VIEW adaptive_test_modules IS
  'Long-form roster of which module fills which slot of which adaptive test. Useful for admin "tests using this module" filters and for backfilling stats per slot.';
