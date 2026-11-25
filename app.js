const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const authRoutes = require("./routes/auth");
const coursesRoutes = require("./server/routes/courses");
const publicApiRoutes = require("./server/routes/publicApi");
const courseDiagonalsRoutes = require("./server/routes/courseDiagonals");
const tutorsRoutes = require("./server/routes/tutors");
const hourEntriesRoutes = require("./server/routes/hourEntries");
const attendanceVerificationRoutes = require("./server/routes/attendanceVerification");
const courseVolunteersRoutes = require("./server/routes/courseVolunteers");
const tutorApplicationsRoutes = require("./server/routes/tutorApplications");
const timesheetsRoutes = require("./server/routes/timesheets");
const timesheetDisputesRoutes = require("./server/routes/timesheetDisputes");
const organiserRequestsRoutes = require("./server/routes/organiserRequests");
const sessionExcusalsRoutes = require("./server/routes/sessionExcusals");
const notificationsRoutes = require("./server/routes/notifications");
const auditLogRoutes = require("./server/routes/auditLog");
const allocationDraftsRoutes = require("./server/routes/allocationDrafts");
const profileRoutes = require("./server/routes/profile");
const profileTimetableRoutes = require("./server/routes/profileTimetable");
const timetableRoutes = require("./server/routes/timetable");
const transcriptRoutes = require("./server/routes/transcripts");

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

// Public read-only API for external consumers (course catalogue)
app.use("/api/v1", publicApiRoutes);

// Splitting a large course's tutors and volunteers into diagonals (A, B, C…)
app.use("/api/courses/:courseId/diagonals", courseDiagonalsRoutes);

// Tutor management routes
app.use("/api/tutors", tutorsRoutes);

// Student volunteer hour logging + course volunteering
app.use("/api/hour-entries", hourEntriesRoutes);

// Organiser verification of logged session attendance (tutorials/labs)
app.use("/api/attendance-verification", attendanceVerificationRoutes);

app.use("/api/course-volunteers", courseVolunteersRoutes);

// Tutor applications (tutor_subject_preference)
app.use("/api/tutor-applications", tutorApplicationsRoutes);

// Timesheet submission + organiser sign-off
app.use("/api/timesheets", timesheetsRoutes);

// Corrections and disputes raised against a reviewed timesheet
app.use("/api/timesheet-disputes", timesheetDisputesRoutes);

// Organiser course-access requests, reviewed by the super-organiser
app.use("/api/organiser-requests", organiserRequestsRoutes);

// Tutor self-excusal from a scheduled session
app.use("/api/session-excusals", sessionExcusalsRoutes);

// Per-user in-app notification feed
app.use("/api/notifications", notificationsRoutes);

// Timetable PDF reading (Google Gemini — see public/js/timetable-parser.js)
app.use("/api/timetable", timetableRoutes);

// Applicant transcript upload + signed-URL viewing (Supabase Storage)
app.use("/api/transcripts", transcriptRoutes);

// Full change history across allocation decisions
app.use("/api/audit-log", auditLogRoutes);

// Whole-school auto allocation drafts + publish/restore
app.use("/api/allocation-drafts", allocationDraftsRoutes);

// Self-service profile for tutors and student volunteers
app.use("/api/profile", profileRoutes);
// The timetable PDF kept on that profile page (Supabase Storage)
app.use("/api/profile/:userId/timetable", profileTimetableRoutes);

module.exports = app;
