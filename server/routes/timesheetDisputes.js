const express = require("express");
const supabase = require("../supabaseClient");

const router = express.Router();

// GET /api/timesheet-disputes?raisedBy=... — a tutor's own disputes
// GET /api/timesheet-disputes?resolved=false — organiser queue of open disputes
// GET /api/timesheet-disputes?timesheetUserId=...&weekStart=... — disputes for one timesheet
router.get("/", async (req, res) => {
  const { raisedBy, timesheetUserId, weekStart, resolved } = req.query;

  let query = supabase
    .from("timesheet_disputes")
    .select("*, users(name, email)")
    .order("created_at", { ascending: false });

  if (raisedBy) query = query.eq("raised_by", raisedBy);
  if (timesheetUserId) query = query.eq("timesheet_user_id", timesheetUserId);
  if (weekStart) query = query.eq("timesheet_week_start", weekStart);
  if (resolved !== undefined) query = query.eq("resolved", resolved === "true");

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/timesheet-disputes — a tutor disputes a timesheet that's already
// been reviewed (approved or rejected). Raising a dispute doesn't change the
// timesheet's own status — an organiser resolves it separately.
router.post("/", async (req, res) => {
  const { timesheetUserId, timesheetWeekStart, raisedBy, message } =
    req.body ?? {};

  if (
    !timesheetUserId ||
    !timesheetWeekStart ||
    !raisedBy ||
    !message?.trim()
  ) {
    return res.status(400).json({
      error:
        "timesheetUserId, timesheetWeekStart, raisedBy and message are required",
    });
  }

  const { data: timesheet, error: timesheetError } = await supabase
    .from("timesheets")
    .select("status")
    .eq("user_id", timesheetUserId)
    .eq("week_start", timesheetWeekStart)
    .single();

  if (timesheetError || !timesheet) {
    return res.status(404).json({ error: "Timesheet not found" });
  }
  if (timesheet.status === "pending") {
    return res.status(400).json({
      error:
        "This timesheet hasn't been reviewed yet — there's nothing to dispute",
    });
  }

  const { data, error } = await supabase
    .from("timesheet_disputes")
    .insert({
      timesheet_user_id: timesheetUserId,
      timesheet_week_start: timesheetWeekStart,
      raised_by: raisedBy,
      message: message.trim(),
      resolved: false,
    })
    .select("*, users(name, email)")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/timesheet-disputes/:id/resolve — organiser marks a dispute resolved.
// One-directional: a resolved dispute can't be reopened through this route, so
// a tutor still unhappy with the outcome raises a fresh dispute instead.
router.patch("/:id/resolve", async (req, res) => {
  const { data: existing, error: fetchError } = await supabase
    .from("timesheet_disputes")
    .select("resolved")
    .eq("id", req.params.id)
    .single();

  if (fetchError || !existing) {
    return res.status(404).json({ error: "Dispute not found" });
  }
  if (existing.resolved) {
    return res.status(409).json({ error: "This dispute is already resolved" });
  }

  const { data, error } = await supabase
    .from("timesheet_disputes")
    .update({ resolved: true })
    .eq("id", req.params.id)
    .select("*, users(name, email)")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
