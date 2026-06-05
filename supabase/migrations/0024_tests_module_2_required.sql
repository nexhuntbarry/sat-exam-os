-- 0024_tests_module_2_required.sql
--
-- Belt-and-braces defense against the "exam only shows one module"
-- regression. Four non-adaptive tests landed in the database with
-- module_2_id = NULL (likely a pre-validation insert from before
-- /api/admin/tests started enforcing the field). Students opening
-- those tests only saw Module 1, submitted, and the handoff in
-- /api/student/submissions/[id]/submit had nothing to dispatch to.
--
-- All four rows were repaired manually on 2026-06-05. This migration
-- adds a CHECK constraint so a future bypass (direct DB write, a new
-- API path, a UI bug) can never produce the same broken row again.

alter table public.tests
  add constraint tests_module_2_required
  check (is_adaptive = true or module_2_id is not null)
  not valid;

-- Validate after definition so the existing four (now-repaired) rows
-- pass and any future write is rejected at the DB layer.
alter table public.tests
  validate constraint tests_module_2_required;
