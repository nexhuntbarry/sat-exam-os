-- 0035_custom_tests.sql — Custom test (rule-based selection), Premier ticket
-- 83813956, plan .omc/plans/custom-test.md. Additive and idempotent: every
-- existing row keeps NULL, so nothing about today's tests changes.
--
-- What it adds:
--   tests.custom_rules     the saved rules of a Custom test (on the test you
--                          assign: the section test, or the full-length parent)
--   modules.owner_test_id  a Custom test's placeholder ("stage") modules point
--                          at the test that owns them; deleting the test
--                          deletes them (cascade)
--   a trigger that keeps questions out of stage modules
--
-- Where the per-module question lists live: tests.question_ids (existing
-- column). A Custom test's list is each stage module id followed by that
-- module's questions (lib/custom-test/stage). Stage module ids start with
-- c0570000-5ca6-4, so no exam path needs a new column.
--
-- DEPLOY ORDER: the code is safe before this runs (the Custom test builder
-- says "not enabled yet" and nothing else reads these columns). Run it in
-- the Supabase SQL editor, then the builder turns on by itself.
-- Verify:
--   select custom_rules from public.tests limit 1;
--   select owner_test_id from public.modules limit 1;
-- Rollback (delete any Custom tests first):
--   drop trigger if exists trg_check_question_not_stage on public.questions;
--   drop function if exists public.check_question_not_stage();
--   drop index if exists public.idx_modules_owner_test;
--   alter table public.modules drop column if exists owner_test_id;
--   alter table public.tests drop column if exists custom_rules;

set local lock_timeout = '3s';

alter table public.tests
  add column if not exists custom_rules jsonb;

comment on column public.tests.custom_rules is
  'Custom test only, on the assignable test (section test or full_length parent): generator rules (subject, parts, counts per skill, difficulty mixes, adaptive, threshold, break, seed, family_id, version, accepted shortfalls). NULL for every other test.';

alter table public.modules
  add column if not exists owner_test_id uuid references public.tests(id) on delete cascade;

comment on column public.modules.owner_test_id is
  'Custom test stage module only: the test (section test or fl_section child) whose question_ids list its questions. Owns no questions, no PDF; hidden from every module list. NULL for uploaded modules.';

create index if not exists idx_modules_owner_test
  on public.modules (owner_test_id) where owner_test_id is not null;

-- A stage module never owns questions (bank questions are referenced, not
-- copied, so a key fix reaches the Custom test).
create or replace function public.check_question_not_stage() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.modules m where m.id = new.module_id and m.owner_test_id is not null) then
    raise exception 'questions cannot belong to Custom test stage module %', new.module_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_check_question_not_stage on public.questions;
create trigger trg_check_question_not_stage before insert or update of module_id on public.questions
  for each row execute function public.check_question_not_stage();
