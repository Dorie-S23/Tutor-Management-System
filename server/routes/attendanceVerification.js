const express = require("express");
const supabase = require("../supabaseClient");
const { matchingSlotTypes } = require("./sessionSlots");
const {
  hasCourseAccess,
  courseScopeForOrganiser,
} = require("./organiserScope");
const { notify, formatShortDate } = require("./notificationHelpers");

const router = express.Router();

// Session attendance verification — the organiser's side of the feature.
// Every logged hour entry arrives here as 'pending'; an organiser for the
// entry's course confirms the tutor or volunteer actually attended
// ('verified'), or disputes the entry ('flagged', note required). Tutors
// and volunteers see the state on their own pages and are notified when it
// changes. See server/migrations/2026-10-10-hour-entry-verification.sql.

const VERIFICATION_STATUSES = ["pending", "verified", "flagged"];

// Fire-and-forget: tell the entry's owner what the organiser decided. A
// flagged entry is theirs to correct — a structural edit sends it back to
// the queue (see hourEntries.js PUT), which is how they respond.
async function notifyEntryOwner(entry, status) {
  let courseCode = entry.subject || null;
  if (entry.course_id != null) {
    const { data: course } = await supabase
      .from("courses")
      .select("course_code")
      .eq("id", entry.course_id)
      .maybeSingle();
    if (course?.course_code) courseCode = course.course_code;
  }

  const label = courseCode || "your module";
  const date = formatShortDate(entry.date);
  const message =
    status === "verified"
      ? `Your logged session for ${label} on ${date} was verified — your attendance is confirmed.`
      : `Your logged session for ${label} on ${date} was flagged by the organiser: ${entry.verification_note}.`;

  await notify(entry.user_id, {
    type: status === "verified" ? "attendance_verified" : "attendance_flagged",
    message,
    relatedEntity: "hour_entry",
    relatedId: entry.id,
  });
}

// GET /api/attendance-verification?organiserId=...&status=...
// The verification queue, newest sessions first, with the logger, course
// and Tutorial/Lab label stitched on. With an organiserId the queue is
// scoped to the courses that organiser may review (the super-organiser and
// grandfathered organisers see everything); without one it isn't scoped,
// matching the rest of this API's trust model.
router.get("/", async (req, res) => {
  const { organiserId, status } = req.query;

  if (status && !VERIFICATION_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be pending, verified or flagged" });
  }

  let scopeCourseIds;
  if (organiserId) {
    scopeCourseIds = await courseScopeForOrganiser(organiserId);
    if (scopeCourseIds === undefined) {
      return res
        .status(403)
        .json({ error: "Only organisers can review logged sessions" });
    }
    // A scoped organiser with no approved courses has an empty queue.
    if (Array.isArray(scopeCourseIds) && scopeCourseIds.length === 0) {
      return res.json([]);
    }
  }

  let query = supabase
    .from("hour_entries")
    .select("*")
    .order("date", { ascending: false });
  if (status) query = query.eq("verification_status", status);
  if (Array.isArray(scopeCourseIds)) {
    query = query.in("course_id", scopeCourseIds);
  }

  const { data: entries, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const rows = entries || [];
  const userIds = [...new Set(rows.map((e) => e.user_id).filter(Boolean))];
  const courseIds = [
    ...new Set(rows.map((e) => e.course_id).filter((id) => id != null)),
  ];

  // No FK embeds: hour_entries only has plain column FKs here and the
  // route stitched data separately elsewhere (see the report handler for
  // the same pattern), so users/courses are fetched with one query each
  // and merged in.
  const [usersRes, coursesRes] = await Promise.all([
    userIds.length
      ? supabase.from("users").select("id, name, email, role").in("id", userIds)
      : { data: [] },
    courseIds.length
      ? supabase
          .from("courses")
          .select(
            "id, course_code, course_name, Day_of_tut, tutor_start_time, tutor_end_time, venues, Day_of_lab, lab_start_time, lab_end_time, lab_venues",
          )
          .in("id", courseIds)
      : { data: [] },
  ]);
  if (usersRes.error)
    return res.status(500).json({ error: usersRes.error.message });
  if (coursesRes.error) {
    return res.status(500).json({ error: coursesRes.error.message });
  }

  const usersById = Object.fromEntries(
    (usersRes.data || []).map((user) => [user.id, user]),
  );
  const coursesById = Object.fromEntries(
    (coursesRes.data || []).map((course) => [course.id, course]),
  );

  res.json(
    rows.map((entry) => {
      const course = coursesById[entry.course_id];
      const [slotType] = course
        ? matchingSlotTypes(
            course,
            entry.date,
            entry.start_time,
            entry.end_time,
          )
        : [];
      const sessionType =
        slotType === "tutorial"
          ? "Tutorial"
          : slotType === "lab"
            ? "Lab"
            : null;
      const venue =
        slotType === "tutorial"
          ? course.venues
          : slotType === "lab"
            ? course.lab_venues
            : null;
      return {
        ...entry,
        user: usersById[entry.user_id] || null,
        course: course
          ? { course_code: course.course_code, course_name: course.course_name }
          : null,
        session_type: sessionType,
        venue: venue || null,
      };
    }),
  );
});

// PATCH /api/attendance-verification/:id — an organiser verifies or flags a
// logged session, or re-opens a decided one (status 'pending' clears the
// earlier call). Flagging requires a note explaining what's wrong; approval
// notes are optional. Only an organiser for the entry's course may review
// it.
router.patch("/:id", async (req, res) => {
  const { status, note, reviewerId } = req.body ?? {};
  if (!VERIFICATION_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be pending, verified or flagged" });
  }
  if (status === "flagged" && !note?.trim()) {
    return res
      .status(400)
      .json({ error: "A note is required to flag a logged session" });
  }
  if (!reviewerId) {
    return res.status(400).json({ error: "reviewerId is required" });
  }

  const { data: entry, error: entryError } = await supabase
    .from("hour_entries")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (entryError) return res.status(500).json({ error: entryError.message });
  if (!entry) {
    return res.status(404).json({ error: "Logged session not found" });
  }

  if (!(await hasCourseAccess(reviewerId, entry.course_id))) {
    return res.status(403).json({
      error: "Only an organiser for that course can verify its logged sessions",
    });
  }

  const reset = status === "pending";
  const { data, error } = await supabase
    .from("hour_entries")
    .update({
      verification_status: status,
      verified_by: reset ? null : reviewerId,
      verified_at: reset ? null : new Date().toISOString(),
      verification_note: reset ? null : note?.trim() || null,
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (!reset) {
    notifyEntryOwner(data, status).catch((err) =>
      console.warn("Failed to notify about attendance verification:", err),
    );
  }

  res.json(data);
});

module.exports = router;
