const express = require("express");
const supabase = require("../supabaseClient");
const { getRatesMap } = require("./academicLevelRates");
const { GRACE_MINUTES, isWithinLoggingWindow } = require("../loggingWindow");
const { sliceTime, matchingSlotTypes } = require("./sessionSlots");
const { organiserIdsForCourse } = require("./organiserScope");
const { notify, formatShortDate } = require("./notificationHelpers");

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

// ---------- session logging rules ----------
// Every entry must belong to a real scheduled session, be created while
// that session is happening (from its start until GRACE_MINUTES after its
// end), and belong to the right person:
//   - tutors log the sessions the timetable allocated to them: a course
//     they're approved for, on the slot's weekday at exactly its
//     allocated tutorial/lab times;
//   - volunteers log the sessions assigned to them to cover because the
//     tutor can't attend (session_excusals.cover_user_id) — nothing else.
// `requireWindow` is only relaxed for edits, so fixing an older entry
// doesn't require deleting and re-logging it.
// The slot-matching helpers (sliceTime, matchingSlotTypes) live in
// ./sessionSlots so the attendance verification queue can label entries
// Tutorial/Lab the same way.

// True when this user is the assigned cover for one of those slots on that
// date — the volunteer side of the rules.
async function isCoveringSession(userId, courseId, date, slotTypes) {
  const { data, error } = await supabase
    .from("session_excusals")
    .select("session_type")
    .eq("cover_user_id", userId)
    .eq("course_id", Number(courseId))
    .eq("session_date", date);
  if (error) return false;
  return (data || []).some((row) => slotTypes.includes(row.session_type));
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
// null when it's allowed.
async function sessionRulesError(
  userId,
  course,
  { date, startTime, endTime },
  { requireWindow },
) {
  const slotTypes = matchingSlotTypes(course, date, startTime, endTime);
  const slotError = {
    status: 400,
    error:
      "Log the course's scheduled tutorial or lab slot — other times aren't allowed",
  };
  const windowError = {
    status: 400,
    error: `You can only log a session while it's happening — logging opens when it starts and closes ${GRACE_MINUTES} minutes after it ends`,
  };

  if (await isTutor(userId)) {
    if (!(await isApprovedForCourse(userId, course.id))) {
      return {
        status: 403,
        error: "You can only log hours for modules you're approved to tutor",
      };
    }
    if (slotTypes.length === 0) return slotError;
    if (requireWindow && !isWithinLoggingWindow(date, startTime, endTime)) {
      return windowError;
    }
    return null;
  }

  // Everyone else is a volunteer: only the sessions assigned to them to
  // cover for a tutor who can't attend can be logged.
  if (slotTypes.length === 0) return slotError;
  if (!(await isCoveringSession(userId, course.id, date, slotTypes))) {
    return {
      status: 403,
      error:
        "You can only log sessions you're covering for a tutor — this one wasn't assigned to you",
    };
  }
  if (requireWindow && !isWithinLoggingWindow(date, startTime, endTime)) {
    return windowError;
  }
  return null;
}

// Fire-and-forget: tell every organiser responsible for this course that a
// session was logged and is waiting for their attendance verification. The
// caller .catch()es — a notification hiccup must never fail the entry.
async function notifyOrganisersOfEntry(entry, course) {
  const organiserIds = await organiserIdsForCourse(course.id);
  if (organiserIds.length === 0) return;

  const { data: owner } = await supabase
    .from("users")
    .select("name")
    .eq("id", entry.user_id)
    .maybeSingle();

  const [slotType] = matchingSlotTypes(
    course,
    entry.date,
    sliceTime(entry.start_time),
    sliceTime(entry.end_time),
  );
  const sessionLabel =
    slotType === "tutorial"
      ? "Tutorial"
      : slotType === "lab"
        ? "Lab"
        : "Session";

  const message = `${owner?.name || "A tutor or volunteer"} logged ${Number(entry.hours)}h for ${course.course_code} (${sessionLabel}) on ${formatShortDate(entry.date)} — verify their attendance.`;

  await Promise.all(
    organiserIds.map((userId) =>
      notify(userId, {
        type: "attendance_logged",
        message,
        relatedEntity: "hour_entry",
        relatedId: entry.id,
      }).catch(() => {}),
    ),
  );
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

  const ruleError = await sessionRulesError(
    userId,
    course,
    { date, startTime, endTime },
    { requireWindow: true },
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
  notifyOrganisersOfEntry(data, course).catch((err) =>
    console.warn("Failed to notify organisers of logged session:", err),
  );
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
  // an entry must land it back on a session the user could log — the same
  // slot and cover rules as a new entry — but the live window is not
  // required here, since correcting an older entry shouldn't force a delete
  // and re-log.
  const { data: stored } = await supabase
    .from("hour_entries")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  let structureChanged = false;
  if (stored) {
    structureChanged =
      String(stored.date) !== String(date) ||
      sliceTime(stored.start_time) !== sliceTime(startTime) ||
      sliceTime(stored.end_time) !== sliceTime(endTime) ||
      String(stored.course_id) !== String(course.id);
    if (structureChanged) {
      const ruleError = await sessionRulesError(
        stored.user_id,
        course,
        { date, startTime, endTime },
        { requireWindow: false },
      );
      if (ruleError) {
        return res.status(ruleError.status).json({ error: ruleError.error });
      }
    }
  }

  // A structural edit points the entry at a different session, so an
  // earlier verification no longer describes it — reset it to pending and
  // notify the organisers that it needs another look.
  const verificationReset =
    Boolean(stored) &&
    structureChanged &&
    stored.verification_status &&
    stored.verification_status !== "pending";

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
      ...(verificationReset
        ? {
            verification_status: "pending",
            verified_by: null,
            verified_at: null,
            verification_note: null,
          }
        : {}),
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (verificationReset) {
    notifyOrganisersOfEntry(data, course).catch((err) =>
      console.warn("Failed to notify organisers of re-logged session:", err),
    );
  }
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
