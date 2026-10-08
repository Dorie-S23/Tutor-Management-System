-- The calendar's added/imported classes now live only in tutor_busy_times
-- (they used to be kept in the browser's localStorage and mirrored here), so
-- the table needs two changes:
--
-- 1. An `exceptions` column for per-day changes to a recurring class — a
--    cancelled occurrence or one edited for a single day. Stored as a JSON
--    array on the class's own row: [{ "date": "YYYY-MM-DD",
--    "type": "cancelled" | "modified", "overrides": { ... } }].
--
-- 2. tutor_id pointed at users instead of tutors. Student volunteers use the
--    same calendar but have no tutors row, so their classes were rejected by
--    the old foreign key. tutors.id is itself users.id, so every existing
--    row still satisfies the new key.
--
-- Run this once in the Supabase SQL editor (project → SQL Editor → New
-- query → Run) before deploying the calendar changes. It's backwards
-- compatible, so the currently deployed site keeps working after it runs.

alter table public.tutor_busy_times
  add column if not exists exceptions jsonb not null default '[]'::jsonb;

alter table public.tutor_busy_times
  drop constraint if exists tutor_busy_times_tutor_id_fkey;

alter table public.tutor_busy_times
  add constraint tutor_busy_times_tutor_id_fkey
  foreign key (tutor_id) references public.users (id) on delete cascade;
