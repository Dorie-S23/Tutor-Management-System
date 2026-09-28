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

  const courseLabel = course?.course_code ? ` for ${course.course_code}` : "";

  notify(existing.user_id, {
    type: "organiser_request",
    message:
      status === "approved"
        ? `Your organiser request${courseLabel} was approved — you can now sign in.`
        : `Your organiser request${courseLabel} was denied.`,
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
