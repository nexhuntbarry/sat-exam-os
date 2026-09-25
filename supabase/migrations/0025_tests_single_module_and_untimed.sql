-- 0025_tests_single_module_and_untimed.sql
--
-- Two admin-facing test options:
--
-- 1. Single-module tests. Migration 0024 added a CHECK constraint
--    forcing every non-adaptive test to have module_2_id (a belt-and-
--    braces guard against an accidental one-module regression). Admins
--    now want single-module tests ON PURPOSE (assign one module or a
--    short quiz), so we drop that constraint. The runtime path already
--    supports it: the start endpoint creates a plain no-session
--    submission when module_2_id is null, and submit skips the Module 2
--    handoff when adaptive_track is null.
--
-- 2. Untimed tests. `is_untimed = true` tells the take page to render a
--    "No time limit" pill instead of a countdown and to never
--    auto-submit. Existing tests default to false (timed) so behaviour
--    is unchanged.

alter table public.tests
  drop constraint if exists tests_module_2_required;

alter table public.tests
  add column if not exists is_untimed boolean not null default false;
