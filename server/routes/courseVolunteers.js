const express = require("express");
const supabase = require("../supabaseClient");
const { recordAudit } = require("../utils/auditLog");

const router = express.Router();

// GET /api/course-volunteers/counts?status=approved - number of volunteers per course, for the course list view
router.get("/counts", async (req, res) => {
  const { status } = req.query;

  let query = supabase.from("course_volunteers").select("course_id");
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  data.forEach((row) => {
    counts[row.course_id] = (counts[row.course_id] || 0) + 1;
  });
  res.json(counts);
});

// GET /api/course-volunteers?userId=... - a student's own applications, with course info attached
// GET /api/course-volunteers?courseId=... - everyone who has volunteered for a course, with student info attached
// GET /api/course-volunteers?status=open - every unclaimed overflow session across all courses, for students to browse
router.get("/", async (req, res) => {
  const { userId, courseId, status } = req.query;
  if (!userId && !courseId && !status) {
    return res
      .status(400)
      .json({ error: "userId, courseId or status is required" });
  }

  let query = supabase
    .from("course_volunteers")
    .select(
      "*, courses(course_code, course_name, department), users(name, email)",
    )
    .order("created_at", { ascending: false });

  if (userId) query = query.eq("user_id", userId);
  if (courseId) query = query.eq("course_id", courseId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/course-volunteers
//
// Two shapes share this table and this route, told apart by whether
// sessionDate is present:
//
// - Student volunteering for a whole course: {userId, courseId, mark}.
//   Self-reported mark below the course's min_mark is rejected outright
//   (nothing recorded); at or above it goes in as 'pending' for an
//   organiser to review later.
// - Organiser posting a specific overflow gap: {courseId, sessionDate,
//   startTime, endTime, venue, reason, organiserId}. No student attached
//   yet — status 'open' until someone claims it (see PATCH /:id/claim).
router.post("/", async (req, res) => {
  const { sessionDate } = req.body ?? {};
  if (sessionDate) return postOverflowSession(req, res);
  return postCourseApplication(req, res);
});

async function postOverflowSession(req, res) {
  const {
    courseId,
    sessionDate,
    startTime,
    endTime,
    venue,
    reason,
    organiserId,
  } = req.body ?? {};

  if (!courseId || !sessionDate || !startTime || !endTime) {
    return res.status(400).json({
      error: "courseId, sessionDate, startTime and endTime are required",
    });
  }

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("course_code")
    .eq("id", courseId)
    .single();

  if (courseError || !course) {
    return res.status(404).json({ error: "Course not found" });
  }

  const { data, error } = await supabase
    .from("course_volunteers")
    .insert({
      course_id: courseId,
      session_date: sessionDate,
      start_time: startTime,
      end_time: endTime,
      venue: venue || null,
      reason: reason || null,
      created_by: organiserId || null,
      status: "open",
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
}

async function postCourseApplication(req, res) {
  const { userId, courseId, mark } = req.body ?? {};

  if (!userId || !courseId) {
    return res.status(400).json({ error: "userId and courseId are required" });
  }

  const markNum = Number(mark);
  if (!Number.isInteger(markNum) || markNum < 0 || markNum > 100) {
    return res
      .status(400)
      .json({ error: "mark must be an integer between 0 and 100" });
  }

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("course_code, min_mark")
    .eq("id", courseId)
    .single();

  if (courseError || !course) {
    return res.status(404).json({ error: "Course not found" });
  }

  if (Number.isInteger(course.min_mark) && markNum < course.min_mark) {
    return res.status(403).json({
      error: `You need at least ${course.min_mark} for ${course.course_code} to volunteer — you entered ${markNum}.`,
    });
  }

  const { data, error } = await supabase
    .from("course_volunteers")
    .insert({
      user_id: userId,
      course_id: courseId,
      mark: markNum,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: `You've already volunteered for ${course.course_code}.`,
      });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
}

// PATCH /api/course-volunteers/:id/claim — a student claims an open overflow
// session. Only succeeds while the row is still open and unclaimed, so two
// students racing for the same gap can't both land it — whoever's update
// actually matches a row wins, the other gets a 409.
router.patch("/:id/claim", async (req, res) => {
  const { userId } = req.body ?? {};
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const { data, error } = await supabase
    .from("course_volunteers")
    .update({ user_id: userId, status: "pending" })
    .eq("id", req.params.id)
    .eq("status", "open")
    .select(
      "*, courses(course_code, course_name, department), users(name, email)",
    )
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return res.status(409).json({
        error: "This session was already claimed by someone else",
      });
    }
    // The same (user_id, course_id) unique constraint that stops a student
    // double-volunteering for a course also fires here if they already have
    // a blanket application for this course — one row per student per
    // course, whether it's a course-wide application or a claimed session.
    if (error.code === "23505") {
      return res.status(409).json({
        error: "You already have an application for this course",
      });
    }
    return res.status(500).json({ error: error.message });
  }

  await recordAudit({
    entityType: "course_volunteers",
    entityId: data.id,
    action: "claimed",
    actorId: userId,
    before: { status: "open" },
    after: { status: "pending", user_id: userId },
  });

  res.json(data);
});

const VALID_STATUSES = ["pending", "approved", "rejected"];

// PATCH /api/course-volunteers/:id — organiser approves/rejects/resets a volunteer.
// A rejection can carry a reason so the student isn't left with a silent
// status flip; reconsidering back to pending (or approving) clears any
// earlier rejection reason rather than leaving it stale on the row.
router.patch("/:id", async (req, res) => {
  const { status, reason, organiserId } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be pending, approved or rejected" });
  }

  const { data: existing, error: existingError } = await supabase
    .from("course_volunteers")
    .select("status")
    .eq("id", req.params.id)
    .single();

  if (existingError || !existing) {
    return res.status(404).json({ error: "Volunteer not found" });
  }

  const { data, error } = await supabase
    .from("course_volunteers")
    .update({
      status,
      reason: status === "rejected" ? (reason ?? null) : null,
    })
    .eq("id", req.params.id)
    .select(
      "*, courses(course_code, course_name, department), users(name, email)",
    )
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return res.status(404).json({ error: "Volunteer not found" });
    }
    return res.status(500).json({ error: error.message });
  }

  await recordAudit({
    entityType: "course_volunteers",
    entityId: data.id,
    action: status,
    actorId: organiserId ?? null,
    before: { status: existing.status },
    after: { status, reason: data.reason ?? null },
  });

  res.json(data);
});

// DELETE /api/course-volunteers?userId=...&courseId=... - withdraw
router.delete("/", async (req, res) => {
  const { userId, courseId } = req.query;
  if (!userId || !courseId) {
    return res.status(400).json({ error: "userId and courseId are required" });
  }

  const { data: existing } = await supabase
    .from("course_volunteers")
    .select("id, status")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .maybeSingle();

  const { error } = await supabase
    .from("course_volunteers")
    .delete()
    .eq("user_id", userId)
    .eq("course_id", courseId);

  if (error) return res.status(500).json({ error: error.message });

  if (existing) {
    await recordAudit({
      entityType: "course_volunteers",
      entityId: existing.id,
      action: "withdrawn",
      actorId: userId,
      before: { status: existing.status },
      after: null,
    });
  }

  res.status(204).end();
});

module.exports = router;
