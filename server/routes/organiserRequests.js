const express = require("express");
const supabase = require("../supabaseClient");
const { notify } = require("./notificationHelpers");

const router = express.Router();

// The one account allowed to review requests — users.role =
// "super_organiser", promoted by hand in Supabase (see Getting Started).
// There's no auth middleware in this app, so the caller passes the
// reviewer's user id and this check decides whether that id qualifies.
async function loadSuperOrganiser(reviewerId) {
  if (!reviewerId) return null;

  const { data, error } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", reviewerId)
    .maybeSingle();

  if (error || !data) return null;
  return data.role === "super_organiser" ? data : null;
}

// GET /api/organiser-requests/mine?userId=... — the caller's own request
// rows (course_id + status), so the board can mark a locked course whose
// access request is already pending instead of offering a duplicate.
router.get("/mine", async (req, res) => {
  const userId = req.query.userId;

  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (!user) {
    return res.status(403).json({ error: "Unknown user" });
  }

  const { data: rows, error } = await supabase
    .from("organiser_requests")
    .select("course_id, status")
    .eq("user_id", userId);

  if (error) return res.status(500).json({ error: error.message });

  res.json(rows || []);
});

// POST /api/organiser-requests — an existing organiser asks for access to
// one more course ("additional access"). Filed in the same organiser_requests
// table as sign-up requests, tagged kind = 'access' so the review page can
// list the two queues separately. The caller is the requester (this app's
// routes trust a caller-passed user id — same pattern as the review
// endpoints below).
router.post("/", async (req, res) => {
  const { userId, courseId } = req.body ?? {};

  const { data: user } = userId
    ? await supabase
        .from("users")
        .select("id, name, role")
        .eq("id", userId)
        .maybeSingle()
    : { data: null };

  // Only a plain organiser can ask — the super-organiser already sees every
  // course, so a request from them would be noise.
  if (!user || user.role !== "organiser") {
    return res.status(403).json({
      error: "Only an organiser can request access to a course",
    });
  }

  const courseIdNum = Number(courseId);
  if (!Number.isInteger(courseIdNum) || courseIdNum <= 0) {
    return res.status(400).json({ error: "A valid course id is required" });
  }

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("id, course_code")
    .eq("id", courseIdNum)
    .maybeSingle();

  if (courseError) return res.status(500).json({ error: courseError.message });
  if (!course)
    return res.status(404).json({ error: "That course does not exist" });

  const { data: existingRows, error: rowsError } = await supabase
    .from("organiser_requests")
    .select("id, status")
    .eq("user_id", user.id)
    .eq("course_id", courseIdNum);

  if (rowsError) return res.status(500).json({ error: rowsError.message });

  const rows = existingRows || [];

  if (rows.some((row) => row.status === "approved")) {
    return res.status(409).json({
      error: "You already have access to that course",
      status: "approved",
    });
  }

  if (rows.some((row) => row.status === "pending")) {
    return res.status(409).json({
      error: "A request for that course is already awaiting review",
      status: "pending",
    });
  }

  const denied = rows.find((row) => row.status === "denied");

  let row;
  let created = false;

  if (denied) {
    // A fresh ask — put the denied row back in the queue rather than
    // stacking a second request for the same course.
    const { data, error } = await supabase
      .from("organiser_requests")
      .update({
        status: "pending",
        kind: "access",
        created_at: new Date().toISOString(),
        reviewed_at: null,
        reviewed_by: null,
      })
      .eq("id", denied.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    row = data;
  } else {
    const { data, error } = await supabase
      .from("organiser_requests")
      .insert({
        user_id: user.id,
        course_id: courseIdNum,
        status: "pending",
        kind: "access",
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    row = data;
    created = true;
  }

  // Tell every super-organiser there's something new to review —
  // fire-and-forget, so a notification hiccup can't fail the request.
  supabase
    .from("users")
    .select("id")
    .eq("role", "super_organiser")
    .then(({ data: supers }) => {
      (supers || []).forEach((superRow) =>
        notify(superRow.id, {
          type: "organiser_request",
          message: `${user.name || "An organiser"} requested access to ${course.course_code} (additional access).`,
          relatedEntity: "organiser_request",
          relatedId: row.id,
        }).catch(() => {}),
      );
    });

  res.status(created ? 201 : 200).json(row);
});

// GET /api/organiser-requests?reviewerId=... — the review queue: every
// request, newest first, with the requester and course stitched on.
router.get("/", async (req, res) => {
  const reviewer = await loadSuperOrganiser(req.query.reviewerId);

  if (!reviewer) {
    return res.status(403).json({
      error: "Only the super-organiser can review organiser requests",
    });
  }

  const { data: requests, error } = await supabase
    .from("organiser_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const rows = requests || [];

  // Stitch the requester and course on — this repo's routes (and its test
  // fake) treat embedded joins as plain fields, so do the lookups directly.
  const userIds = [...new Set(rows.map((row) => row.user_id))];
  const courseIds = [...new Set(rows.map((row) => row.course_id))];

  const [{ data: users }, { data: courses }] = await Promise.all([
    userIds.length
      ? supabase.from("users").select("id, name, email").in("id", userIds)
      : Promise.resolve({ data: [] }),
    courseIds.length
      ? supabase
          .from("courses")
          .select("id, course_code, course_name")
          .in("id", courseIds)
      : Promise.resolve({ data: [] }),
  ]);

  const userById = new Map((users || []).map((user) => [user.id, user]));
  const courseById = new Map(
    (courses || []).map((course) => [course.id, course]),
  );

  res.json(
    rows.map((row) => ({
      ...row,
      user: userById.get(row.user_id) || null,
      course: courseById.get(row.course_id) || null,
    })),
  );
});

// Shared by approve/deny: both amount to flipping a pending request to a
// final status, stamping who reviewed it. Only pending requests can be
// reviewed — a second click (or a stale page) gets a 409, not a rewrite.
async function reviewRequest(req, res, status) {
  const reviewer = await loadSuperOrganiser(req.body?.reviewerId);

  if (!reviewer) {
    return res.status(403).json({
      error: "Only the super-organiser can review organiser requests",
    });
  }

  const requestId = Number(req.params.id);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(404).json({ error: "Request not found" });
  }

  const { data: existing, error: fetchError } = await supabase
    .from("organiser_requests")
    .select("id, user_id, course_id, status")
    .eq("id", requestId)
    .single();

  if (fetchError || !existing) {
    return res.status(404).json({ error: "Request not found" });
  }

  if (existing.status !== "pending") {
    return res.status(409).json({
      error: "This request has already been reviewed",
    });
  }

  const { data: updated, error } = await supabase
    .from("organiser_requests")
    .update({
      status,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewer.id,
    })
    .eq("id", requestId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Tell the requester their fate — fire-and-forget like every other
  // notifier in the app, so a notification hiccup can't fail the review.
  const { data: course } = await supabase
    .from("courses")
    .select("course_code")
    .eq("id", existing.course_id)
    .maybeSingle();

  const courseCode = course?.course_code || null;
  const courseLabel = courseCode ? ` for ${courseCode}` : "";
  const access = existing.kind === "access";

  // Sign-up approvals unblock sign-in; additional-access approvals add a
  // course to an organiser's scope, which their session picks up next login.
  const message =
    status === "approved"
      ? access
        ? `Your request for access to ${courseCode || "that course"} was approved — sign in again to pick it up.`
        : `Your organiser request${courseLabel} was approved — you can now sign in.`
      : access
        ? `Your request for access to ${courseCode || "that course"} was denied.`
        : `Your organiser request${courseLabel} was denied.`;

  notify(existing.user_id, {
    type: "organiser_request",
    message,
    relatedEntity: "organiser_request",
    relatedId: existing.id,
  }).catch(() => {});

  res.json(updated);
}

// POST /api/organiser-requests/:id/approve — grants the organiser access to
// the course they asked for; they can sign in from then on.
router.post("/:id/approve", (req, res) => reviewRequest(req, res, "approved"));

// POST /api/organiser-requests/:id/deny — turns the request down; the
// account stays blocked at sign-in.
router.post("/:id/deny", (req, res) => reviewRequest(req, res, "denied"));

module.exports = router;
