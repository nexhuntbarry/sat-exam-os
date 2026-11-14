alter table tests add column if not exists publish_at timestamptz;
alter table tests add column if not exists publish_at_error text;
create index if not exists idx_tests_publish_at on tests (publish_at) where publish_at is not null and status = 'Draft';

-- A schedule only lives while the test is a Draft: any status change away
-- from Draft (publish, close, a full-length section following its parent)
-- drops it, so a test moved back to Draft never republishes from a stale time.
create or replace function tests_clear_publish_at() returns trigger
language plpgsql as $$
begin
  new.publish_at := null;
  new.publish_at_error := null;
  return new;
end;
$$;

drop trigger if exists trg_tests_clear_publish_at on tests;
create trigger trg_tests_clear_publish_at
  before update of status on tests
  for each row
  when (new.status <> 'Draft')
  execute function tests_clear_publish_at();
