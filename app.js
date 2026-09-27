const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const authRoutes = require("./routes/auth");
const coursesRoutes = require("./server/routes/courses");
const tutorsRoutes = require("./server/routes/tutors");
const hourEntriesRoutes = require("./server/routes/hourEntries");
const courseVolunteersRoutes = require("./server/routes/courseVolunteers");
const tutorApplicationsRoutes = require("./server/routes/tutorApplications");
const timesheetsRoutes = require("./server/routes/timesheets");
const timesheetDisputesRoutes = require("./server/routes/timesheetDisputes");
const sessionExcusalsRoutes = require("./server/routes/sessionExcusals");
const notificationsRoutes = require("./server/routes/notifications");
const auditLogRoutes = require("./server/routes/auditLog");
const allocationDraftsRoutes = require("./server/routes/allocationDrafts");

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  },
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.supabase = supabase;
  next();
});

// Test route
app.get("/", (req, res) => {
  res.redirect("/html/login.html");
});

// Test Supabase connection
app.get("/api/test", async (req, res) => {
  const { data, error } = await supabase.from("users").select("*").limit(1);

  if (error) {
    return res.status(500).json({
      error: error.message,
    });
  }

  res.json({
    message: "Supabase connection successful",
    data: data,
  });
});

// Authentication routes
app.use("/api/auth", authRoutes);

// Course management routes
app.use("/api/courses", coursesRoutes);

// Tutor management routes
app.use("/api/tutors", tutorsRoutes);

// Student volunteer hour logging + course volunteering
app.use("/api/hour-entries", hourEntriesRoutes);
app.use("/api/course-volunteers", courseVolunteersRoutes);

// Tutor applications (tutor_subject_preference)
app.use("/api/tutor-applications", tutorApplicationsRoutes);

// Timesheet submission + organiser sign-off
app.use("/api/timesheets", timesheetsRoutes);

// Corrections and disputes raised against a reviewed timesheet
app.use("/api/timesheet-disputes", timesheetDisputesRoutes);

// Tutor self-excusal from a scheduled session
app.use("/api/session-excusals", sessionExcusalsRoutes);

// Per-user in-app notification feed
app.use("/api/notifications", notificationsRoutes);

// Full change history across allocation decisions
app.use("/api/audit-log", auditLogRoutes);

// Whole-school auto allocation drafts + publish/restore
app.use("/api/allocation-drafts", allocationDraftsRoutes);

module.exports = app;
