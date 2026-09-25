const express = require("express");
const supabase = require("../supabaseClient");
const { getRatesMap } = require("./academicLevelRates");

const router = express.Router();

// GET /api/hour-entries?userId=...
router.get("/", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  const { data, error } = await supabase
    .from("hour_entries")
    .select("*")
    .eq("user_id", userId)
    .order("date");

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/hour-entries
router.post("/", async (req, res) => {
  const {
    userId,
    date,
    hours,
    startTime,
    endTime,
    taskType,
    subject,
    notes,
    courseId,
  } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  const { data, error } = await supabase
    .from("hour_entries")
    .insert({
      user_id: userId,
      date,
      hours,
      start_time: startTime || null,
      end_time: endTime || null,
      task_type: taskType || "Tutoring",
      subject: subject || "",
      notes: notes || "",
      course_id: courseId || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/hour-entries/:id
router.put("/:id", async (req, res) => {
  const {
    date,
    hours,
    startTime,
    endTime,
    taskType,
    subject,
    notes,
    courseId,
  } = req.body;

  const { data, error } = await supabase
    .from("hour_entries")
    .update({
      date,
      hours,
      start_time: startTime || null,
      end_time: endTime || null,
      task_type: taskType || "Tutoring",
      subject: subject || "",
      notes: notes || "",
      course_id: courseId || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/hour-entries/report?from=YYYY-MM-DD&to=YYYY-MM-DD
// Aggregates logged Tutoring hours per (tutor, course), with cost computed
// from the hourly_rate for the tutor's academic_level, for the organiser's
// hours/budget report.
// hour_entries has no direct FK to tutors (only to users, which tutors
// happens to share a primary key with), so tutor details are fetched
// separately and merged here rather than relying on PostgREST embedding.
router.get("/report", async (req, res) => {
  const { from, to } = req.query;

  let query = supabase
    .from("hour_entries")
    .select(
      "user_id, course_id, hours, date, courses:course_id(course_code, course_name, budget)",
    )
    .eq("task_type", "Tutoring");

  if (from) query = query.gte("date", from);
  if (to) query = query.lte("date", to);

  const { data: entries, error: entriesError } = await query;
  if (entriesError) {
    return res.status(500).json({ error: entriesError.message });
  }

  const { data: tutors, error: tutorsError } = await supabase
    .from("tutors")
    .select("id, name, academic_level");
  if (tutorsError) {
    return res.status(500).json({ error: tutorsError.message });
  }
  const tutorsById = Object.fromEntries(tutors.map((t) => [t.id, t]));

  const { ratesMap, error: ratesError } = await getRatesMap();
  if (ratesError) {
    return res.status(500).json({ error: ratesError.message });
  }

  const linked = entries.filter((e) => e.course_id != null && e.courses);
  const unlinked = entries.filter((e) => e.course_id == null);

  const grouped = {};
  for (const entry of linked) {
    const key = `${entry.user_id}:${entry.course_id}`;
    if (!grouped[key]) {
      const tutor = tutorsById[entry.user_id];
      grouped[key] = {
        tutorId: entry.user_id,
        tutorName: tutor?.name || null,
        hourlyRate:
          tutor?.academic_level != null
            ? (ratesMap[tutor.academic_level] ?? null)
            : null,
        courseId: entry.course_id,
        courseCode: entry.courses.course_code,
        courseName: entry.courses.course_name,
        budget: entry.courses.budget,
        hours: 0,
      };
    }
    grouped[key].hours += Number(entry.hours);
  }

  const rows = Object.values(grouped).map((row) => ({
    ...row,
    cost: row.hourlyRate != null ? row.hours * row.hourlyRate : null,
  }));

  res.json({
    rows,
    // Surfaced so the report can flag hours that exist but aren't tied to
    // any course, rather than silently dropping them from the totals.
    unlinkedHours: unlinked.reduce((sum, e) => sum + Number(e.hours), 0),
    unlinkedEntryCount: unlinked.length,
  });
});

// DELETE /api/hour-entries/:id
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("hour_entries")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
