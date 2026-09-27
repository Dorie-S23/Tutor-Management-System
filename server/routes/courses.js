const express = require("express");
const supabase = require("../supabaseClient");
const { MAX_DIAGONALS, diagonalLabels } = require("./courseDiagonals");

const router = express.Router();

// shared validation for POST (create) and PUT (update)
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

// The minimum academic level a tutor must hold to apply for this course.
// Mirrors LEVEL_RANK in server/routes/tutorApplications.js, minus second_year
// since no tutor can actually hold that level.
const COURSE_LEVEL_RANK = { third_year: 3, honours: 4, masters: 5, phd: 6 };

// A venue field can list several rooms for one session (e.g. multiple
// tutorial groups) as "MSL004,005,006" — a shorthand where bare numbers
// inherit the last letter prefix (so "005" means "MSL005"). Split that into
// individual, fully-qualified room names rather than comparing the whole
// field as one string. Mirrors parseVenues() in public/js/board.js.
function parseVenues(venueStr) {
  const tokens = (venueStr || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  let prefix = "";
  return tokens.map((token) => {
    const match = token.match(/^([A-Za-z]+)(\d.*)$/);
    if (match) {
      prefix = match[1];
      return token;
    }
    return prefix && /^\d/.test(token) ? prefix + token : token;
  });
}

// Rooms shared between two venue fields, preserving venueA's original casing.
function sharedVenues(venueA, venueB) {
  const setB = new Set(parseVenues(venueB).map((v) => v.toLowerCase()));
  return parseVenues(venueA).filter((v) => setB.has(v.toLowerCase()));
}

function timeToMinutes(hhmmss) {
  const [h, m] = hhmmss.split(":").map(Number);
  return h * 60 + m;
}

function timesOverlap(startA, endA, startB, endB) {
  return (
    timeToMinutes(startA) < timeToMinutes(endB) &&
    timeToMinutes(startB) < timeToMinutes(endA)
  );
}

// Looks for another course's Tutorial or Lab sharing a venue with one of
// this course's own sessions, on the same day, at an overlapping time.
// excludeId lets an edit check itself against every other course without
// flagging its own pre-edit row. Fails open (returns null) on a lookup
// error so a Supabase hiccup never blocks saving.
async function findVenueClash(values, excludeId) {
  const sessions = [
    {
      type: "Tutorial",
      day: values.Day_of_tut,
      start: values.tutor_start_time,
      end: values.tutor_end_time,
      venue: values.venues,
    },
    {
      type: "Lab",
      day: values.Day_of_lab,
      start: values.lab_start_time,
      end: values.lab_end_time,
      venue: values.lab_venues,
    },
  ].filter((s) => s.day && s.start && s.end && s.venue);

  if (sessions.length === 0) return null;

  let query = supabase
    .from("courses")
    .select(
      "id, course_code, Day_of_tut, tutor_start_time, tutor_end_time, venues, Day_of_lab, lab_start_time, lab_end_time, lab_venues",
    );

  if (excludeId != null) {
    query = query.neq("id", excludeId);
  }

  const { data, error } = await query;
  if (error) return null;

  const otherSessions = [];
  data.forEach((row) => {
    if (
      row.Day_of_tut &&
      row.tutor_start_time &&
      row.tutor_end_time &&
      row.venues
    ) {
      otherSessions.push({
        type: "Tutorial",
        courseCode: row.course_code,
        day: row.Day_of_tut,
        start: row.tutor_start_time,
        end: row.tutor_end_time,
        venue: row.venues,
      });
    }
    if (
      row.Day_of_lab &&
      row.lab_start_time &&
      row.lab_end_time &&
      row.lab_venues
    ) {
      otherSessions.push({
        type: "Lab",
        courseCode: row.course_code,
        day: row.Day_of_lab,
        start: row.lab_start_time,
        end: row.lab_end_time,
        venue: row.lab_venues,
      });
    }
  });

  for (const session of sessions) {
    const clash = otherSessions.find(
      (other) =>
        other.day === session.day &&
        sharedVenues(session.venue, other.venue).length > 0 &&
        timesOverlap(session.start, session.end, other.start, other.end),
    );
    if (clash) {
      const shared = sharedVenues(session.venue, clash.venue).join(", ");
      return `${session.type} venue clash: ${shared} is already booked for ${clash.courseCode} ${clash.type} on ${session.day} ${clash.start.slice(0, 5)}–${clash.end.slice(0, 5)}`;
    }
  }

  return null;
}

// Parses one Tutorial-or-Lab session group. When `has` is false the group
// wasn't selected, so it's forced to all-null regardless of what the client
// sent (defensive against a stale value lingering after the checkbox is
// unticked). When `has` is true, day/start/end/venue are all required
// together — a session isn't "complete" with only some of them set.
function parseSessionGroup(has, day, start, end, venue, label) {
  if (!has) {
    return { day: null, start: null, end: null, venue: null };
  }
  if (typeof day !== "string" || !day.trim()) {
    return { error: `${label} day is required` };
  }
  if (typeof start !== "string" || !TIME_RE.test(start)) {
    return { error: `${label} start time must be a valid time (HH:MM)` };
  }
  if (typeof end !== "string" || !TIME_RE.test(end)) {
    return { error: `${label} end time must be a valid time (HH:MM)` };
  }
  if (start >= end) {
    return { error: `${label} start time must be before its end time` };
  }
  if (typeof venue !== "string" || !venue.trim()) {
    return { error: `${label} venue is required` };
  }
  return { day: day.trim(), start, end, venue: venue.trim() };
}

function parseCoursePayload(body) {
  const {
    course_code,
    course_name,
    min_mark,
    course_level,
    department,
    hours_per_week,
    tutors_needed,
    has_tutorial,
    day_of_tut,
    tutor_start_time,
    tutor_end_time,
    venues,
    has_lab,
    day_of_lab,
    lab_start_time,
    lab_end_time,
    lab_venues,
    budget,
    has_diagonals,
    diagonal_count,
  } = body ?? {};

  if (typeof course_code !== "string" || !course_code.trim()) {
    return { error: "course_code is required" };
  }
  if (typeof course_name !== "string" || !course_name.trim()) {
    return { error: "course_name is required" };
  }
  if (typeof department !== "string" || !department.trim()) {
    return { error: "department is required" };
  }
  if (!has_tutorial && !has_lab) {
    return { error: "Select at least one of Tutorials or Labs" };
  }

  const tutorial = parseSessionGroup(
    !!has_tutorial,
    day_of_tut,
    tutor_start_time,
    tutor_end_time,
    venues,
    "Tutorial",
  );
  if (tutorial.error) return { error: tutorial.error };

  const lab = parseSessionGroup(
    !!has_lab,
    day_of_lab,
    lab_start_time,
    lab_end_time,
    lab_venues,
    "Lab",
  );
  if (lab.error) return { error: lab.error };

  if (
    tutorial.day &&
    lab.day &&
    tutorial.day === lab.day &&
    sharedVenues(tutorial.venue, lab.venue).length > 0 &&
    timesOverlap(tutorial.start, tutorial.end, lab.start, lab.end)
  ) {
    return {
      error:
        "This course's own Tutorial and Lab overlap each other — pick different times or venues",
    };
  }

  const minMarkNum = Number(min_mark);
  if (!Number.isInteger(minMarkNum) || minMarkNum < 0 || minMarkNum > 100) {
    return { error: "min_mark must be an integer between 0 and 100" };
  }

  if (!Object.prototype.hasOwnProperty.call(COURSE_LEVEL_RANK, course_level)) {
    return {
      error:
        "course_level is required and must be one of: " +
        Object.keys(COURSE_LEVEL_RANK).join(", "),
    };
  }

  if (
    hours_per_week === undefined ||
    hours_per_week === null ||
    hours_per_week === ""
  ) {
    return { error: "hours_per_week is required" };
  }

  const hoursPerWeekNum = Number(hours_per_week);
  if (
    !Number.isInteger(hoursPerWeekNum) ||
    hoursPerWeekNum < 0 ||
    hoursPerWeekNum > 168
  ) {
    return { error: "hours_per_week must be an integer between 0 and 168" };
  }

  if (
    tutors_needed === undefined ||
    tutors_needed === null ||
    tutors_needed === ""
  ) {
    return { error: "number of tutors needed is required" };
  }

  const tutorsNeeded = Number(tutors_needed);
  if (
    !Number.isInteger(tutorsNeeded) ||
    tutorsNeeded < 0 ||
    tutorsNeeded > 20
  ) {
    return {
      error: "number of tutors needed must be an integer between 0 and 20",
    };
  }

  // Optional — a course can exist without a budget set yet.
  let budgetNum = null;
  if (budget !== undefined && budget !== null && budget !== "") {
    budgetNum = Number(budget);
    if (!Number.isFinite(budgetNum) || budgetNum < 0) {
      return { error: "budget must be a non-negative number" };
    }
  }

  // Optional — only large courses get split into diagonals (A, B, C…).
  // Unticked means no diagonals at all, whatever count the client sent.
  let diagonalCount = null;
  if (has_diagonals) {
    diagonalCount = Number(diagonal_count);
    if (
      !Number.isInteger(diagonalCount) ||
      diagonalCount < 2 ||
      diagonalCount > MAX_DIAGONALS
    ) {
      return {
        error: `number of diagonals must be an integer between 2 and ${MAX_DIAGONALS}`,
      };
    }
  }

  return {
    values: {
      course_code: course_code.trim(),
      course_name: course_name.trim(),
      min_mark: minMarkNum,
      course_level: COURSE_LEVEL_RANK[course_level],
      department: department.trim(),
      hours_per_week: hoursPerWeekNum,
      tutors_needed: tutorsNeeded,
      Day_of_tut: tutorial.day,
      tutor_start_time: tutorial.start,
      tutor_end_time: tutorial.end,
      venues: tutorial.venue,
      Day_of_lab: lab.day,
      lab_start_time: lab.start,
      lab_end_time: lab.end,
      lab_venues: lab.venue,
      budget: budgetNum,
      diagonal_count: diagonalCount,
    },
  };
}

// After a course's diagonal count shrinks (or diagonals are switched off),
// anyone still placed in a diagonal that no longer exists is moved back to
// unassigned, so they don't silently sit in a hidden "diagonal E".
async function clearStaleDiagonals(courseId, diagonalCount) {
  const valid = new Set(diagonalLabels(diagonalCount));
  for (const table of ["tutor_subject_preference", "course_volunteers"]) {
    const { data, error } = await supabase
      .from(table)
      .select("id, diagonal")
      .eq("course_id", courseId);
    if (error) throw error;

    const staleIds = (data || [])
      .filter((row) => row.diagonal != null && !valid.has(row.diagonal))
      .map((row) => row.id);
    if (staleIds.length === 0) continue;

    const { error: updateError } = await supabase
      .from(table)
      .update({ diagonal: null })
      .in("id", staleIds);
    if (updateError) throw updateError;
  }
}

// The only Tutorial/Lab fields that matter to someone already assigned —
// a course_name, min_mark or budget edit doesn't affect anyone's schedule.
const SESSION_FIELDS = [
  "Day_of_tut",
  "tutor_start_time",
  "tutor_end_time",
  "venues",
  "Day_of_lab",
  "lab_start_time",
  "lab_end_time",
  "lab_venues",
];

// Postgres's `time` columns round-trip as "HH:MM:SS" once read back from the
// DB, but the client only ever sends "HH:MM" (no seconds) from a plain
// <input type="time">. Without normalizing both sides to the same shape,
// "10:15:00" (before, freshly fetched) vs "10:15" (after, from the request
// body) would compare unequal even when nothing actually changed — flagging
// every single course edit, including ones that only touch min_mark or
// course_level, as a session change.
const TIME_FIELDS = new Set([
  "tutor_start_time",
  "tutor_end_time",
  "lab_start_time",
  "lab_end_time",
]);

function normalizeSessionField(field, value) {
  if (value == null) return null;
  return TIME_FIELDS.has(field) ? value.slice(0, 5) : value;
}

// Notifies every tutor and student volunteer currently approved on this
// course when its Tutorial/Lab day, time or venue changes. Best-effort —
// the caller swallows any error so a notification failure never blocks the
// course edit itself from saving.
async function notifySessionChange(courseId, before, after) {
  const changed = SESSION_FIELDS.some(
    (field) =>
      normalizeSessionField(field, before[field]) !==
      normalizeSessionField(field, after[field]),
  );
  if (!changed) return;

  const [{ data: tutorRows }, { data: volunteerRows }] = await Promise.all([
    supabase
      .from("tutor_subject_preference")
      .select("tutor_id")
      .eq("course_id", courseId)
      .eq("status", "approved"),
    supabase
      .from("course_volunteers")
      .select("user_id")
      .eq("course_id", courseId)
      .eq("status", "approved"),
  ]);

  const recipientIds = new Set([
    ...(tutorRows || []).map((r) => r.tutor_id),
    ...(volunteerRows || []).map((r) => r.user_id),
  ]);
  if (recipientIds.size === 0) return;

  const message = `${after.course_code}'s session time changed — check the calendar for the new day/time/venue.`;

  const { error } = await supabase.from("notifications").insert(
    [...recipientIds].map((userId) => ({
      user_id: userId,
      type: "session_change",
      message,
      related_entity: "course",
      related_id: String(courseId),
      read: false,
    })),
  );
  if (error) throw error;
}

// GET /api/courses — list all courses
router.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("courses")
    .select("*")
    .order("course_code", { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// POST /api/courses — add a new course
router.post("/", async (req, res) => {
  const { values, error: validationError } = parseCoursePayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const clashError = await findVenueClash(values, null);
  if (clashError) {
    return res.status(409).json({ error: clashError });
  }

  const { data, error } = await supabase
    .from("courses")
    .insert(values)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return res
        .status(409)
        .json({ error: `Course code "${values.course_code}" already exists` });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

// PUT /api/courses/:id — edit an existing course
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid course id" });
  }

  const { values, error: validationError } = parseCoursePayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const clashError = await findVenueClash(values, id);
  if (clashError) {
    return res.status(409).json({ error: clashError });
  }

  // Fetched before applying the update purely to detect whether the
  // Tutorial/Lab day/time/venue actually changed — the one edit worth
  // notifying already-assigned tutors/volunteers about.
  const { data: before } = await supabase
    .from("courses")
    .select([...SESSION_FIELDS, "diagonal_count"].join(", "))
    .eq("id", id)
    .maybeSingle();

  const { data, error } = await supabase
    .from("courses")
    .update(values)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return res
        .status(409)
        .json({ error: `Course code "${values.course_code}" already exists` });
    }
    if (error.code === "PGRST116") {
      return res.status(404).json({ error: "Course not found" });
    }
    return res.status(500).json({ error: error.message });
  }

  if (before) {
    notifySessionChange(id, before, values).catch((err) =>
      console.warn("Failed to notify about session change:", err),
    );
  }

  if ((before?.diagonal_count ?? 0) > (values.diagonal_count ?? 0)) {
    try {
      await clearStaleDiagonals(id, values.diagonal_count);
    } catch (err) {
      console.warn("Failed to clear stale diagonal placements:", err);
    }
  }

  res.json(data);
});

