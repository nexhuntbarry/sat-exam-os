-- 0026_bug_reports.sql
--
-- Admin-facing "Report bug to dev" workflow. The reviewer hits a
-- button on a question's review page, picks an optional note, and
-- a row lands here. A best-effort Telegram ping goes to the dev
-- chat if TELEGRAM_BOT_TOKEN + TELEGRAM_DEV_CHAT_ID are set in env.
--
-- We intentionally keep this server-side only; the table is not
-- exposed to students or teachers. RLS stays disabled (every read
-- goes through service role).

create table if not exists public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  module_id uuid not null references public.modules(id) on delete cascade,
  reporter_user_id uuid references public.users(id) on delete set null,
  note text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id) on delete set null
);

create index if not exists bug_reports_question_id_idx on public.bug_reports(question_id);
create index if not exists bug_reports_status_idx on public.bug_reports(status);
create index if not exists bug_reports_created_at_idx on public.bug_reports(created_at desc);
