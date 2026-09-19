const express = require("express");
const supabase = require("../supabaseClient");

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
router.get("/", async (req, res) => {
  const { userId, courseId } = req.query;
  if (!userId && !courseId) {
    return res.status(400).json({ error: "userId or courseId is required" });
  }

  let query = supabase
    .from("course_volunteers")
    .select(
      "*, courses(course_code, course_name, department), users(name, email)",
    )
    .order("created_at", { ascending: false });

  if (userId) query = query.eq("user_id", userId);
  if (courseId) query = query.eq("course_id", courseId);

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/course-volunteers - volunteer for a course, self-reporting a mark.
// Below the course's min_mark is rejected outright (nothing recorded); at or
// above it goes in as 'pending' for an organiser to review later.
router.post("/", async (req, res) => {
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
});

const VALID_STATUSES = ["pending", "approved", "rejected"];

// PATCH /api/course-volunteers/:id — organiser approves/rejects/resets a volunteer
router.patch("/:id", async (req, res) => {
  const { status, rejectionReason } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be pending, approved or rejected" });
  }

  if (status === "rejected" && (!rejectionReason || !rejectionReason.trim())) {
    return res
      .status(400)
      .json({ error: "A reason is required to reject a volunteer" });
  }

  const { data, error } = await supabase
    .from("course_volunteers")
    .update({
      status,
      rejection_reason: status === "rejected" ? rejectionReason.trim() : null,
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

  res.json(data);
});

// DELETE /api/course-volunteers?userId=...&courseId=... - withdraw
router.delete("/", async (req, res) => {
  const { userId, courseId } = req.query;
  if (!userId || !courseId) {
    return res.status(400).json({ error: "userId and courseId are required" });
  }

  const { error } = await supabase
    .from("course_volunteers")
    .delete()
    .eq("user_id", userId)
    .eq("course_id", courseId);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
