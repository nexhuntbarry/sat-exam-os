-- ============================================================
-- SAT Exam OS — Migration 0019
-- Make tests.module_id nullable for adaptive tests.
--
-- 0016 introduced adaptive tests that store their modules in
-- module_1_id / module_2_easy_id / module_2_hard_id and leave
-- tests.module_id NULL. The original 0001 schema declared
-- tests.module_id as NOT NULL, so creating an adaptive test fails
-- with: null value in column "module_id" violates not-null constraint.
--
-- Drop the NOT NULL. The non-adaptive code path still sets module_id
-- on every insert, and the take/submit code already falls back to
-- submission.module_id (set by the start endpoint) so the runtime
-- contract is preserved.
-- ============================================================

ALTER TABLE tests
  ALTER COLUMN module_id DROP NOT NULL;
