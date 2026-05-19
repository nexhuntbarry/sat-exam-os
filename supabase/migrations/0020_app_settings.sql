-- ============================================================
-- SAT Exam OS — Migration 0020
-- Global app settings (single-row key/value store).
--
-- The first user is the formula reference sheet for Math tests: admin
-- uploads it once and every Math take page picks it up. Per-test
-- formula uploads were removed in favor of this global default since
-- the sheet is essentially boilerplate and admins didn't want to
-- re-upload on every test.
--
-- Keep this table tiny and read-mostly. New settings get a new key.
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE app_settings IS
  'Global, low-cardinality config the admin manages from /admin/settings. One row per setting. Value shape varies by key.';

COMMENT ON COLUMN app_settings.key IS
  'Stable string identifier. Examples: math_formula_sheet (value.url=text).';
