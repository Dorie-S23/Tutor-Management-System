const express = require("express");
const supabase = require("../supabaseClient");

const router = express.Router();

const VALID_STATUSES = ["pending", "approved", "rejected"];

// "YYYY-MM-DD" + N days -> "YYYY-MM-DD", using UTC so there's no DST edge case
// in pure date-string arithmetic (unlike public/js/storage.js's local-time
// version, which exists for calendar *display*, not server-side math).
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// GET /api/timesheets?tutorId=... — a tutor's own submissions
// GET /api/timesheets?status=pending — organiser review queue (any status filter)
router.get("/", async (req, res) => {
  const { tutorId, status } = req.query;

  let query = supabase
    .from("timesheets")
    .select("*, users(name, email)")
    .order("week_start", { ascending: false });

  if (tutorId) query = query.eq("user_id", tutorId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/timesheets — a tutor submits one week's logged hours for sign-off.
// weekStart is the Monday of that week (matches public/js/storage.js's
// getWeekStart). The snapshot is derived from hour_entries here, not trusted
// from the client, so later edits to hour_entries can't retroactively change
// an already-submitted week. The table's (user_id, week_start) primary key
// guards against double-submitting the same week.
router.post("/", async (req, res) => {
  const { tutorId, weekStart } = req.body ?? {};

  if (!tutorId || !weekStart) {
    return res.status(400).json({ error: "tutorId and weekStart are required" });
  }

  const weekEnd = addDays(weekStart, 6);

  const { data: entries, error: entriesError } = await supabase
    .from("hour_entries")
    .select("date, hours, start_time, end_time, task_type, subject, notes")
    .eq("user_id", tutorId)
    .gte("date", weekStart)
    .lte("date", weekEnd)
    .order("date");

  if (entriesError) {
    return res.status(500).json({ error: entriesError.message });
  }
  if (entries.length === 0) {
    return res
      .status(400)
      .json({ error: "No logged hours found for that week" });
  }

  const totalHours = entries.reduce((sum, e) => sum + Number(e.hours), 0);

  const { data, error } = await supabase
    .from("timesheets")
    .insert({
      user_id: tutorId,
      week_start: weekStart,
      status: "pending",
      total_hours: totalHours,
      entries_snapshot: entries,
    })
    .select()
    .single();

  if (error) {
    // Postgres unique/PK violation — a timesheet for this tutor+week already exists
    if (error.code === "23505") {
      return res.status(409).json({
        error: "You've already submitted a timesheet for that week",
      });
    }
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json(data);
});

// PATCH /api/timesheets/:userId/:weekStart — organiser approves/rejects a submission
router.patch("/:userId/:weekStart", async (req, res) => {
  const { status } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be pending, approved or rejected" });
  }

  const { data, error } = await supabase
    .from("timesheets")
    .update({
      status,
      reviewed_at: status === "pending" ? null : new Date().toISOString(),
    })
    .eq("user_id", req.params.userId)
    .eq("week_start", req.params.weekStart)
    .select("*, users(name, email)")
    .single();

  if (error) {
    if (error.code === "PGRST116")
      return res.status(404).json({ error: "Timesheet not found" });
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

module.exports = router;
