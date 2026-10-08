const express = require("express");
const supabase = require("../supabaseClient");
const { notify } = require("./notificationHelpers");
const { fillUncoveredForCourse, reassignCoversOf } = require("./sessionCover");
const { hasTranscript, storageFailure } = require("./transcriptStorage");
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

  // Schedule fields (Day_of_tut etc.) are included so the student dashboard
  // can show a whole-course approval's recurring weekly slot — otherwise a
  // volunteer approved for a whole course has no way to see when it is.
  let query = supabase
    .from("course_volunteers")
    .select(
      "*, courses(course_code, course_name, department, Day_of_tut, tutor_start_time, tutor_end_time, venues, Day_of_lab, lab_start_time, lab_end_time, lab_venues), users(name, email)",
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

  // An application needs a transcript on file for the organiser to review —
  // the upload section below this page's course boards provides it.
  const transcript = await hasTranscript(userId);
  if (transcript.error) {
    return storageFailure(res, transcript.error);
  }
  if (!transcript.has) {
    return res.status(403).json({
      error: "Please upload your transcript before applying.",
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
//
// Approving/un-approving a whole-course application bumps
// courses.no_of_tutors_assigned exactly the way approving a
// tutor_subject_preference application does — a course a volunteer just
// filled needs to actually look filled everywhere else that reads that
// count (the board's shortfall view, whole-school auto-allocate, and the
// student dashboard's "still needs tutors" filter), not just on this row.
// A claimed *session* is deliberately left out of this — it's one-off
// cover for a single date, not a change in the course's regular tutoring
// capacity, so it shouldn't make the course look more or less staffed.
router.patch("/:id", async (req, res) => {
  const { status, rejectionReason, approvalReason, organiserId } =
    req.body ?? {};
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
    .select("id, status, locked, course_id, session_date")
    .eq("id", req.params.id)
    .single();

  if (existingError || !existing) {
    return res.status(404).json({ error: "Volunteer not found" });
  }

  if (existing.locked) {
    return res.status(409).json({
      error: "This application is locked and can't be reconsidered.",
    });
  }

  const wasApproved = existing.status === "approved";
  const willBeApproved = status === "approved";

  if (!existing.session_date && wasApproved !== willBeApproved) {
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("no_of_tutors_assigned, tutors_needed")
      .eq("id", existing.course_id)
      .single();

    if (courseError || !course) {
      return res.status(404).json({ error: "Course not found" });
    }

    const next =
      (course.no_of_tutors_assigned ?? 0) + (willBeApproved ? 1 : -1);

    if (willBeApproved && next > course.tutors_needed) {
      return res
        .status(409)
        .json({ error: "This course already has all the tutors it needs" });
    }

    const { error: bumpError } = await supabase
      .from("courses")
      .update({ no_of_tutors_assigned: Math.max(next, 0) })
      .eq("id", existing.course_id);

    if (bumpError) return res.status(500).json({ error: bumpError.message });
  }

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

  await recordAudit({
    entityType: "course_volunteers",
    entityId: data.id,
    action: status,
    actorId: organiserId ?? null,
    before: { status: existing.status },
    after: {
      status,
      rejection_reason: data.rejection_reason ?? null,
      approval_reason: data.approval_reason ?? null,
    },
  });

  res.json(data);
});

// PATCH /api/course-volunteers/:id/lock — permanently lock an approved
// volunteer or a rejected application. This is intentionally one-way:
// there is no unlock. Once locked, PATCH /:id refuses any status change to
// this record, and DELETE / refuses to withdraw it — a locked rejection
// therefore can't be cleared, so the student can never volunteer for the
// course again.
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
    return res.status(409).json({
      error: "This application is already locked and cannot be changed",
    });
  }

  // A pending application still has an organiser's decision ahead of it —
  // locking is for recording a decision as final, not for freezing the
  // queue.
  if (existing.status !== "approved" && existing.status !== "rejected") {
    return res.status(409).json({
      error: "Only an approved or rejected application can be locked",
    });
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
//
// A plain course application (no session_date) is just deleted — nothing
// else refers to that row. A claimed session is different: the row IS the
// organiser's posted gap (session_date/start_time/end_time/venue/reason),
// so withdrawing from it deletes nothing and instead hands it back to the
// pool (status back to 'open', user_id cleared) so another student can
// claim the exact same gap, rather than the organiser silently losing it.
// If the row being withdrawn was an approved *whole-course* application,
// the course's assigned-tutor count is freed up too — same as withdrawing
// an approved tutor application does. A claimed session never bumped that
// count in the first place (see PATCH /:id above), so withdrawing one
// doesn't touch it either. A locked record can't be withdrawn at all — an
// organiser's lock (approval or rejection) is final, and for a rejection
// that's exactly what stops the student clearing it to volunteer again.
router.delete("/", async (req, res) => {
  const { userId, courseId } = req.query;
  if (!userId || !courseId) {
    return res.status(400).json({ error: "userId and courseId are required" });
  }

  const { data: existing } = await supabase
    .from("course_volunteers")
    .select("id, status, session_date, locked")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .maybeSingle();

  if (!existing) {
    return res.status(204).end();
  }

  if (existing.locked) {
    return res.status(409).json({
      error: "This application is locked and can't be withdrawn.",
    });
  }

  if (existing.status === "approved" && !existing.session_date) {
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("no_of_tutors_assigned")
      .eq("id", courseId)
      .single();

    if (courseError || !course) {
      return res.status(404).json({ error: "Course not found" });
    }

    const { error: bumpError } = await supabase
      .from("courses")
      .update({
        no_of_tutors_assigned: Math.max(
          (course.no_of_tutors_assigned ?? 0) - 1,
          0,
        ),
      })
      .eq("id", courseId);

    if (bumpError) return res.status(500).json({ error: bumpError.message });
  }

  if (existing.session_date) {
    const { error } = await supabase
      .from("course_volunteers")
      .update({ status: "open", user_id: null })
      .eq("id", existing.id);

    if (error) return res.status(500).json({ error: error.message });

    await recordAudit({
      entityType: "course_volunteers",
      entityId: existing.id,
      action: "unclaimed",
      actorId: userId,
      before: { status: existing.status },
      after: { status: "open" },
    });

    return res.status(204).end();
  }

  const { error } = await supabase
    .from("course_volunteers")
    .delete()
    .eq("id", existing.id);

  if (error) return res.status(500).json({ error: error.message });

  await recordAudit({
    entityType: "course_volunteers",
    entityId: existing.id,
    action: "withdrawn",
    actorId: userId,
    before: { status: existing.status },
    after: null,
  });

  res.status(204).end();
});

module.exports = router;
