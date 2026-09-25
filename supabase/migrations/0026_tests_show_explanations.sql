-- 0026_tests_show_explanations.sql
--
-- Separate the "show explanations" control from "show answers". Until now
-- tests.show_answers_after_submission gated BOTH the correct answer and
-- the worked explanation on the student result page. Admins want to hand
-- back answers without necessarily handing back the full explanation (or
-- the reverse). This adds an independent flag.
--
-- Default true so existing tests that already show answers keep showing
-- explanations too — behaviour is unchanged until an admin turns it off.
-- The result page only renders explanations when BOTH flags are on.

alter table public.tests
  add column if not exists show_explanations_after_submission boolean not null default true;
