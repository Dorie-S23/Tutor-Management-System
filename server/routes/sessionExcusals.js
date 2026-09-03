const express = require("express");
const supabase = require("../supabaseClient");
const { DAY_NAMES } = require("../dayNames");

const router = express.Router();

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/session-excusals?tutorId=... — a tutor's own excusals
// GET /api/session-excusals?courseId=... — everyone excused from a course
router.get("/", async (req, res) => {
  const { tutorId, courseId } = req.query;
  if (!tutorId && !courseId) {
    return res.status(400).json({ error: "tutorId or courseId is required" });
  }

  let query = supabase
    .from("session_excusals")
    .select("*, courses(course_code, course_name), tutors(name)")
    .order("session_date");

  if (tutorId) query = query.eq("tutor_id", tutorId);
  if (courseId) query = query.eq("course_id", courseId);

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/session-excusals — a tutor excuses themselves from one session
router.post("/", async (req, res) => {
  const { tutorId, courseId, sessionDate, reason } = req.body ?? {};

  if (!tutorId || !courseId || !sessionDate) {
    return res
      .status(400)
      .json({ error: "tutorId, courseId and sessionDate are required" });
  }

  if (sessionDate < todayStr()) {
    return res
      .status(400)
      .json({ error: "sessionDate can't be in the past" });
  }

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("course_code, Day_of_tut")
    .eq("id", courseId)
    .single();

  if (courseError || !course) {
    return res.status(404).json({ error: "Course not found" });
  }

  const sessionWeekday = new Date(`${sessionDate}T00:00:00Z`).getUTCDay();
  if (DAY_NAMES[sessionWeekday] !== course.Day_of_tut) {
    return res.status(400).json({
      error: `${course.course_code} doesn't meet on that day — its tutorial is on ${course.Day_of_tut || "an unset day"}.`,
    });
  }

  const { data: assignment, error: assignmentError } = await supabase
    .from("tutor_subject_preference")
    .select("id")
    .eq("tutor_id", tutorId)
    .eq("course_id", courseId)
    .eq("status", "approved")
    .maybeSingle();

  if (assignmentError) {
    return res.status(500).json({ error: assignmentError.message });
  }
  if (!assignment) {
    return res.status(403).json({
      error: "You can only excuse yourself from a course you're assigned to",
    });
  }

  const { data, error } = await supabase
    .from("session_excusals")
    .insert({
      tutor_id: tutorId,
      course_id: courseId,
      session_date: sessionDate,
      reason: reason || null,
    })
    .select("*, courses(course_code, course_name)")
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "You've already excused yourself from that session",
      });
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// DELETE /api/session-excusals/:id — undo an excusal
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("session_excusals")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
