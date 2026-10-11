const crypto = require("crypto");
const express = require("express");
const supabase = require("../supabaseClient");
const { DAY_NAMES } = require("../dayNames");
const { getRatesMap } = require("./academicLevelRates");
const { courseScopeForOrganiser } = require("./organiserScope");

const router = express.Router();

// "HH:MM" or "HH:MM:SS" -> minutes since midnight, for interval-overlap comparisons.
function toMinutes(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// Resolves the ?organiserId= scope shared by the list and workload views —
// the same contract as the attendance queue. undefined means the caller
// isn't an organiser at all (a 403), null means they see everything (the
// super-organiser, or a grandfathered organiser with no request rows), and
// an array holds the only course ids they may look at. Without an
// organiserId the view isn't scoped, matching the rest of this API's
// trust model.
async function scopeFor(req) {
  const { organiserId } = req.query;
  if (!organiserId) return null;
  return courseScopeForOrganiser(organiserId);
}

// GET /api/tutors?organiserId=... — list tutors, rates stitched on. A
// course-scoped organiser only gets tutors assigned (approved) to their
// courses — someone they could never have allocated has no business on
// this page.
router.get("/", async (req, res) => {
  const scopeCourseIds = await scopeFor(req);
  if (scopeCourseIds === undefined) {
    return res.status(403).json({ error: "Only organisers can list tutors" });
  }
  if (Array.isArray(scopeCourseIds) && scopeCourseIds.length === 0) {
    return res.json([]);
  }

  const { data, error } = await supabase
    .from("tutors")
    .select("*")
    .order("name");

  if (error) return res.status(500).json({ error: error.message });

  let tutors = data || [];
  if (Array.isArray(scopeCourseIds)) {
    const { data: assignments, error: assignError } = await supabase
      .from("tutor_subject_preference")
      .select("tutor_id")
      .eq("status", "approved")
      .in("course_id", scopeCourseIds);
    if (assignError) {
      return res.status(500).json({ error: assignError.message });
    }

    const inScope = new Set((assignments || []).map((a) => a.tutor_id));
    tutors = tutors.filter((t) => inScope.has(t.id));
  }

  const { ratesMap, error: ratesError } = await getRatesMap();
  if (ratesError) return res.status(500).json({ error: ratesError.message });

  res.json(
    tutors.map((t) => ({
      ...t,
      hourly_rate:
        t.academic_level != null ? (ratesMap[t.academic_level] ?? null) : null,
    })),
  );
});

// GET /api/tutors/workload — every tutor's assigned hours (summed from their
// approved courses) against their weekly hour cap, for the workload spread
// view. Registered before /:id so "workload" isn't swallowed as a tutor id.
router.get("/workload", async (req, res) => {
  try {
    // Same scope contract as the list: a course-scoped organiser sees the
    // tutors assigned inside their courses, and only those courses count
    // toward the hours — nothing from a module they can't see leaks into
    // the bars or the per-course tooltip.
    const scopeCourseIds = await scopeFor(req);
    if (scopeCourseIds === undefined) {
      return res.status(403).json({ error: "Only organisers can list tutors" });
    }
    if (Array.isArray(scopeCourseIds) && scopeCourseIds.length === 0) {
      return res.json([]);
    }

    const { data: tutors, error: tutorsError } = await supabase
      .from("tutors")
      .select("id, name, weekly_hour_cap")
      .order("name");

    if (tutorsError) {
      console.error("Workload: failed to load tutors:", tutorsError);
      return res.status(500).json({ error: tutorsError.message });
    }

    const { data: approvals, error: approvalsError } = await supabase
      .from("tutor_subject_preference")
      .select(
        "tutor_id, course_id, courses(course_code, course_name, hours_per_week)",
      )
      .eq("status", "approved");

    if (approvalsError) {
      console.error("Workload: failed to load approvals:", approvalsError);
      return res.status(500).json({ error: approvalsError.message });
    }

    // Outside-scope assignments drop out before anything is summed, so the
    // numbers describe exactly the courses shown.
    const assignments = (approvals || []).filter(
      (a) =>
        !Array.isArray(scopeCourseIds) ||
        scopeCourseIds.includes(Number(a.course_id)),
    );

    const coursesByTutor = {};
    assignments.forEach((a) => {
      // The embedded course can come back as a single object or (depending
      // on how the foreign key is set up) an array with one entry — handle
      // both instead of assuming one shape.
      const course = Array.isArray(a.courses) ? a.courses[0] : a.courses;
      if (!course) return;
      if (!coursesByTutor[a.tutor_id]) coursesByTutor[a.tutor_id] = [];
      coursesByTutor[a.tutor_id].push({
        course_code: course.course_code,
        course_name: course.course_name,
        hours_per_week: course.hours_per_week || 0,
      });
    });

    const workload = (tutors || [])
      .filter(
        (t) =>
          !Array.isArray(scopeCourseIds) ||
          (coursesByTutor[t.id] || []).length > 0,
      )
      .map((t) => {
        const courses = coursesByTutor[t.id] || [];
        return {
          id: t.id,
          name: t.name,
          weeklyHourCap: t.weekly_hour_cap,
          assignedHours: courses.reduce((sum, c) => sum + c.hours_per_week, 0),
          courses,
        };
      });

    res.json(workload);
  } catch (err) {
    console.error("Workload endpoint crashed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/tutors/bulk — update a field across all tutors at once.
// Used by the global settings card to set the weekly hour cap for everyone.
router.put("/bulk", async (req, res) => {
  const { weekly_hour_cap } = req.body;
  if (weekly_hour_cap == null) {
    return res.status(400).json({ error: "weekly_hour_cap is required" });
  }

  const { data: tutors, error: fetchErr } = await supabase
    .from("tutors")
    .select("id");

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  if (!tutors || tutors.length === 0) return res.json({ updated: 0 });

  const { error: updateErr } = await supabase
    .from("tutors")
    .update({ weekly_hour_cap })
    .neq("id", "00000000-0000-0000-0000-000000000000"); // update all rows

  if (updateErr) return res.status(500).json({ error: updateErr.message });
  res.json({ updated: tutors.length });
});

// Simple UUID check so non-UUID path segments get a clean 404 instead of
// a cryptic Postgres error.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/tutors/bulk-rates — set the hourly_rate for one or more academic
// levels. The organiser edits rates in the settings card and clicks "Save
// rates"; this writes to the shared per-level rate, not to individual tutor
// rows, so every tutor at that level is paid from the same number.
router.post("/bulk-rates", async (req, res) => {
  const { rates } = req.body;
  if (!rates || typeof rates !== "object") {
    return res.status(400).json({ error: "rates object is required" });
  }

  for (const [level, rate] of Object.entries(rates)) {
    const rateNum = Number(rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) {
      return res.status(400).json({
        error: `Invalid rate for ${level}: must be a non-negative number`,
      });
    }

    const { data: existing, error: findError } = await supabase
      .from("academic_level_rates")
      .select("academic_level")
      .eq("academic_level", level)
      .maybeSingle();
    if (findError) return res.status(500).json({ error: findError.message });

    const { error: writeError } = existing
      ? await supabase
          .from("academic_level_rates")
          .update({ hourly_rate: rateNum })
          .eq("academic_level", level)
      : await supabase
          .from("academic_level_rates")
          .insert({ academic_level: level, hourly_rate: rateNum });

    if (writeError) return res.status(500).json({ error: writeError.message });
  }

  res.json({ updated: Object.keys(rates).length });
});

// GET /api/tutors/rates — the current hourly_rate for each academic level.
// Registered before /:id so "rates" isn't swallowed as a tutor id.
router.get("/rates", async (req, res) => {
  const { ratesMap, error } = await getRatesMap();
  if (error) return res.status(500).json({ error: error.message });
  res.json(ratesMap);
});

// GET /api/tutors/:id — a single tutor
router.get("/:id", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(404).json({ error: "Tutor not found" });
  }
  const { data, error } = await supabase
    .from("tutors")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (error) {
    if (error.code === "PGRST116")
      return res.status(404).json({ error: "Tutor not found" });
    return res.status(500).json({ error: error.message });
  }

  const { ratesMap, error: ratesError } = await getRatesMap();
  if (ratesError) return res.status(500).json({ error: ratesError.message });

  res.json({
    ...data,
    hourly_rate:
      data.academic_level != null
        ? (ratesMap[data.academic_level] ?? null)
        : null,
  });
});

// POST /api/tutors — add a new tutor.
// The tutors.id column is a foreign key into auth.users, so creating a tutor
// requires first creating an auth account. We generate a temporary password;
// the tutor will be prompted to change it on first login.
router.post("/", async (req, res) => {
  const { student_number, email, name, academic_level, weekly_hour_cap } =
    req.body;

  // ── Input validation ─────────────────────────────────────────
  const VALID_LEVELS = ["third_year", "honours", "masters", "phd"];
  const WITS_EMAIL_RE = /@(wits\.ac\.za|students\.wits\.ac\.za)$/i;
  const errors = [];

  if (!name || !name.trim()) errors.push("Name is required.");
  else if (name.trim().length < 2)
    errors.push("Name must be at least 2 characters.");

  if (!student_number || !String(student_number).trim())
    errors.push("Student number is required.");
  else if (!/^\d{5,10}$/.test(String(student_number).trim()))
    errors.push("Student number must be 5–10 digits.");

  if (!email || !email.trim())
    errors.push("Email is required to create a tutor account.");
  else if (!WITS_EMAIL_RE.test(email.trim()))
    errors.push("Email must end with @wits.ac.za or @students.wits.ac.za.");

  if (!academic_level) errors.push("Academic level is required.");
  else if (!VALID_LEVELS.includes(academic_level))
    errors.push(
      "Invalid academic level. Must be one of: " + VALID_LEVELS.join(", "),
    );

  if (
    weekly_hour_cap != null &&
    (isNaN(weekly_hour_cap) || weekly_hour_cap < 0)
  )
    errors.push("Weekly hour cap must be a non-negative number.");

  if (errors.length) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  // Check for duplicate student number
  const { data: existingStudent } = await supabase
    .from("tutors")
    .select("id")
    .eq("student_number", String(student_number).trim())
    .maybeSingle();
  if (existingStudent) {
    return res
      .status(409)
      .json({ error: "A tutor with this student number already exists." });
  }

  // Check for duplicate email across all user accounts (not just tutors).
  // An email in the users table means an auth account already exists for it,
  // so signUp would fail anyway — catch it early with a clear message.
  const { data: existingEmail } = await supabase
    .from("users")
    .select("id")
    .eq("email", email.trim())
    .maybeSingle();
  if (existingEmail) {
    return res
      .status(409)
      .json({ error: "An account with this email already exists." });
  }

  // 1. Create the auth user with a temporary password
  const tempPassword = crypto.randomBytes(12).toString("base64url");
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password: tempPassword,
  });

  if (authError) {
    // If the email already exists in auth, give a clear message
    const isDuplicate = /already|registered|exists/i.test(authError.message);
    if (isDuplicate) {
      return res.status(409).json({
        error:
          "An account with this email already exists. Use a different email address.",
      });
    }
    return res.status(400).json({ error: authError.message });
  }

  const userId = authData.user?.id;
  if (!userId) {
    return res.status(400).json({ error: "Auth user was not created." });
  }

  // 2. Insert into the users table (matches auth.js registration flow)
  const { error: userError } = await supabase.from("users").insert({
    id: userId,
    email,
    name,
    role: "tutor",
  });

  if (userError) {
    return res.status(500).json({
      error:
        "Auth user created, but users table insert failed: " +
        userError.message,
    });
  }

  // 3. Insert into the tutors table
  const { data: tutor, error: tutorError } = await supabase
    .from("tutors")
    .insert({
      id: userId,
      student_number,
      email,
      name,
      academic_level,
      weekly_hour_cap,
    })
    .select()
    .single();

  if (tutorError) {
    return res.status(500).json({ error: tutorError.message });
  }

  // Best-effort: the tutor is already created, so a rates lookup failure
  // here shouldn't fail the whole request — it just falls back to null.
  const { ratesMap } = await getRatesMap();
  tutor.hourly_rate = ratesMap?.[academic_level] ?? null;

  res.status(201).json(tutor);
});

// PUT /api/tutors/:id — edit an existing tutor
router.put("/:id", async (req, res) => {
  const { student_number, email, name, academic_level, weekly_hour_cap } =
    req.body;

  const { data, error } = await supabase
    .from("tutors")
    .update({
      student_number,
      email,
      name,
      academic_level,
      weekly_hour_cap,
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Best-effort: the update already succeeded, so a rates lookup failure
  // here shouldn't fail the whole request — it just falls back to null.
  const { ratesMap } = await getRatesMap();
  data.hourly_rate =
    data.academic_level != null
      ? (ratesMap?.[data.academic_level] ?? null)
      : null;

  res.json(data);
});

// DELETE /api/tutors/:id — remove a tutor
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("tutors")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// ---------- busy times (the calendar's added/imported classes) ----------
// The database is the only copy of these: the calendar reads them from here
// on load and writes each change straight back, and the organiser board's
// clash checks read the same rows. :id is the user's id — student
// volunteers keep classes here too, despite the "tutor" naming.

// Calendar field name -> column, for the fields a class can be created or
// updated with. `exceptions` holds per-day cancellations/edits (see
// server/migrations/2026-10-08-busy-times-calendar.sql).
const BUSY_TIME_FIELDS = {
  title: "title",
  dayOfWeek: "day_of_week",
  startTime: "start_time",
  endTime: "end_time",
  firstDate: "first_date",
  endDate: "end_date",
  venue: "venue",
  exceptions: "exceptions",
};

// Builds a row update from just the fields present on `body`, so a PATCH
// only touches what it sends. Empty strings become null, like the original
// import did.
function busyTimeColumns(body) {
  const columns = {};
  for (const [field, column] of Object.entries(BUSY_TIME_FIELDS)) {
    if (body[field] === undefined) continue;
    columns[column] = body[field] === "" ? null : body[field];
  }
  return columns;
}

function validateBusyTime(c, { partial }) {
  if (!partial || c.dayOfWeek !== undefined) {
    if (!Number.isInteger(c.dayOfWeek) || c.dayOfWeek < 0 || c.dayOfWeek > 6) {
      return "dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday)";
    }
  }
  if (!partial && (!c.startTime || !c.endTime)) {
    return "startTime and endTime are required";
  }
  if (c.exceptions !== undefined && !Array.isArray(c.exceptions)) {
    return "exceptions must be an array";
  }
  return null;
}

// GET /api/tutors/:id/busy-times — this user's classes, oldest first.
router.get("/:id/busy-times", async (req, res) => {
  const { data, error } = await supabase
    .from("tutor_busy_times")
    .select("*")
    .eq("tutor_id", req.params.id)
    .order("id");

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/tutors/:id/busy-times — add one or more classes
// ({ classes: [...] }, the timetable import adds several at once).
router.post("/:id/busy-times", async (req, res) => {
  const { classes } = req.body ?? {};
  if (!Array.isArray(classes) || classes.length === 0) {
    return res.status(400).json({ error: "classes must be a non-empty array" });
  }
  for (const c of classes) {
    const problem = validateBusyTime(c ?? {}, { partial: false });
    if (problem) return res.status(400).json({ error: problem });
  }

  // A new class has no per-day exceptions; the column's own default ([])
  // covers that, so adding classes doesn't depend on it being sent.
  const rows = classes.map((c) => ({
    ...busyTimeColumns(c),
    tutor_id: req.params.id,
  }));

  const { data, error } = await supabase
    .from("tutor_busy_times")
    .insert(rows)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/tutors/:id/busy-times/:busyTimeId — change some fields of one
// class (including its per-day exceptions).
router.patch("/:id/busy-times/:busyTimeId", async (req, res) => {
  const body = req.body ?? {};
  const problem = validateBusyTime(body, { partial: true });
  if (problem) return res.status(400).json({ error: problem });

  const columns = busyTimeColumns(body);
  if (Object.keys(columns).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await supabase
    .from("tutor_busy_times")
    .update(columns)
    .eq("id", Number(req.params.busyTimeId))
    .eq("tutor_id", req.params.id)
    .select()
    .single();

  if (error?.code === "PGRST116") {
    return res.status(404).json({ error: "Class not found" });
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/tutors/:id/busy-times/:busyTimeId — remove one class.
router.delete("/:id/busy-times/:busyTimeId", async (req, res) => {
  const { error } = await supabase
    .from("tutor_busy_times")
    .delete()
    .eq("id", Number(req.params.busyTimeId))
    .eq("tutor_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// DELETE /api/tutors/:id/busy-times — remove all of this user's classes.
router.delete("/:id/busy-times", async (req, res) => {
  const { error } = await supabase
    .from("tutor_busy_times")
    .delete()
    .eq("tutor_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// GET /api/tutors/:id/assignment-check?courseId=X — timetable clashes and
// weekly-hours workload for this tutor if they were assigned to courseId.
// Combined into one endpoint since the organiser board renders both at once.
router.get("/:id/assignment-check", async (req, res) => {
  const tutorId = req.params.id;
  const { courseId } = req.query;
  if (!courseId) {
    return res.status(400).json({ error: "courseId is required" });
  }

  // These three don't depend on each other's results — only on tutorId and
  // courseId, both already known from the request — so fire them together
  // instead of paying for three sequential round trips.
  const [
    { data: tutor, error: tutorError },
    { data: course, error: courseError },
    { data: otherApprovals, error: approvalsError },
  ] = await Promise.all([
    supabase
      .from("tutors")
      .select("weekly_hour_cap")
      .eq("id", tutorId)
      .single(),
    supabase
      .from("courses")
      .select("Day_of_tut, tutor_start_time, tutor_end_time, hours_per_week")
      .eq("id", courseId)
      .single(),
    // Tutor's other approved courses (for both course-vs-course clashes and workload)
    supabase
      .from("tutor_subject_preference")
      .select(
        "course_id, courses(course_code, course_name, Day_of_tut, tutor_start_time, tutor_end_time, hours_per_week)",
      )
      .eq("tutor_id", tutorId)
      .eq("status", "approved")
      .neq("course_id", courseId),
  ]);

  if (tutorError || !tutor) {
    return res.status(404).json({ error: "Tutor not found" });
  }

  if (courseError || !course) {
    return res.status(404).json({ error: "Course not found" });
  }

  if (approvalsError) {
    return res.status(500).json({ error: approvalsError.message });
  }

  // ---- clash check ----
  let busyTimeClashes = [];
  let courseClashes = [];

  const courseDay = DAY_NAMES.indexOf(course.Day_of_tut);
  const courseStart = toMinutes(course.tutor_start_time);
  const courseEnd = toMinutes(course.tutor_end_time);
  const courseIsScheduled =
    courseDay !== -1 && courseStart != null && courseEnd != null;

  if (courseIsScheduled) {
    const { data: busyTimes, error: busyTimesError } = await supabase
      .from("tutor_busy_times")
      .select("title, day_of_week, start_time, end_time")
      .eq("tutor_id", tutorId)
      .eq("day_of_week", courseDay);

    if (busyTimesError) {
      return res.status(500).json({ error: busyTimesError.message });
    }

    busyTimeClashes = busyTimes.filter((b) =>
      overlaps(
        courseStart,
        courseEnd,
        toMinutes(b.start_time),
        toMinutes(b.end_time),
      ),
    );

    courseClashes = (otherApprovals || [])
      .map((a) => a.courses)
      .filter((c) => c && DAY_NAMES.indexOf(c.Day_of_tut) === courseDay)
      .filter((c) =>
        overlaps(
          courseStart,
          courseEnd,
          toMinutes(c.tutor_start_time),
          toMinutes(c.tutor_end_time),
        ),
      );
  }

  // ---- workload check ----
  const currentAssignedHours = (otherApprovals || []).reduce(
    (sum, a) => sum + (a.courses?.hours_per_week || 0),
    0,
  );
  const courseHours = course.hours_per_week || 0;
  const projectedHours = currentAssignedHours + courseHours;
  const weeklyHourCap = tutor.weekly_hour_cap;

  res.json({
    clashes: { busyTimeClashes, courseClashes },
    workload: {
      weeklyHourCap,
      currentAssignedHours,
      courseHours,
      projectedHours,
      overCap: weeklyHourCap != null && projectedHours > weeklyHourCap,
    },
  });
});

module.exports = router;
