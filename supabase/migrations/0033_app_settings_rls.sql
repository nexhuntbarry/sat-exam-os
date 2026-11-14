-- app_settings now also stores the review queue index (review_queue_index:*,
-- app/(admin)/admin/review-queue/data.ts). Only the service role reads or
-- writes it: make sure row level security is on (it already is in prod, so
-- this is a no-op there).
alter table app_settings enable row level security;
