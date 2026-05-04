-- ============================================================
-- SAT Exam OS — Migration 0013
-- Tutor notes per submission. Lets a teacher (or reviewer-teacher)
-- record private follow-up notes on a specific student's specific
-- attempt — useful for 1-on-1 tutoring sessions where the teacher
-- wants to remember "we covered Q5 + Q12, student still confused on
-- absolute value graphing" without polluting the per-question
-- private_note channel that lives on test_teacher_notes.
-- ============================================================

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS tutor_notes TEXT;

COMMENT ON COLUMN submissions.tutor_notes IS
  'Free-form teacher notes scoped to this submission. Visible to admins and to teachers assigned to the test (including reviewer-teachers). Not shown to the student.';
