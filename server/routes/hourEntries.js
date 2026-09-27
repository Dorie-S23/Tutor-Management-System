const express = require("express");
const supabase = require("../supabaseClient");
const { getRatesMap } = require("./academicLevelRates");
const { DAY_NAMES } = require("../dayNames");

const router = express.Router();

// Every hour entry must be tied to a real course so the budget report can
// cost it. The entry's display label (subject) is taken from that course's
// code rather than trusted from the client, so the two can never disagree.
// The timetable columns ride along so tutor entries can be checked against
// the course's scheduled slots.
async function resolveCourse(courseId) {
  if (courseId == null || courseId === "") {
    return { status: 400, error: "courseId is required" };
  }
  const { data, error } = await supabase
    .from("courses")
    .select(
      "id, course_code, Day_of_tut, tutor_start_time, tutor_end_time, Day_of_lab, lab_start_time, lab_end_time",
    )
    .eq("id", Number(courseId))
    .maybeSingle();
  if (error) return { status: 500, error: error.message };
  if (!data) return { status: 400, error: "Unknown course" };
  return { course: data };
}

// ---------- tutor session rules ----------
// Tutors log the hours of the sessions the timetable allocated to them: an
// entry must belong to a course the tutor is approved for and line up
// exactly with that course's weekly tutorial or lab slot — the same Log
// Hours flow volunteers get, where only scheduled sessions can be picked.
// Volunteers ("Peer support") and any other role pass straight through.

function sliceTime(value) {
  return value == null ? "" : String(value).slice(0, 5);
}

