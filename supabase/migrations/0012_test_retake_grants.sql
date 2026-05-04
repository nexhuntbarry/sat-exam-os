-- ============================================================
-- SAT Exam OS — Migration 0012
-- Per-student retake grants. Lets a teacher (or admin) unlock a single
-- additional attempt for a specific student even when the test's
-- allow_retake flag is off, and records who granted it + when it gets
-- consumed.
-- ============================================================

CREATE TABLE IF NOT EXISTS test_retake_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  notes TEXT
);

-- One pending (unconsumed) grant per (test, student) is enough; let
-- there be many historical (consumed) rows so we can audit retake
-- history. The partial unique index enforces only the pending case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_test_retake_grants_pending
  ON test_retake_grants (test_id, student_id)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_test_retake_grants_test_student
  ON test_retake_grants (test_id, student_id);

COMMENT ON TABLE test_retake_grants IS
  'Per-student retake unlocks. A row with consumed_at IS NULL means the student is allowed exactly one new attempt on this test; submission start consumes the grant.';
