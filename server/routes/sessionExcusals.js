const express = require("express");
const supabase = require("../supabaseClient");
const { DAY_NAMES } = require("../dayNames");
const {
  EXCUSAL_SELECT,
  assignCover,
  declineCover,
  notifyCoverReleased,
  swapCandidates,
  requestSwap,
  withdrawSwap,
  respondToSwap,
} = require("./sessionCover");

const router = express.Router();

// Every excusal read (EXCUSAL_SELECT) comes back with its course's
// schedule, the excused tutor's name, the covering volunteer's name
// (`cover`, null when uncovered), and who they've asked to take over
// (`swap_to`, if anyone).

const SESSION_LABELS = { tutorial: "tutorial", lab: "lab" };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/session-excusals?tutorId=... — a tutor's own excusals
// GET /api/session-excusals?courseId=... — everyone excused from a course
// GET /api/session-excusals?coverUserId=... — sessions a volunteer is covering
// GET /api/session-excusals?swapToUserId=... — swap requests awaiting a volunteer's answer
router.get("/", async (req, res) => {
  const { tutorId, courseId, coverUserId, swapToUserId } = req.query;
  if (!tutorId && !courseId && !coverUserId && !swapToUserId) {
    return res.status(400).json({
      error: "tutorId, courseId, coverUserId or swapToUserId is required",
    });
  }

  let query = supabase
    .from("session_excusals")
    .select(EXCUSAL_SELECT)
    .order("session_date");

  if (tutorId) query = query.eq("tutor_id", tutorId);
  if (courseId) query = query.eq("course_id", courseId);
  if (coverUserId) query = query.eq("cover_user_id", coverUserId);
  if (swapToUserId) query = query.eq("swap_to_user_id", swapToUserId);

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/session-excusals — a tutor excuses themselves from one session
router.post("/", async (req, res) => {
  const { tutorId, courseId, sessionDate, sessionType, reason } =
    req.body ?? {};

  if (!tutorId || !courseId || !sessionDate) {
    return res
      .status(400)
      .json({ error: "tutorId, courseId and sessionDate are required" });
  }

  if (
    sessionType !== undefined &&
    sessionType !== null &&
    !SESSION_LABELS[sessionType]
  ) {
    return res
      .status(400)
      .json({ error: 'sessionType must be "tutorial" or "lab"' });
  }

  if (sessionDate < todayStr()) {
    return res.status(400).json({ error: "sessionDate can't be in the past" });
  }

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("course_code, Day_of_tut, Day_of_lab")
    .eq("id", courseId)
    .single();

  if (courseError || !course) {
    return res.status(404).json({ error: "Course not found" });
  }

  // A course may run a Tutorial, a Lab, or both. The excusal is for one of
  // them: the one the tutor named, or — for a client that doesn't send
  // sessionType — whichever one meets on that weekday.
  const sessionDays = { tutorial: course.Day_of_tut, lab: course.Day_of_lab };
  const sessionWeekday =
    DAY_NAMES[new Date(`${sessionDate}T00:00:00Z`).getUTCDay()];

  let resolvedType = sessionType || null;
  if (resolvedType) {
    if (!sessionDays[resolvedType]) {
      return res.status(400).json({
        error: `${course.course_code} doesn't have a ${SESSION_LABELS[resolvedType]}.`,
      });
    }
    if (sessionDays[resolvedType] !== sessionWeekday) {
      return res.status(400).json({
        error: `${course.course_code} doesn't meet on that day — its ${SESSION_LABELS[resolvedType]} is on ${sessionDays[resolvedType]}.`,
      });
    }
  } else {
    const matching = Object.keys(sessionDays).filter(
      (type) => sessionDays[type] === sessionWeekday,
    );
    if (matching.length === 0) {
      const meetingDays = Object.values(sessionDays).filter(Boolean);
      return res.status(400).json({
        error: `${course.course_code} doesn't meet on that day — it meets on ${meetingDays.join(" and ") || "an unset day"}.`,
      });
    }
    if (matching.length > 1) {
      return res.status(400).json({
        error: `${course.course_code} has both a tutorial and a lab that day — say which one (sessionType).`,
      });
    }
    resolvedType = matching[0];
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
      session_type: resolvedType,
      reason: reason || null,
    })
    .select(EXCUSAL_SELECT)
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "You've already excused yourself from that session",
      });
    }
    return res.status(500).json({ error: error.message });
  }

  // Put a volunteer in to cover it straight away. Best-effort: the excusal
  // itself is already saved, so a failure here only leaves it uncovered
  // (the organiser can retry with "Find cover").
  let result = data;
  try {
    result = (await assignCover(data.id)) || data;
  } catch (err) {
    console.warn("Failed to assign a cover for excusal:", err);
  }
  res.status(201).json(result);
});

