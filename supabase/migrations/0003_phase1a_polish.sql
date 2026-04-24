-- Phase 1A polish migration

-- Add status_reason to student_profiles (for suspension notes)
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS status_reason text;

-- Add invited_by to teacher_profiles
ALTER TABLE teacher_profiles ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id);

-- Indexes for admin queue queries
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users (role, account_status);

-- Index for class_group_members student lookups
CREATE INDEX IF NOT EXISTS idx_class_group_members_student ON class_group_members (student_id);
