-- Profile pages for tutors and student volunteers need one field that
-- doesn't exist on `users` yet: a cell phone number. Student numbers are NOT
-- duplicated here — they already live on the role profile tables
-- (tutors.student_number / students.student_no), where the rest of the app
-- reads them from.
--
-- There is deliberately no surname column: accounts (and the profile page)
-- capture the person's full name in the single `users.name` field.
--
-- Run this once in the Supabase SQL editor (project → SQL Editor → New
-- query → Run) before deploying the /api/profile routes. Until then those
-- routes fail with "column users.cell_phone does not exist".

alter table public.users add column if not exists cell_phone text;
