-- ============================================================
-- SAT Exam OS — Migration 0018
-- Math-only test aids: Desmos calculator + formula sheet.
--
-- Real digital SAT gives Math takers an embedded Desmos calculator
-- and a one-page reference sheet. We mirror that with two test-level
-- knobs: a boolean to expose the Desmos iframe panel, and a blob URL
-- to a PNG/JPG the admin uploaded as the formula sheet for that test.
--
-- Both fields are inert on Reading & Writing tests — the take-page UI
-- gates on the test's module section.
-- ============================================================

ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS desmos_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS formula_sheet_url TEXT;

COMMENT ON COLUMN tests.desmos_enabled IS
  'When TRUE and the test is a Math test, the take page exposes the Desmos calculator side panel. Ignored for Reading & Writing tests.';

COMMENT ON COLUMN tests.formula_sheet_url IS
  'Optional blob URL of a formula reference sheet (PNG/JPG) the admin uploaded for this Math test. The take page renders it in a side panel. Ignored for Reading & Writing tests.';
