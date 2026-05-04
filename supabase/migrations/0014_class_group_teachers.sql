-- ============================================================
-- SAT Exam OS — Migration 0014
-- Many-to-many teacher ↔ class_group assignment.
--
-- Lets a class be assigned to one or more teachers (typical: 1-2 main
-- + 1 reviewer-teacher) and lets a teacher be assigned to many classes
-- so a "My Students" view filtered by class can be built.
--
-- For 1-on-1 tutoring, the existing pattern still works: create a
-- class_group with one student in class_group_members, and assign one
-- teacher to it here.
-- ============================================================

CREATE TABLE IF NOT EXISTS class_group_teachers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_group_id  UUID NOT NULL REFERENCES class_groups(id) ON DELETE CASCADE,
  teacher_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (class_group_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS idx_class_group_teachers_teacher
  ON class_group_teachers (teacher_id);

CREATE INDEX IF NOT EXISTS idx_class_group_teachers_class
  ON class_group_teachers (class_group_id);

COMMENT ON TABLE class_group_teachers IS
  'Many-to-many teacher assignment to class groups. Different from test_assignments.teacher_ids — that is per-test, this is per-class persistence so a teacher can see all their students cross-test.';
