-- ============================================================
-- SAT Exam OS — Migration 0021
-- Test "review unlocked" flag.
--
-- When the teacher flips this on (typically inside teaching-mode at
-- the start of a class walkthrough), every assigned student sees the
-- full question set + correct answers regardless of whether they took
-- the test. Used for in-class group review. Flip back off afterwards
-- to lock answers away again.
--
-- Distinct from `show_answers_after_submission` which only governs the
-- student's own result page after they themselves submit.
-- ============================================================

ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS review_unlocked BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tests.review_unlocked IS
  'When TRUE, every assigned student can open the read-only review page (questions + correct answers + explanations) without having taken the test. Toggled by teachers/admins from teaching-mode.';
