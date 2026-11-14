alter table tests add column if not exists publish_at timestamptz;
alter table tests add column if not exists publish_at_error text;
create index if not exists idx_tests_publish_at on tests (publish_at) where publish_at is not null and status = 'Draft';
