-- At most one Module 2 row per two-module / adaptive session.
--
-- uniq_submissions_attempt_adaptive (0017) already stops two rows of the
-- SAME track, but two concurrent Module 1 → Module 2 handoffs that picked
-- different tracks (module_2_easy vs module_2_hard) could both insert.
-- lib/module2-handoff.ts checks + adopts the existing row and catches
-- 23505 from this index; it also removes a duplicate it created, so this
-- index makes that guarantee airtight rather than best-effort.
--
-- Safe on current data: no session has more than one Module 2 row
-- (checked 2026-11-07).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_submissions_session_module_2
  ON submissions (session_id)
  WHERE session_id IS NOT NULL
    AND adaptive_track IN ('module_2', 'module_2_easy', 'module_2_hard');
