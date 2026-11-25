-- Session attendance verification. Organisers now confirm that a tutor or
-- volunteer actually attended each session they logged, so every
-- hour_entries row carries a verification state:
--
--   pending   freshly logged — waiting in the organiser's queue
--   verified  the organiser confirmed the person attended
--   flagged   the organiser disputes the entry (note required)
--
-- verified_by / verified_at record who made the call and when;
-- verification_note holds the organiser's explanation when flagging.
-- A structural edit by the owner (different session/date/time) resets the
-- row to pending, since the verified facts no longer describe it.

alter table public.hour_entries
  add column if not exists verification_status text not null default 'pending',
  add column if not exists verified_by uuid references public.users (id),
  add column if not exists verified_at timestamptz,
  add column if not exists verification_note text;

-- Same shape as the other status checks in this schema (see
-- 2026-10-08-course-volunteers-status-check.sql): drop the constraint name
-- this migration owns, then recreate it, so re-running is safe.
alter table public.hour_entries
  drop constraint if exists hour_entries_verification_status_check;

alter table public.hour_entries
  add constraint hour_entries_verification_status_check
  check (verification_status in ('pending', 'verified', 'flagged'));

-- Run this once in the Supabase SQL editor (project → SQL Editor → New
-- query → Run). Existing rows backfill to 'pending', so hours logged before
-- the feature shipped join the verification queue too.
