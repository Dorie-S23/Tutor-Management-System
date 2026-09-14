---
sidebar_position: 5.2
---

# Database Schema

## 1. Schema

We designed a relational database using **Supabase**, which is built on PostgreSQL. Supabase Auth also provides the `auth.users` table that anchors every account — each profile table's `id` is a foreign key into it. Below is the database schema for the Tutor Management System:

![Entity-relationship diagram of the Tutor Management System schema, from the Supabase dashboard](/img/supabase-schema.png)

The tables split into four areas: **identity** (`users` plus one profile table per role), **courses and applications** (`courses`, `course_volunteers`, `tutor_subject_preference`, `allocation_overrides`, `session_excusals`), **timetable and time tracking** (`tutor_busy_times`, `hour_entries`, `timesheets`), and **reference data** (`academic_terms`, `notifications`).

### Tables Overview

#### `users`

- One row per registered account. The `role` column decides which profile table the account has and which dashboard it sees.
- **Primary key**: `id`
- **Fields**:
- `id` (uuid, PK, FK → `auth.users.id`)
- `email` (text, required)
- `name` (text, required)
- `role` (text, required) — `student`, `tutor`, `educator` or `organiser`

#### `students`

- Profile row for every account registered with role `student`.
- **Primary key**: `id`
- **Fields**:
- `id` (uuid, PK, FK → `auth.users.id`)
- `name` (text)
- `email` (text)
- `student_no` (text, required at registration)
- `degree` (varchar)

#### `tutors`

- Profile row for every account registered with role `tutor`, plus the pay and workload settings used by allocation and payroll.
- **Primary key**: `id`
- **Fields**:
- `id` (uuid, PK, FK → `auth.users.id`)
- `student_number` (text, required, unique)
- `email` (text)
- `name` (text)
- `academic_level` (text) — `third_year`, `honours`, `masters` or `phd`; drives the bulk-rates endpoint
- `hourly_rate` (numeric, optional)
- `weekly_hour_cap` (numeric, optional)

#### `educators`

- Profile row for every account registered with role `educator`.
- **Primary key**: `id`
- **Fields**:
- `id` (uuid, PK, FK → `auth.users.id`)

#### `organisers`

- Profile row for every account registered with role `organiser`.
- **Primary key**: `id`
- **Fields**:
- `id` (uuid, PK, FK → `auth.users.id`)
- `staff_id` (text) — generated server-side on registration
- `full_name` (text)
- `email` (text)

#### `courses`

- A course that may need tutors, with its tutorial/lab schedule and the mark bar applicants must clear.
- **Primary key**: `id`
- **Fields**:
- `id` (smallint, PK)
- `course_code` (text, required, unique)
- `course_name` (text, required)
- `department` (text, required)
- `min_mark` (integer, required, 0–100)
- `hours_per_week` (smallint, required)
- `tutors_needed` (smallint, required)
- `no_of_tutors_assigned` (smallint, default 0)
- `course_level` (smallint)
- `Day_of_tut` (text, optional)
- `tutor_start_time`, `tutor_end_time` (time, optional)
- `venues` (text, optional) — tutorial rooms, e.g. `"MSL004,005,006"`
- `Day_of_lab` (text, optional)
- `lab_start_time`, `lab_end_time` (time, optional)
- `lab_venues` (text, optional)

#### `course_volunteers`

- A student's volunteering for a course, with the mark they self-reported.
- **Primary key**: `id`
- **Fields**:
- `id` (bigint, PK)
- `user_id` (uuid, FK → `users.id`)
- `course_id` (smallint, FK → `courses.id`)
- `mark` (integer, 0–100)
- `status` (text, default `pending`) — `pending`, `approved` or `rejected`
- `created_at` (timestamptz, default now)

#### `tutor_subject_preference`

- A tutor's application to tutor a course, ranked by the mark they scored for it.
- **Primary key**: `id`
- **Fields**:
- `id` (bigint, PK)
- `tutor_id` (uuid, FK → `tutors.id`)
- `course_id` (smallint, FK → `courses.id`)
- `status` (text, default `pending`) — `pending`, `approved` or `rejected`
- `Tutor_name` (text) — denormalised copy of the tutor's name
- `tutor_mark` (integer) — the mark the tutor scored for the course
- `Availability` (bool) — whether the tutor is free at the course's scheduled times

