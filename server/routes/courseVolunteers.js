const express = require("express");
const supabase = require("../supabaseClient");
const { notify } = require("./notificationHelpers");
const { fillUncoveredForCourse, reassignCoversOf } = require("./sessionCover");

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
      "*, courses(course_code, course_name, department, Day_of_tut, tutor_start_time, tutor_end_time, venues, Day_of_lab, lab_start_time, lab_end_time, lab_venues), users(name, email)",
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
  const { status, rejectionReason, approvalReason } = req.body ?? {};
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

  if (status === "approved" && (!approvalReason || !approvalReason.trim())) {
    return res
      .status(400)
      .json({ error: "A reason is required to approve a volunteer" });
  }

  const { data: existing, error: existingError } = await supabase
    .from("course_volunteers")
    .select("id, status, locked")
    .eq("id", req.params.id)
    .single();

  if (existingError || !existing) {
    return res.status(404).json({ error: "Volunteer not found" });
  }

  if (existing.locked) {
    return res.status(409).json({
      error: "This approval is locked and can't be reconsidered.",
    });
  }

  const wasApproved = existing.status === "approved";

  const { data, error } = await supabase
    .from("course_volunteers")
    .update({
      status,
      rejection_reason: status === "rejected" ? rejectionReason.trim() : null,
      approval_reason: status === "approved" ? approvalReason.trim() : null,
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

  if (status === "approved" || status === "rejected") {
    const courseLabel = data.courses?.course_code || "a course";
    const message =
      status === "approved"
        ? `You've been approved to volunteer for ${courseLabel}${data.courses?.course_name ? ` — ${data.courses.course_name}` : ""}.`
        : wasApproved
          ? `You've been removed from ${courseLabel} — you were previously approved to volunteer for it: ${rejectionReason.trim()}`
          : `Your application to volunteer for ${courseLabel} was rejected: ${rejectionReason.trim()}`;

    notify(data.user_id, {
      type: "volunteer_status",
      message,
      relatedEntity: "volunteer_application",
      relatedId: data.id,
    }).catch((err) =>
      console.warn("Failed to notify about volunteer status:", err),
    );
  }

  // Keep session covers in step: a newly approved volunteer can fill any
  // uncovered upcoming sessions, and one taken off the course hands theirs on.
  if (status === "approved" && !wasApproved) {
    fillUncoveredForCourse(data.course_id).catch((err) =>
      console.warn("Failed to fill uncovered sessions:", err),
    );
  } else if (wasApproved && status !== "approved") {
    reassignCoversOf(data.user_id, data.course_id).catch((err) =>
      console.warn("Failed to reassign session covers:", err),
    );
  }

  res.json(data);
});

// PATCH /api/course-volunteers/:id/lock — permanently lock an approved
// volunteer. This is intentionally one-way: there is no unlock. Once
// locked, PATCH /:id refuses any status change to this record, forever.
router.patch("/:id/lock", async (req, res) => {
  const { locked } = req.body ?? {};
  if (locked !== true) {
    return res.status(400).json({
      error: "locked must be true — locking is permanent and cannot be undone",
    });
  }

  const { data: existing, error: existingError } = await supabase
    .from("course_volunteers")
    .select("id, status, locked")
    .eq("id", req.params.id)
    .single();

  if (existingError || !existing) {
    return res.status(404).json({ error: "Volunteer not found" });
  }

  if (existing.locked) {
    return res
      .status(409)
      .json({ error: "This approval is already locked and cannot be changed" });
  }

  if (existing.status !== "approved") {
    return res
      .status(409)
      .json({ error: "Only an approved volunteer can be locked" });
  }

  const { data, error } = await supabase
    .from("course_volunteers")
    .update({ locked: true })
    .eq("id", req.params.id)
    .select(
      "*, courses(course_code, course_name, department), users(name, email)",
    )
    .single();

  if (error) {
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
