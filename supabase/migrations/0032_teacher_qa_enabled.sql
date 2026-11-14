-- 0032_teacher_qa_enabled.sql
--
-- Per-test admin switch "Teachers can view & print questions/answers".
-- When false, teachers can't open the Questions & answers (Class Review)
-- page or print the test (/print/tests/<id>); they still see results and
-- scores. Admins are never blocked. On a full-length SAT the parent's value
-- governs both sections. Separate from review_unlocked (the students'
-- class-review lock). Read/written only through lib/teacher-qa.ts, which
-- treats a missing column as true until this runs.
alter table tests add column if not exists teacher_qa_enabled boolean not null default true;