// DELETE /api/courses/:id — remove a course
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid course id" });
  }

  const { error, count } = await supabase
    .from("courses")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    if (error.code === "23503") {
      return res.status(409).json({
        error:
          "Can't delete this course — it still has tutor applications, volunteers, or preferences linked to it. Remove those first.",
      });
    }
    return res.status(500).json({ error: error.message });
  }

  if (count === 0) {
    return res.status(404).json({ error: "Course not found" });
  }

  res.status(204).end();
});

// PATCH /api/courses/:id/tutors-assigned — bump the assigned-tutor counter up or down by 1
router.patch("/:id/tutors-assigned", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid course id" });
  }

  const { delta } = req.body ?? {};
  if (delta !== 1 && delta !== -1) {
    return res.status(400).json({ error: "delta must be 1 or -1" });
  }

  const { data: course, error: fetchError } = await supabase
    .from("courses")
    .select("no_of_tutors_assigned, tutors_needed")
    .eq("id", id)
    .single();

  if (fetchError) {
    if (fetchError.code === "PGRST116") {
      return res.status(404).json({ error: "Course not found" });
    }
    return res.status(500).json({ error: fetchError.message });
  }

  const next = (course.no_of_tutors_assigned ?? 0) + delta;

  if (next < 0) {
    return res
      .status(409)
      .json({ error: "No tutors are currently assigned to this course" });
  }
  if (next > course.tutors_needed) {
    return res
      .status(409)
      .json({ error: "This course already has all the tutors it needs" });
  }

  const { data, error } = await supabase
    .from("courses")
    .update({ no_of_tutors_assigned: next })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

module.exports = router;