#### `allocation_overrides`

- Audit log written when an organiser approves an application that broke a rule — the course was already full, or the tutor would exceed their weekly hour cap.
- **Primary key**: `id`
- **Fields**:
- `id` (bigint, PK)
- `organiser_id` (uuid, FK → `users.id`) — the organiser who approved the override
- `tutor_id` (uuid, FK → `tutors.id`)
- `course_id` (smallint, FK → `courses.id`)
- `rule_overridden` (text) — `course_capacity` or `weekly_hour_cap`
- `reason` (text) — free-text justification supplied by the organiser
- `created_at` (timestamptz, default now)

#### `session_excusals`

- A tutor excusing themselves from one scheduled session of a course they are approved for.
- **Primary key**: `id`
- **Fields**:
- `id` (bigint, PK)
- `tutor_id` (uuid, FK → `tutors.id`)
- `course_id` (smallint, FK → `courses.id`)
- `session_date` (date, required)
- `reason` (text, optional)
- `created_at` (timestamptz, default now)

#### `tutor_busy_times`

- Recurring busy blocks from a tutor's imported class timetable, used for clash checks when assigning courses.
- **Primary key**: `id`
- **Fields**:
- `id` (bigint, PK)
- `tutor_id` (uuid, FK → `tutors.id`)
- `title` (text, optional) — e.g. the class name
- `day_of_week` (smallint, 0 = Sunday through 6 = Saturday)
- `start_time`, `end_time` (time)
- `first_date`, `end_date` (date, optional) — the block's active range
- `venue` (text, optional)

#### `hour_entries`

- One row per work session a tutor logs; the raw material that weekly timesheets are built from.
- **Primary key**: `id`
- **Fields**:
- `id` (bigint, PK)
- `user_id` (uuid, FK → `users.id`)
- `date` (date)
- `hours` (numeric)
- `start_time`, `end_time` (time, optional)
- `task_type` (text, default `Tutoring`)
- `subject` (text, default empty)
- `notes` (text, default empty)
- `updated_at` (timestamptz)

#### `timesheets`

- A tutor's weekly submission of logged hours, for organiser sign-off. `entries_snapshot` freezes the hour entries at submission time so later edits can't retroactively change an approved week.
- **Composite primary key**: `(user_id, week_start)`
- **Fields**:
- `user_id` (uuid, FK → `users.id`)
- `week_start` (date) — the Monday of the submitted week
- `status` (text, default `pending`) — `pending`, `approved` or `rejected`
- `total_hours` (numeric)
- `entries_snapshot` (jsonb)
- `reviewed_at` (timestamptz, optional)

#### `academic_terms`

- University terms and recess periods, for term-aware calendar logic. Not yet read or written by the application API — managed directly in Supabase.
- **Primary key**: `id`
- **Fields**:
- `id` (bigint, PK)
- `term_name` (text)
- `start_date`, `end_date` (date)
- `is_recess` (bool)

#### `notifications`

- Per-user notification feed. Not yet read or written by the application API — managed directly in Supabase.
- **Primary key**: `id`
- **Fields**:
- `id` (bigint, PK)
- `user_id` (uuid, FK → `users.id`)
- `type` (text)
- `message` (text)
- `related_entity` (text, optional) — the kind of record the notification points at
- `related_id` (text, optional)
- `read` (bool, default false)
- `created_at` (timestamptz, default now)

## 2. Deployment

The database is a Supabase project: PostgreSQL for storage plus Supabase Auth for account management. The application server connects through `server/supabaseClient.js` (`@supabase/supabase-js`), configured with the `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables.

- **Local development** — the Express server (`npm start`) reads them from `.env`.
- **Production** — the same app is deployed as a Cloudflare Worker (see `wrangler.toml` in the repository root).

Row Level Security is currently disabled on all tables, so the anon key can read and write every table; authorisation is enforced in the route handlers instead of the database.
