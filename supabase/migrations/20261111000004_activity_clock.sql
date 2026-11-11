-- Rows logged within one save get distinct, ordered timestamps.
alter table public.activity alter column created_at set default clock_timestamp();
