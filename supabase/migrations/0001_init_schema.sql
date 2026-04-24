-- SAT Exam OS — Phase 1 Schema
-- RLS is NOT enabled; server uses service_role.

-- ────────────────────────────────────────────
-- EXTENSIONS
-- ────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ────────────────────────────────────────────
-- USERS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id    text UNIQUE,
  email            text UNIQUE NOT NULL,
  display_name     text,
  role             text NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  account_status   text NOT NULL DEFAULT 'pending' CHECK (account_status IN ('pending', 'approved', 'suspended')),
  metadata         jsonb NOT NULL DEFAULT '{}',
  org_id           uuid,
  onboarded_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- STUDENT PROFILES
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  grade          text,
  school         text,
  campus         text,
  class_group    text,
  parent_name    text,
  parent_email   text,
  parent_phone   text,
  target_score   int,
  current_level  text,
  notes          text,
  org_id         uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- TEACHER PROFILES
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teacher_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  assigned_classes  jsonb NOT NULL DEFAULT '[]',
  bio               text,
  specialty         text,
  org_id            uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- CLASS GROUPS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS class_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  campus      text,
  grade       text,
  created_by  uuid REFERENCES users(id),
  org_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- CLASS GROUP MEMBERS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS class_group_members (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_group_id   uuid NOT NULL REFERENCES class_groups(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_group_id, student_id)
);

-- ────────────────────────────────────────────
-- MODULES
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_name      text NOT NULL,
  section          text NOT NULL CHECK (section IN ('Math', 'Reading & Writing')),
  module_number    int CHECK (module_number IN (1, 2)),
  difficulty       text CHECK (difficulty IN ('Easy', 'Medium', 'Hard', 'Mixed')),
  source_name      text,
  version          text,
  pdf_url          text NOT NULL,
  pdf_size_bytes   int,
  total_questions  int NOT NULL DEFAULT 0,
  parsing_status   text NOT NULL DEFAULT 'pending' CHECK (parsing_status IN ('pending', 'parsing', 'parsed', 'failed', 'approved')),
  uploaded_by      uuid REFERENCES users(id),
  org_id           uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- QUESTIONS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id               uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  section                 text NOT NULL,
  original_question_number int,
  question_text           text NOT NULL,
  choices                 jsonb NOT NULL DEFAULT '[]',
  correct_answer          text,
  explanation             text,
  difficulty              text CHECK (difficulty IN ('Easy', 'Medium', 'Hard')),
  domain                  text,
  skill                   text,
  concept                 text,
  question_type           text CHECK (question_type IN ('Multiple Choice', 'Student Produced Response')),
  has_image               boolean NOT NULL DEFAULT false,
  image_url               text,
  has_table               boolean NOT NULL DEFAULT false,
  has_formula             boolean NOT NULL DEFAULT false,
  source_pdf_url          text,
  page_number             int,
  parsing_status          text NOT NULL DEFAULT 'Draft' CHECK (parsing_status IN ('Draft', 'Approved', 'Needs Review', 'Rejected')),
  ai_confidence_score     real,
  reviewed_by             uuid REFERENCES users(id),
  reviewed_at             timestamptz,
  org_id                  uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- TESTS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_name                     text NOT NULL,
  module_id                     uuid NOT NULL REFERENCES modules(id),
  time_limit_minutes            int,
  open_date                     timestamptz,
  due_date                      timestamptz,
  show_answers_after_submission boolean NOT NULL DEFAULT false,
  allow_retake                  boolean NOT NULL DEFAULT false,
  status                        text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published', 'Closed')),
  created_by                    uuid REFERENCES users(id),
  org_id                        uuid,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- TEST ASSIGNMENTS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id          uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  teacher_ids      jsonb NOT NULL DEFAULT '[]',
  student_ids      jsonb NOT NULL DEFAULT '[]',
  class_group_ids  jsonb NOT NULL DEFAULT '[]',
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- SUBMISSIONS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id             uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers             jsonb NOT NULL DEFAULT '{}',
  score               numeric,
  correct_count       int NOT NULL DEFAULT 0,
  total_questions     int NOT NULL DEFAULT 0,
  percentage          numeric,
  started_at          timestamptz NOT NULL DEFAULT now(),
  submitted_at        timestamptz,
  time_spent_seconds  int,
  status              text NOT NULL DEFAULT 'In Progress' CHECK (status IN ('In Progress', 'Submitted', 'Late', 'Expired')),
  attempt_number      int NOT NULL DEFAULT 1,
  org_id              uuid,
  UNIQUE (test_id, student_id, attempt_number)
);

-- ────────────────────────────────────────────
-- ANSWER RECORDS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS answer_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id       uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id         uuid NOT NULL REFERENCES questions(id),
  student_answer      text,
  correct_answer      text,
  is_correct          boolean,
  time_spent_seconds  int,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- NOTIFICATIONS
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  payload     jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- INDEXES
-- ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_questions_module_status    ON questions (module_id, parsing_status);
CREATE INDEX IF NOT EXISTS idx_questions_domain_skill     ON questions (domain, skill, difficulty);
CREATE INDEX IF NOT EXISTS idx_submissions_student_test   ON submissions (student_id, test_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status         ON submissions (status);
CREATE INDEX IF NOT EXISTS idx_answer_records_submission  ON answer_records (submission_id);
CREATE INDEX IF NOT EXISTS idx_test_assignments_test      ON test_assignments (test_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user         ON notifications (user_id, read_at);