// POST /api/session-excusals/:id/find-cover — organiser (re)runs the
// automatic cover assignment. If someone is already covering, they're
// released and the next best volunteer is picked instead.
router.post("/:id/find-cover", async (req, res) => {
  const { data: excusal, error } = await supabase
    .from("session_excusals")
    .select(EXCUSAL_SELECT)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!excusal) return res.status(404).json({ error: "Excusal not found" });
  if (excusal.session_date < todayStr()) {
    return res.status(409).json({ error: "That session has already happened" });
  }

  const previous = excusal.cover_user_id;
  try {
    if (previous) {
      notifyCoverReleased(
        excusal,
        previous,
        "the organiser reassigned it to someone else",
      );
    }
    const updated = await assignCover(excusal.id, {
      excludeUserIds: previous ? [previous] : [],
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session-excusals/:id/decline-cover — the covering volunteer
// can't make it; it's handed to the next volunteer in line.
router.post("/:id/decline-cover", async (req, res) => {
  const { userId } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: "userId is required" });

  try {
    const result = await declineCover(req.params.id, userId);
    if (result.error === "not_found") {
      return res.status(404).json({ error: "Excusal not found" });
    }
    if (result.error === "not_cover") {
      return res
        .status(403)
        .json({ error: "You're not the one covering that session" });
    }
    res.json(result.excusal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- volunteer-to-volunteer swaps ----------

const SWAP_STATUS = { not_found: 404, forbidden: 403, conflict: 409 };

function sendSwapResult(res, result) {
  if (result.error) {
    return res
      .status(SWAP_STATUS[result.error] || 400)
      .json({ error: result.message });
  }
  res.json(result.excusal);
}

// GET /api/session-excusals/:id/swap-candidates?userId=... — who the
// covering volunteer could ask to take their session over.
router.get("/:id/swap-candidates", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    const result = await swapCandidates(req.params.id, userId);
    if (result.error) return sendSwapResult(res, result);
    res.json(result.candidates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session-excusals/:id/swap-request — { userId, toUserId }: the
// covering volunteer asks a specific other volunteer to take over.
router.post("/:id/swap-request", async (req, res) => {
  const { userId, toUserId } = req.body ?? {};
  if (!userId || !toUserId) {
    return res.status(400).json({ error: "userId and toUserId are required" });
  }
  try {
    sendSwapResult(res, await requestSwap(req.params.id, userId, toUserId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session-excusals/:id/swap-withdraw — { userId }: the requester
// takes back a swap request that hasn't been answered yet.
router.post("/:id/swap-withdraw", async (req, res) => {
  const { userId } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    sendSwapResult(res, await withdrawSwap(req.params.id, userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session-excusals/:id/swap-respond — { userId, accept }: the
// asked volunteer takes the session over, or turns it down.
router.post("/:id/swap-respond", async (req, res) => {
  const { userId, accept } = req.body ?? {};
  if (!userId || typeof accept !== "boolean") {
    return res
      .status(400)
      .json({ error: "userId and accept (true/false) are required" });
  }
  try {
    sendSwapResult(res, await respondToSwap(req.params.id, userId, accept));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/session-excusals/:id — undo an excusal. Whoever was covering
// it is told they're no longer needed.
router.delete("/:id", async (req, res) => {
  const { data: excusal } = await supabase
    .from("session_excusals")
    .select(EXCUSAL_SELECT)
    .eq("id", req.params.id)
    .maybeSingle();

  const { error } = await supabase
    .from("session_excusals")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });

  if (excusal?.cover_user_id && excusal.session_date >= todayStr()) {
    notifyCoverReleased(
      excusal,
      excusal.cover_user_id,
      `${excusal.tutors?.name || "the tutor"} can make it after all`,
    );
  }
  res.status(204).end();
});

module.exports = router;
