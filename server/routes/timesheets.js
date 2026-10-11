const express = require("express");
const supabase = require("../supabaseClient");
const { getRatesMap } = require("./academicLevelRates");
const { notify } = require("./notificationHelpers");
const { dateError, monthOrDateError } = require("../utils/dateValidation");

const router = express.Router();

const VALID_STATUSES = ["pending", "approved", "rejected"];

// Timesheet periods are calendar months as of the monthly-timesheet change,
// so the `week_start` column (kept as-is — no schema migration) stores the
// period's first day, "YYYY-MM-01". Accepts a full date or a "YYYY-MM"
// picker value and normalises both.
function getMonthStart(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
}

// The last day of the month `monthStart` falls in — day 0 of the next month.
function getMonthEnd(monthStart) {
  const [y, m] = monthStart.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthStart.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

// Month-start + n months (n may be negative), landing on a month's first day.
function addMonths(monthStart, months) {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

// "September 2026" — how notifications name a period, matching the UI labels.
function formatMonth(monthStart) {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
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

// POST /api/timesheets — a tutor submits one month's logged hours for
// sign-off. weekStart is any date in the target month (the picker sends the
// first); it's normalised to that month's first day, which is what gets
// stored as the period key. The snapshot is derived from hour_entries here,
// not trusted from the client, so later edits to hour_entries can't
// retroactively change an already-submitted month. The table's
// (user_id, week_start) primary key guards against double-submitting the
// same month.
router.post("/", async (req, res) => {
  const { tutorId, weekStart } = req.body ?? {};

  if (!tutorId || !weekStart) {
    return res
      .status(400)
      .json({ error: "tutorId and weekStart are required" });
  }
  // The picker sends "YYYY-MM" and older callers a full date in the month —
  // either way it must be a real period. "2026-13-99" would otherwise be
  // normalised into an impossible month and only fail inside Postgres.
  const invalidWeekStart = monthOrDateError(weekStart, "weekStart");
  if (invalidWeekStart) {
    return res.status(400).json({ error: invalidWeekStart });
  }

  const monthStart = getMonthStart(weekStart);
  const monthEnd = getMonthEnd(monthStart);

  const { data: entries, error: entriesError } = await supabase
    .from("hour_entries")
    .select(
      "date, hours, start_time, end_time, task_type, subject, notes, verification_status",
    )
    .eq("user_id", tutorId)
    .gte("date", monthStart)
    .lte("date", monthEnd)
    .order("date");

  if (entriesError) {
    return res.status(500).json({ error: entriesError.message });
  }
  if (entries.length === 0) {
    return res
      .status(400)
      .json({ error: "No logged hours found for that month" });
  }

  const totalHours = entries.reduce((sum, e) => sum + Number(e.hours), 0);

  const { data, error } = await supabase
    .from("timesheets")
    .insert({
      user_id: tutorId,
      week_start: monthStart,
      status: "pending",
      total_hours: totalHours,
      entries_snapshot: entries,
    })
    .select()
    .single();

  if (error) {
    // Postgres unique/PK violation — a timesheet for this tutor+month already exists
    if (error.code === "23505") {
      return res.status(409).json({
        error: "You've already submitted a timesheet for that month",
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
    .select("id, name, student_number, email, academic_level")
    .in("id", tutorIds);

  if (tutorsError) return res.status(500).json({ error: tutorsError.message });

  const { ratesMap, error: ratesError } = await getRatesMap();
  if (ratesError) return res.status(500).json({ error: ratesError.message });

  const tutorById = new Map(tutors.map((t) => [t.id, t]));

  const escapeCsv = (value) => {
    const str = value == null ? "" : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const header = [
    "Tutor name",
    "Student number",
    "Email",
    "Month",
    "Hours",
    "Hourly rate",
    "Amount",
    "Approved at",
  ];

  const rows = timesheets.map((t) => {
    const tutor = tutorById.get(t.user_id);
    const rate =
      tutor?.academic_level != null
        ? (ratesMap[tutor.academic_level] ?? null)
        : null;
    const amount =
      rate != null ? (Number(t.total_hours) * Number(rate)).toFixed(2) : "";

    return [
      tutor?.name ?? "Unknown",
      tutor?.student_number ?? "",
      tutor?.email ?? "",
      // "YYYY-MM" — the month the timesheet covers.
      t.week_start.slice(0, 7),
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

// PATCH /api/timesheets/:userId/:weekStart — organiser approves/rejects a
// submission. A rejection must come with a reviewerNote explaining the
// correction (e.g. which hours look wrong) — approval's note is optional.
router.patch("/:userId/:weekStart", async (req, res) => {
  const { status, reviewerNote } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: "status must be pending, approved or rejected" });
  }
  if (status === "rejected" && !reviewerNote?.trim()) {
    return res
      .status(400)
      .json({ error: "A note is required to reject a timesheet" });
  }

  // The period key is a full date ("YYYY-MM-01", or a legacy weekly
  // Monday) — an impossible one would only fail as a database filter.
  const invalidWeekStart = dateError(req.params.weekStart, "weekStart");
  if (invalidWeekStart) {
    return res.status(400).json({ error: invalidWeekStart });
  }

  const { data, error } = await supabase
    .from("timesheets")
    .update({
      status,
      reviewed_at: status === "pending" ? null : new Date().toISOString(),
      reviewer_note: status === "pending" ? null : reviewerNote?.trim() || null,
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

  if (status === "approved" || status === "rejected") {
    const month = formatMonth(data.week_start);
    const message =
      status === "approved"
        ? `Your timesheet for ${month} was approved.`
        : `Your timesheet for ${month} was rejected: ${reviewerNote.trim()}`;

    notify(data.user_id, {
      type: "timesheet_status",
      message,
      relatedEntity: "timesheet",
      relatedId: data.week_start,
    }).catch((err) =>
      console.warn("Failed to notify about timesheet status:", err),
    );
  }

  res.json(data);
});

// GET /api/timesheets/due-reminder?tutorId=... — checks whether last
// calendar month's logged hours were never submitted, and if so, sends a
// one-time "timesheet due" notification. There's no scheduled job in this
// app, so this is checked (idempotently, via a lookup for a reminder already
// sent for that month) whenever the tutor's dashboard loads, rather than on
// a real timer.
router.get("/due-reminder", async (req, res) => {
  const { tutorId } = req.query;
  if (!tutorId) {
    return res.status(400).json({ error: "tutorId is required" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const lastMonthStart = addMonths(getMonthStart(today), -1);
  const lastMonthEnd = getMonthEnd(lastMonthStart);

  const [
    { data: entries, error: entriesError },
    { data: existingTimesheet, error: timesheetError },
  ] = await Promise.all([
    supabase
      .from("hour_entries")
      .select("id")
      .eq("user_id", tutorId)
      .gte("date", lastMonthStart)
      .lte("date", lastMonthEnd)
      .limit(1),
    supabase
      .from("timesheets")
      .select("user_id")
      .eq("user_id", tutorId)
      // Any period key within the month counts as submitted — including
      // rows left over from the old weekly scheme (a Monday date).
      .gte("week_start", lastMonthStart)
      .lte("week_start", lastMonthEnd)
      .limit(1)
      .maybeSingle(),
  ]);

  if (entriesError) {
    return res.status(500).json({ error: entriesError.message });
  }
  if (timesheetError) {
    return res.status(500).json({ error: timesheetError.message });
  }

  if (!entries?.length || existingTimesheet) {
    return res.json({ notified: false });
  }

  const { data: existingReminder, error: reminderError } = await supabase
    .from("notifications")
    .select("id")
    .eq("user_id", tutorId)
    .eq("type", "timesheet_due")
    .eq("related_id", lastMonthStart)
    .maybeSingle();

  if (reminderError) {
    return res.status(500).json({ error: reminderError.message });
  }
  if (existingReminder) {
    return res.json({ notified: false });
  }

  const { error: insertError } = await supabase.from("notifications").insert({
    user_id: tutorId,
    type: "timesheet_due",
    message: `You logged hours in ${formatMonth(lastMonthStart)} but haven't submitted a timesheet for it yet.`,
    related_entity: "timesheet",
    related_id: lastMonthStart,
    read: false,
  });

  if (insertError) {
    return res.status(500).json({ error: insertError.message });
  }
  res.json({ notified: true });
});

module.exports = router;
