-- Phase 1C: Tests — submissions metadata + indexes
-- Adds metadata column to submissions, ensures indexes for performance

-- Add metadata column to submissions for anti-cheat tracking
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

-- Add question_ids column to tests for filtering which questions to include
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS question_ids jsonb;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_submissions_test_student_status
  ON submissions (test_id, student_id, status);

CREATE INDEX IF NOT EXISTS idx_submissions_test_attempt
  ON submissions (test_id, attempt_number);

CREATE INDEX IF NOT EXISTS idx_tests_status
  ON tests (status);

CREATE INDEX IF NOT EXISTS idx_tests_module
  ON tests (module_id);

CREATE INDEX IF NOT EXISTS idx_test_assignments_teacher
  ON test_assignments USING gin (teacher_ids);

CREATE INDEX IF NOT EXISTS idx_test_assignments_student
  ON test_assignments USING gin (student_ids);

CREATE INDEX IF NOT EXISTS idx_test_assignments_class_group
  ON test_assignments USING gin (class_group_ids);
