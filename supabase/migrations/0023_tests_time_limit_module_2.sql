-- ============================================================
-- SAT Exam OS — Migration 0023
-- Per-module time limits.
--
-- A test's time_limit_minutes was applied to BOTH modules of a 2-module
-- attempt. SAT modules sometimes have different per-module timing
-- (rare for English, more common for Math practice variants); admins
-- need to be able to set them independently. Add a Module-2 specific
-- time limit; legacy column stays as Module 1 / default fallback.
--
-- For adaptive tests both Module 2 easy/hard share the Module 2 value
-- (real SAT timing matches across difficulty tracks). Single-module
-- legacy tests ignore the new column.
-- ============================================================

ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS time_limit_minutes_module_2 INTEGER;

COMMENT ON COLUMN tests.time_limit_minutes IS
  'Time limit in minutes for Module 1 (or the only module on legacy single-module tests).';

COMMENT ON COLUMN tests.time_limit_minutes_module_2 IS
  'Optional time limit in minutes for Module 2 (both easy/hard tracks on adaptive tests). When NULL, falls back to time_limit_minutes.';
