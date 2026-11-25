-- Posting an overflow session (POST /api/course-volunteers with a
-- sessionDate, see postOverflowSession in server/routes/courseVolunteers.js)
-- inserts a row with status 'open' — the "unclaimed, browsable" state a
-- session sits in until a student claims it. The live course_volunteers_
-- status_check constraint on this table predates that status and doesn't
-- allow it, so every "Post overflow session" fails with:
--   new row for relation "course_volunteers" violates check constraint
--   "course_volunteers_status_check"
--
-- The four values the app actually uses (see VALID_STATUSES and the direct
-- status: "open"/"pending" assignments in courseVolunteers.js) are open,
-- pending, approved and rejected. This drops whatever the constraint
-- currently allows and recreates it with exactly that set.
--
-- Run this once in the Supabase SQL editor (project → SQL Editor → New
-- query → Run).

alter table public.course_volunteers
  drop constraint if exists course_volunteers_status_check;

alter table public.course_volunteers
  add constraint course_volunteers_status_check
  check (status in ('open', 'pending', 'approved', 'rejected'));
