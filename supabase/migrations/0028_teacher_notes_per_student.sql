-- 0028_teacher_notes_per_student.sql
--
-- Private notes on a question were keyed only by (test, teacher, question),
-- so a note written while viewing one student's submission showed up on
-- every student's submission for that question (QA finding M-07).
--
-- Adds an optional student_id. Private notes are saved per student;
-- class-review marks and observations keep student_id = NULL and stay
-- shared. NULLS NOT DISTINCT keeps "one shared row" semantics for NULL.

alter table public.test_teacher_notes
  add column if not exists student_id uuid references public.users(id) on delete cascade;

do $$
declare c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.test_teacher_notes'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (test_id, teacher_id, question_id, note_type)';
  if c is not null then
    execute format('alter table public.test_teacher_notes drop constraint %I', c);
  end if;
end $$;

alter table public.test_teacher_notes
  add constraint test_teacher_notes_unique_per_student
  unique nulls not distinct (test_id, teacher_id, question_id, note_type, student_id);
