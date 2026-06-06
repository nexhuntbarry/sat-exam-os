-- 0025_questions_unique_question_number.sql
--
-- Hard floor for the "duplicate question number" class of bug. The
-- parser occasionally emits two rows for the same SAT question in
-- one module (e.g. Q22 of September 2025 SAT Math Module 2 landed
-- as both a Multiple Choice row and a Student Produced Response
-- row with completely different stem text and a letter answer).
--
-- The bad twin was deleted manually on 2026-06-06 and the
-- dedupeDuplicateQuestionNumbers step now runs at the tail of every
-- parse to clean up future duplicates by quality-score. This
-- migration adds the DB UNIQUE constraint so even if the cleanup
-- step is bypassed (admin script, direct insert, new API path),
-- the database refuses to store a second row with the same
-- (module_id, original_question_number).
--
-- Rows with NULL question_number are not constrained — the column
-- is nullable per migration 0001 and a handful of legacy rows
-- legitimately carry NULL.

alter table public.questions
  add constraint questions_module_question_number_unique
  unique (module_id, original_question_number);
