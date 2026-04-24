-- Phase 1B — AI parsing metadata + question bank enhancements

-- ────────────────────────────────────────────
-- MODULES: parsing metadata columns
-- ────────────────────────────────────────────
ALTER TABLE modules
  ADD COLUMN IF NOT EXISTS parsing_started_at    timestamptz,
  ADD COLUMN IF NOT EXISTS parsing_completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS parsing_error         text,
  ADD COLUMN IF NOT EXISTS parsing_model         text;

-- ────────────────────────────────────────────
-- QUESTIONS: extra parsing columns
-- ────────────────────────────────────────────
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS parsing_notes          text,
  ADD COLUMN IF NOT EXISTS question_text_embedding jsonb;

-- ────────────────────────────────────────────
-- AI USAGE LOG
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid,
  route          text NOT NULL,
  tokens_input   int NOT NULL DEFAULT 0,
  tokens_output  int NOT NULL DEFAULT 0,
  model          text NOT NULL,
  cost_cents     int NOT NULL DEFAULT 0,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────
-- INDEXES for Phase 1B
-- ────────────────────────────────────────────

-- Compound index for question bank filters
CREATE INDEX IF NOT EXISTS idx_questions_section_domain_skill_diff
  ON questions (section, domain, skill, difficulty);

-- Compound index for status + module (fast review queue)
CREATE INDEX IF NOT EXISTS idx_questions_parsing_status_module
  ON questions (parsing_status, module_id);

-- GIN full-text index on question_text
CREATE INDEX IF NOT EXISTS idx_questions_fts
  ON questions USING GIN (to_tsvector('english', question_text));

-- GIN full-text index on explanation (nullable — guard with coalesce)
CREATE INDEX IF NOT EXISTS idx_questions_explanation_fts
  ON questions USING GIN (to_tsvector('english', coalesce(explanation, '')));

-- Index for ai_usage_log date queries
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created
  ON ai_usage_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_route
  ON ai_usage_log (route, created_at DESC);
