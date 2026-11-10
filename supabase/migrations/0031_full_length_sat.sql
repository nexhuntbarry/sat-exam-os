-- 0031_full_length_sat.sql
--
-- Full-length SAT (R&W → break → Math, one 400–1600 result), Phase 0
-- groundwork. Plan: .omc/plans/full-length-sat.md (rev 2), section 3.
--
-- Additive only. Every existing test keeps test_kind = 'section' and NULL
-- in the other new columns, so nothing about today's single-section tests
-- changes. No change to `submissions`.
--
-- Shape:
--   - A full-length test is a `tests` row of kind 'full_length' (the
--     parent: assignments, dates, answer settings, retake grants live here).
--   - It owns two hidden 'fl_section' children (section_order 1 = R&W,
--     2 = Math), snapshotted from source section tests. Submissions belong
--     to the children, so the per-section runtime (handoff, cron, grading)
--     runs unchanged.
--   - full_length_attempts links one attempt's R&W and Math sessions.
--   - test_time_accommodations holds per-student extended time.
--
-- DEPLOY ORDER: apply this BEFORE deploying the Phase 0 code, then verify
--   select test_kind, parent_test_id from public.tests limit 1;
--   \d public.full_length_attempts
--
-- Rollback (only after the Phase 0 code has been rolled back):
--   drop trigger if exists trg_sync_fl_children on public.tests;
--   drop function if exists public.sync_fl_children();
--   drop trigger if exists trg_check_fl_parent on public.tests;
--   drop function if exists public.check_fl_parent();
--   drop table if exists public.test_time_accommodations;
--   drop table if exists public.full_length_attempts;
--   alter table public.tests drop constraint if exists tests_fl_shape;
--   drop index if exists public.uniq_tests_parent_section;
--   alter table public.tests
--     drop column if exists allow_section_pause, drop column if exists break_minutes,
--     drop column if exists source_test_id, drop column if exists section_order,
--     drop column if exists parent_test_id, drop column if exists test_kind;

-- Don't queue behind long transactions on the live `tests` table (every
-- exam start reads it): give up after 3 s instead, and re-run later.
set local lock_timeout = '3s';  -- run the whole file as one transaction (SQL editor does)

-- ---------------------------------------------------------------- tests
alter table public.tests
  add column if not exists test_kind text not null default 'section'
    check (test_kind in ('section', 'full_length', 'fl_section')),
  add column if not exists parent_test_id uuid references public.tests(id) on delete cascade,
  add column if not exists section_order smallint check (section_order in (1, 2)),   -- 1 = R&W, 2 = Math
  add column if not exists source_test_id uuid references public.tests(id) on delete set null,
  add column if not exists break_minutes integer check (break_minutes between 0 and 60),
  add column if not exists allow_section_pause boolean not null default false;

comment on column public.tests.test_kind is
  'section = ordinary one-section test; full_length = parent of a full-length SAT; fl_section = hidden child section of a full_length parent.';
comment on column public.tests.parent_test_id is
  'fl_section only: the full_length parent. Children never appear in lists; access, assignments and settings resolve through the parent.';
comment on column public.tests.section_order is 'fl_section only: 1 = Reading and Writing, 2 = Math.';
comment on column public.tests.source_test_id is 'fl_section only: section test it was snapshotted from (display only).';
comment on column public.tests.break_minutes is 'full_length only: break between the sections, in minutes.';
comment on column public.tests.allow_section_pause is 'full_length only: students may leave during the break and continue later.';

-- Shape rule. Added NOT VALID, then validated. Run as one transaction the
-- ALTER above already holds the table lock until commit; the tests table is
-- small, so this is quick. Every existing row is ('section', NULL, NULL,
-- NULL) and passes.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tests_fl_shape' and conrelid = 'public.tests'::regclass) then
    alter table public.tests add constraint tests_fl_shape check (
      (test_kind = 'fl_section') = (parent_test_id is not null)
      and (test_kind <> 'fl_section' or section_order is not null)
      and (test_kind <> 'full_length' or break_minutes is not null)
    ) not valid;
  end if;
