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
    return res
      .status(400)
      .json({ error: "tutorId and weekStart are required" });
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

// GET /api/timesheets/payroll-export — CSV of every approved timesheet, ready
// for payroll: tutor identity, hours, rate and amount owed. Joins tutors
// separately (rather than a PostgREST embed) since timesheets only has an FK
// to users, even though tutors shares the same id. Read-only — doesn't mark
// anything as paid.
router.get("/payroll-export", async (req, res) => {
  const { data: timesheets, error: timesheetsError } = await supabase
    .from("timesheets")
    .select("user_id, week_start, total_hours, reviewed_at")
    .eq("status", "approved")
    .order("week_start");

  if (timesheetsError) {
    return res.status(500).json({ error: timesheetsError.message });
  }
  if (timesheets.length === 0) {
    return res.status(404).json({ error: "No approved timesheets to export" });
  }

  const tutorIds = [...new Set(timesheets.map((t) => t.user_id))];

  const { data: tutors, error: tutorsError } = await supabase
    .from("tutors")
    .select("id, name, student_number, email, hourly_rate")
    .in("id", tutorIds);

  if (tutorsError) return res.status(500).json({ error: tutorsError.message });

  const tutorById = new Map(tutors.map((t) => [t.id, t]));

  const escapeCsv = (value) => {
    const str = value == null ? "" : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const header = [
    "Tutor name",
    "Student number",
    "Email",
    "Week starting",
    "Hours",
    "Hourly rate",
    "Amount",
    "Approved at",
  ];

  const rows = timesheets.map((t) => {
    const tutor = tutorById.get(t.user_id);
    const rate = tutor?.hourly_rate;
    const amount =
      rate != null ? (Number(t.total_hours) * Number(rate)).toFixed(2) : "";

    return [
      tutor?.name ?? "Unknown",
      tutor?.student_number ?? "",
      tutor?.email ?? "",
      t.week_start,
      t.total_hours,
      rate ?? "",
      amount,
      t.reviewed_at ?? "",
    ];
  });

  const csv = [header, ...rows]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\r\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="payroll-export-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.send(csv);
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
