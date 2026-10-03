-- 0027_class_group_teachers_subject.sql
--
-- Subject scoping for class-group teachers. A teacher attached to a class
-- group can now be limited to one subject so, e.g., the Math teacher of a
-- class sees only that class's Math tests (results, review, analytics) and
-- the English teacher sees only the Reading & Writing tests.
--
-- NULL = both subjects (unchanged behaviour — sees everything their class
-- took). Values match modules.section so a test's subject can be compared
-- directly: 'Math' or 'Reading & Writing'.

alter table public.class_group_teachers
  add column if not exists subject text
  check (subject is null or subject in ('Math', 'Reading & Writing'));