end $$;
alter table public.tests validate constraint tests_fl_shape;

create unique index if not exists uniq_tests_parent_section
  on public.tests (parent_test_id, section_order) where parent_test_id is not null;

-- ------------------------------------------------- full_length_attempts
create table if not exists public.full_length_attempts (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,      -- the full_length parent
  student_id uuid not null references public.users(id) on delete cascade,
  attempt_number integer not null,
  rw_session_id uuid not null,
  math_session_id uuid,                     -- copied from the Math Module 1 row once it exists
  time_multiplier numeric(3,2) not null default 1.00
    check (time_multiplier in (1.00, 1.25, 1.50, 2.00)),
  break_minutes integer not null,           -- snapshot at start
  allow_section_pause boolean not null,     -- snapshot at start
  started_at timestamptz not null default now(),
  closed_at timestamptz,                    -- attempt can no longer continue
  -- math_not_started: on the break past the Math start window (cron);
  -- abandoned: stuck past the due date where nothing can move it (a failed
  -- Module 2 handoff past its 24 h window, or no R&W Module 1) (cron);
  -- admin_closed: closed by an admin.
  closed_reason text check (closed_reason in ('math_not_started', 'abandoned', 'admin_closed')),
  unique (test_id, student_id, attempt_number)
);
create index if not exists idx_fla_student on public.full_length_attempts (student_id);
create unique index if not exists uniq_fla_rw_session on public.full_length_attempts (rw_session_id);
create unique index if not exists uniq_fla_math_session on public.full_length_attempts (math_session_id)
  where math_session_id is not null;

comment on table public.full_length_attempts is
  'One full-length SAT attempt: links the R&W session and the Math session (submissions on the two fl_section children).';

-- --------------------------------------------- test_time_accommodations
create table if not exists public.test_time_accommodations (
  test_id uuid not null references public.tests(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  time_multiplier numeric(3,2) not null check (time_multiplier in (1.25, 1.50, 2.00)),
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (test_id, student_id)
);

comment on table public.test_time_accommodations is
  'Per-student extended time on one (full-length) test. Snapshotted onto full_length_attempts at start.';

-- Service role only, like 0029: RLS on, no policies.
alter table public.full_length_attempts enable row level security;
alter table public.test_time_accommodations enable row level security;

-- --------------------------------------------- child → parent integrity
-- An fl_section row's parent must be a full_length test (so children can't
-- nest, and a section test can't become someone's parent by accident).
create or replace function public.check_fl_parent() returns trigger language plpgsql as $$
begin
  if new.parent_test_id is not null and not exists (
    select 1 from public.tests p where p.id = new.parent_test_id and p.test_kind = 'full_length'
  ) then
    raise exception 'tests.parent_test_id % must reference a full_length test', new.parent_test_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_check_fl_parent on public.tests;
create trigger trg_check_fl_parent before insert or update of parent_test_id, test_kind on public.tests
  for each row when (new.parent_test_id is not null) execute function public.check_fl_parent();

-- -------------------------------------------------- parent → children sync
-- Children follow the parent's status, dates and answer settings, so every
-- per-test rule evaluated on a child (Published, due date, ...) matches
-- the parent. Children are never full_length, so this can't recurse.
create or replace function public.sync_fl_children() returns trigger language plpgsql as $$
begin
  update public.tests c set
    status = new.status,
    open_date = new.open_date,
    due_date = new.due_date,
    allow_retake = new.allow_retake,
    show_answers_after_submission = new.show_answers_after_submission,
    show_explanations_after_submission = new.show_explanations_after_submission,
    review_unlocked = new.review_unlocked
  where c.parent_test_id = new.id;
  return new;
end $$;

drop trigger if exists trg_sync_fl_children on public.tests;
create trigger trg_sync_fl_children after update on public.tests
  for each row when (new.test_kind = 'full_length') execute function public.sync_fl_children();
