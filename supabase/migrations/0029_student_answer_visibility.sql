-- 0029_student_answer_visibility.sql
--
-- Per-student answer visibility override. Until now answer/explanation
-- visibility was set only per test (show_answers_after_submission,
-- show_explanations_after_submission) plus the class-review unlock
-- (review_unlocked). Admins (and the test's owning teacher) can now pin a
-- single student to:
--   follow — use the test setting / class review lock (same as no row)
--   show   — show answers to this student after they submit
--   hide   — never show answers to this student, even in class review
--
-- The decision itself lives in lib/answer-visibility.ts and is enforced
-- server-side. A student who hasn't submitted, or who has a retake
-- pending / in progress, never sees answers regardless of this row.
--
-- Server-side only (service role), like test_retake_grants: RLS stays off.

create table if not exists public.student_answer_visibility (
  test_id uuid not null references public.tests(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  mode text not null default 'follow' check (mode in ('follow', 'show', 'hide')),
  show_explanations boolean not null default true,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (test_id, student_id)
);

create index if not exists idx_student_answer_visibility_student
  on public.student_answer_visibility (student_id);

comment on table public.student_answer_visibility is
  'Per-student override of answer/explanation visibility for one test. mode=follow defers to the test settings and class review lock; show/hide override both.';

-- Audit trail: one row per change, like test_retake_grants keeps history.
create table if not exists public.student_answer_visibility_log (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  mode text not null check (mode in ('follow', 'show', 'hide')),
  show_explanations boolean not null,
  changed_by uuid references public.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists idx_student_answer_visibility_log_test_student
  on public.student_answer_visibility_log (test_id, student_id, changed_at desc);
