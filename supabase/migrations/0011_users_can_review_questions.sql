-- ============================================================
-- SAT Exam OS — Migration 0011
-- Per-user "question reviewer" permission so a key teacher can be
-- given the right to approve / reject / resolve-mismatch on the
-- shared question bank, without being promoted to admin.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_review_questions BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.can_review_questions IS
  'When TRUE, this user can review question-bank items (approve, reject, resolve mismatch, edit). Implicit for role=admin; meaningful when role=teacher to mark a "key teacher" without granting full admin power.';

CREATE INDEX IF NOT EXISTS idx_users_can_review_questions
  ON users (can_review_questions)
  WHERE can_review_questions = TRUE;
