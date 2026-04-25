-- Phase 1B+ — Two-step upload UX: add 'uploaded' and 'rejected_not_sat' to modules.parsing_status
--
-- Old values: pending | parsing | parsed | failed | approved
-- New values: uploaded | parsing | rejected_not_sat | parsed | failed | approved
--
-- 'pending' is kept in the constraint for backward compatibility with rows
-- created before this migration; the UI treats it as 'uploaded'.

ALTER TABLE modules
  DROP CONSTRAINT IF EXISTS modules_parsing_status_check;

ALTER TABLE modules
  ADD CONSTRAINT modules_parsing_status_check
  CHECK (parsing_status IN (
    'pending',           -- legacy alias of 'uploaded'
    'uploaded',          -- new default after upload, awaiting AI parse
    'parsing',
    'rejected_not_sat',  -- AI classifier rejected the PDF as non-SAT content
    'parsed',
    'failed',
    'approved'
  ));

-- Default for new rows now reflects the two-step flow.
ALTER TABLE modules
  ALTER COLUMN parsing_status SET DEFAULT 'uploaded';
