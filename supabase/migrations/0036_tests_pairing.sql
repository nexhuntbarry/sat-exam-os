-- 0036_tests_pairing.sql
--
-- Admin override of which R&W test and which Math test make one set (one
-- R&W + Math total) on the student reports, charts and class Scores grid
-- (ticket f7276162, lib/test-pairing.ts):
--   NULL                    automatic (same set name, else same New York day)
--   {"test_id": "<uuid>"}   paired with that test (kept symmetric by the API)
--   {"test_id": null}       explicitly no pair
-- Display only: no score is stored or changed. Read/written only through
-- lib/test-pairing.ts, which treats a missing column as "automatic
-- everywhere" until this runs (the admin "Paired with" control answers
-- 503 "database update pending").
--
-- Rollback: alter table public.tests drop column if exists pairing;

set local lock_timeout = '3s';

alter table public.tests
  add column if not exists pairing jsonb;

comment on column public.tests.pairing is
  'Section test only: admin set-pairing override. NULL = automatic; {"test_id": "<uuid>"} = paired with that test (symmetric); {"test_id": null} = explicitly no pair. Display only.';
