-- Phase 1D: Analytics — test_teacher_notes + analytics indexes

-- ────────────────────────────────────────────
-- TEACHER NOTES TABLE
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_teacher_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id      uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  teacher_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id  uuid REFERENCES questions(id) ON DELETE CASCADE,
  note_type    text NOT NULL CHECK (note_type IN ('class_review', 'private_note', 'observation')),
  note_body    text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, teacher_id, question_id, note_type)
);

-- ────────────────────────────────────────────
-- ANALYTICS INDEXES
-- ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_answer_records_question_correct
  ON answer_records (question_id, is_correct);

CREATE INDEX IF NOT EXISTS idx_submissions_test_status_score
  ON submissions (test_id, status, score);

CREATE INDEX IF NOT EXISTS idx_test_teacher_notes_test_teacher
  ON test_teacher_notes (test_id, teacher_id);

CREATE INDEX IF NOT EXISTS idx_test_teacher_notes_question
  ON test_teacher_notes (question_id);