function localDateStr(date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

// True when the time range is exactly one of the course's two weekly
// slots: its tutorial (Day_of_tut / tutor_*) or its lab (Day_of_lab /
// lab_*). Day names are stored the same way DAY_NAMES spells them.
function matchesScheduledSlot(course, date, startTime, endTime) {
  if (!date || !startTime || !endTime) return false;
  const [y, m, d] = String(date).split("-").map(Number);
  if (!y || !m || !d) return false;
  const weekday = DAY_NAMES[new Date(y, m - 1, d).getDay()];
  const start = sliceTime(startTime);
  const end = sliceTime(endTime);
  return [
    [course.Day_of_tut, course.tutor_start_time, course.tutor_end_time],
    [course.Day_of_lab, course.lab_start_time, course.lab_end_time],
  ].some(
    ([day, slotStart, slotEnd]) =>
      Boolean(day) &&
      day === weekday &&
      sliceTime(slotStart) === start &&
      sliceTime(slotEnd) === end,
  );
}

// A session counts as upcoming while it is today and hasn't finished yet,
// or on any later date — the same window the session chips on the Log
// Hours page offer.
function isUpcomingSession(date, endTime, now = new Date()) {
  const today = localDateStr(now);
  if (String(date) > today) return true;
  if (String(date) < today) return false;
  const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
  return sliceTime(endTime) > nowHHMM;
}

async function isTutor(userId) {
  const { data } = await supabase
    .from("tutors")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  return Boolean(data);
}

async function isApprovedForCourse(userId, courseId) {
  const { data, error } = await supabase
    .from("tutor_subject_preference")
    .select("status")
    .eq("tutor_id", userId)
    .eq("course_id", Number(courseId));
  if (error) return false;
  return (data || []).some(
    (row) => (row.status || "").toLowerCase() === "approved",
  );
}

// Returns { status, error } when the entry breaks the session rules, or
// null when it's allowed. `requireUpcoming` is only relaxed for edits, so
// fixing an older entry doesn't require deleting and re-logging it.
async function tutorSessionError(
  userId,
  course,
  { date, startTime, endTime },
  { requireUpcoming },
) {
  if (!(await isTutor(userId))) return null;
  if (!(await isApprovedForCourse(userId, course.id))) {
    return {
      status: 403,
      error: "You can only log hours for modules you're approved to tutor",
    };
  }
  if (!matchesScheduledSlot(course, date, startTime, endTime)) {
    return {
      status: 400,
      error:
        "Log the course's scheduled tutorial or lab slot — other times aren't allowed",
    };
  }
  if (requireUpcoming && !isUpcomingSession(date, endTime)) {
    return {
      status: 400,
      error: "You can only log upcoming sessions — that one has already ended",
    };
  }
  return null;
}

// GET /api/hour-entries?userId=...
router.get("/", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  const { data, error } = await supabase
    .from("hour_entries")
    .select("*")
    .eq("user_id", userId)
    .order("date");

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/hour-entries
router.post("/", async (req, res) => {
  const { userId, date, hours, startTime, endTime, taskType, notes, courseId } =
    req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  const { course, status, error: courseError } = await resolveCourse(courseId);
  if (courseError) return res.status(status).json({ error: courseError });

  const ruleError = await tutorSessionError(
    userId,
    course,
    { date, startTime, endTime },
    { requireUpcoming: true },
  );
  if (ruleError) {
    return res.status(ruleError.status).json({ error: ruleError.error });
  }

  const { data, error } = await supabase
    .from("hour_entries")
    .insert({
      user_id: userId,
      date,
      hours,
      start_time: startTime || null,
      end_time: endTime || null,
      task_type: taskType || "Tutoring",
      subject: course.course_code,
      notes: notes || "",
      course_id: course.id,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/hour-entries/:id
router.put("/:id", async (req, res) => {
  const { date, hours, startTime, endTime, taskType, notes, courseId } =
    req.body;

  const { course, status, error: courseError } = await resolveCourse(courseId);
  if (courseError) return res.status(status).json({ error: courseError });

  // An edit that leaves the course/date/start/end untouched (fixing notes,
  // say) is always allowed, so historical entries stay correctable. Moving
  // an entry must land it back on one of the course's scheduled slots,
  // exactly like a new entry — but a past date stays allowed here, since
  // correcting an older entry shouldn't force a delete and re-log.
  const { data: stored } = await supabase
    .from("hour_entries")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (stored) {
    const structureChanged =
      String(stored.date) !== String(date) ||
      sliceTime(stored.start_time) !== sliceTime(startTime) ||
      sliceTime(stored.end_time) !== sliceTime(endTime) ||
      String(stored.course_id) !== String(course.id);
    if (structureChanged) {
      const ruleError = await tutorSessionError(
        stored.user_id,
        course,
        { date, startTime, endTime },
        { requireUpcoming: false },
      );
      if (ruleError) {
        return res.status(ruleError.status).json({ error: ruleError.error });
      }
    }
  }

  const { data, error } = await supabase
    .from("hour_entries")
    .update({
      date,
      hours,
      start_time: startTime || null,
      end_time: endTime || null,
      task_type: taskType || "Tutoring",
      subject: course.course_code,
      notes: notes || "",
      course_id: course.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/hour-entries/report?from=YYYY-MM-DD&to=YYYY-MM-DD
// Aggregates logged Tutoring hours per (tutor, course), with cost computed
// from the hourly_rate for the tutor's academic_level, for the organiser's
// hours/budget report.
// hour_entries has no direct FK to tutors (only to users, which tutors
// happens to share a primary key with), so tutor details are fetched
// separately and merged here rather than relying on PostgREST embedding.
router.get("/report", async (req, res) => {
  const { from, to } = req.query;

  let query = supabase
    .from("hour_entries")
    .select(
      "user_id, course_id, hours, date, courses:course_id(course_code, course_name, budget)",
    )
    .eq("task_type", "Tutoring");

  if (from) query = query.gte("date", from);
  if (to) query = query.lte("date", to);

  const { data: entries, error: entriesError } = await query;
  if (entriesError) {
    return res.status(500).json({ error: entriesError.message });
  }

  const { data: tutors, error: tutorsError } = await supabase
    .from("tutors")
    .select("id, name, academic_level");
  if (tutorsError) {
    return res.status(500).json({ error: tutorsError.message });
  }
  const tutorsById = Object.fromEntries(tutors.map((t) => [t.id, t]));

  const { ratesMap, error: ratesError } = await getRatesMap();
  if (ratesError) {
    return res.status(500).json({ error: ratesError.message });
  }

  const linked = entries.filter((e) => e.course_id != null && e.courses);
  const unlinked = entries.filter((e) => e.course_id == null);

  const grouped = {};
  for (const entry of linked) {
    const key = `${entry.user_id}:${entry.course_id}`;
    if (!grouped[key]) {
      const tutor = tutorsById[entry.user_id];
      grouped[key] = {
        tutorId: entry.user_id,
        tutorName: tutor?.name || null,
        hourlyRate:
          tutor?.academic_level != null
            ? (ratesMap[tutor.academic_level] ?? null)
            : null,
        courseId: entry.course_id,
        courseCode: entry.courses.course_code,
        courseName: entry.courses.course_name,
        budget: entry.courses.budget,
        hours: 0,
      };
    }
    grouped[key].hours += Number(entry.hours);
  }

  const rows = Object.values(grouped).map((row) => ({
    ...row,
    cost: row.hourlyRate != null ? row.hours * row.hourlyRate : null,
  }));

  res.json({
    rows,
    // Surfaced so the report can flag hours that exist but aren't tied to
    // any course, rather than silently dropping them from the totals.
    unlinkedHours: unlinked.reduce((sum, e) => sum + Number(e.hours), 0),
    unlinkedEntryCount: unlinked.length,
  });
});

// DELETE /api/hour-entries/:id
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("hour_entries")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
