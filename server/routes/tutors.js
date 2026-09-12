const express = require("express");
const supabase = require("../supabaseClient");
const { DAY_NAMES } = require("../dayNames");

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

// GET /api/tutors — list all tutors
router.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("tutors")
    .select("*")
    .order("name");

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/tutors/workload — every tutor's assigned hours (summed from their
// approved courses) against their weekly hour cap, for the workload spread
// view. Registered before /:id so "workload" isn't swallowed as a tutor id.
router.get("/workload", async (req, res) => {
  try {
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
      .select("tutor_id, courses(course_code, course_name, hours_per_week)")
      .eq("status", "approved");

    if (approvalsError) {
      console.error("Workload: failed to load approvals:", approvalsError);
      return res.status(500).json({ error: approvalsError.message });
    }

    const coursesByTutor = {};
    (approvals || []).forEach((a) => {
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

    const workload = (tutors || []).map((t) => {
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
  res.json(data);
});

// POST /api/tutors — add a new tutor
router.post("/", async (req, res) => {
  const { student_number, email, name, academic_level, weekly_hour_cap } =
    req.body;

  const { data, error } = await supabase
    .from("tutors")
    .insert({
      student_number,
      email,
      name,
      academic_level,
      weekly_hour_cap,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
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

// PUT /api/tutors/:id/busy-times — replace a tutor's whole imported timetable.
// Full-replace (rather than diffing individual classes) avoids reconciling
// client-generated ids with server-generated ones.
router.put("/:id/busy-times", async (req, res) => {
  const { classes } = req.body ?? {};
  if (!Array.isArray(classes)) {
    return res.status(400).json({ error: "classes must be an array" });
  }

  const { error: deleteError } = await supabase
    .from("tutor_busy_times")
    .delete()
    .eq("tutor_id", req.params.id);

  if (deleteError) return res.status(500).json({ error: deleteError.message });

  if (classes.length === 0) return res.json([]);

  const rows = classes.map((c) => ({
    tutor_id: req.params.id,
    title: c.title || null,
    day_of_week: c.dayOfWeek,
    start_time: c.startTime,
    end_time: c.endTime,
    first_date: c.firstDate || null,
    end_date: c.endDate || null,
    venue: c.venue || null,
  }));

  const { data, error } = await supabase
    .from("tutor_busy_times")
    .insert(rows)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
