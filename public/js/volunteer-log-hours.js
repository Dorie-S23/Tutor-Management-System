// Volunteer "Log attendance": pick an assigned module (one you've been
// approved to volunteer for), pick one of its upcoming organiser-scheduled
// sessions, then submit what actually happened (starting/ending time +
// notes). Submissions land in the same hour_entries store the tutor Log
// Hours page uses, tagged "Peer support" so the volunteer timesheet reads
// them back by week.

import { addEntry, findDuplicateEntry, requireRole } from "./storage.js";
import { highlightActiveTab } from "./nav.js";

const currentUser = requireRole("volunteer");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday, matching
// JS Date.getDay().
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const CHIP_ACCENTS = [
  "chip-icon--blue",
  "chip-icon--violet",
  "chip-icon--teal",
  "chip-icon--amber",
];

const MODULE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5.5 6.7 12 10.4l6.5-3.7L12 3Z"/><path d="m7.5 9 4.5 2.6L16.5 9v5L12 16.6 7.5 14V9Z"/><path d="M18.5 7v5"/></svg>`;
const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

const courseChipsEl = document.getElementById("courseChips");
const sessionStepEl = document.getElementById("sessionStep");
const sessionChipsEl = document.getElementById("sessionChips");
const attendanceCardEl = document.getElementById("attendanceCard");
const scheduledWhenEl = document.getElementById("scheduledWhen");
const scheduledVenueEl = document.getElementById("scheduledVenue");
const form = document.getElementById("attendance-form");
const startTimeField = document.getElementById("startTime");
const endTimeField = document.getElementById("endTime");
const notesField = document.getElementById("notes");
const formError = document.getElementById("form-error");
const durationValueEl = document.getElementById("duration-value");
const submitBtn = document.getElementById("submit-btn");

let selectedCourse = null;
let selectedSession = null;

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function sliceTime(time) {
  return (time || "").slice(0, 5);
}

// The next few occurrences of a course's weekly Tutorial/Lab, soonest
// first — the "sessions the organiser scheduled" a volunteer can attend.
function upcomingSessions(course, count = 4) {
  const definitions = [
    {
      type: "Tutorial",
      day: course.Day_of_tut,
      start: course.tutor_start_time,
      end: course.tutor_end_time,
      venue: course.venues,
    },
    {
      type: "Lab",
      day: course.Day_of_lab,
      start: course.lab_start_time,
      end: course.lab_end_time,
      venue: course.lab_venues,
    },
  ].filter((s) => s.day && s.start && s.end);

  const now = new Date();
  const nowHHMM = now.toTimeString().slice(0, 5);
  const occurrences = [];

  definitions.forEach((definition) => {
    const targetIdx = DAY_NAMES.indexOf(definition.day);
    if (targetIdx === -1) return;
    for (let week = 0; week < count; week += 1) {
      const days = ((targetIdx - now.getDay() + 7) % 7) + week * 7;
      // Today's session only counts while it hasn't ended yet.
      if (week === 0 && days === 0 && sliceTime(definition.end) <= nowHHMM) {
        continue;
      }
      const date = new Date(now);
      date.setDate(date.getDate() + days);
      occurrences.push({ ...definition, date });
    }
  });

  return occurrences.sort((a, b) => a.date - b.date).slice(0, count);
}

// ---------- logged duration (sidebar) ----------

function computeHours() {
  const start = startTimeField.value;
  const end = endTimeField.value;
  if (!start || !end) return null;
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const hours = (endH * 60 + endM - (startH * 60 + startM)) / 60;
  return hours > 0 ? hours : null;
}

function updateDuration() {
  const hours = computeHours();
  durationValueEl.textContent = hours ? `${Number(hours.toFixed(1))}h` : "—";
}

startTimeField.addEventListener("input", updateDuration);
endTimeField.addEventListener("input", updateDuration);

// ---------- chips ----------

function renderCourseChips(courses) {
  courseChipsEl.innerHTML = "";

  if (courses.length === 0) {
    courseChipsEl.innerHTML = `<p class="empty-state">You're not assigned to any modules yet — apply for one and it will show up here.</p>`;
    return;
  }

  courses.forEach((course, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "course-chip";
    chip.innerHTML = `
      <span class="chip-icon ${CHIP_ACCENTS[index % CHIP_ACCENTS.length]}">${MODULE_ICON}</span>
      <span class="course-chip__text">
        <span class="course-chip__code"></span>
        <span class="course-chip__name"></span>
      </span>
    `;
    chip.querySelector(".course-chip__code").textContent = course.course_code;
    chip.querySelector(".course-chip__name").textContent = course.course_name;
    chip.addEventListener("click", () => selectCourse(course, chip));
    courseChipsEl.appendChild(chip);
  });
}

function selectCourse(course, chip) {
  selectedCourse = course;
  courseChipsEl.querySelectorAll(".course-chip").forEach((el) => {
    el.classList.toggle("is-selected", el === chip);
  });
  renderSessionChips(course);
}

function renderSessionChips(course) {
  selectedSession = null;
  attendanceCardEl.hidden = true;
  sessionStepEl.hidden = false;

  const sessions = upcomingSessions(course);

  if (sessions.length === 0) {
    sessionChipsEl.innerHTML = `<p class="empty-state">No scheduled sessions for this module yet — check back once the timetable is set.</p>`;
    return;
  }

  sessionChipsEl.innerHTML = "";
  sessions.forEach((session) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "session-chip";
    chip.innerHTML = `
      <span class="session-chip__date">${CALENDAR_ICON}<span class="session-chip__day"></span></span>
      <span class="session-chip__time"></span>
    `;
    chip.querySelector(".session-chip__day").textContent = formatDate(
      session.date,
    );
    chip.querySelector(".session-chip__time").textContent =
      `${sliceTime(session.start)}–${sliceTime(session.end)}${session.venue ? ` · ${session.venue}` : ""}`;
    chip.addEventListener("click", () => selectSession(session, chip));
    sessionChipsEl.appendChild(chip);
  });
}

function selectSession(session, chip) {
  selectedSession = session;
  sessionChipsEl.querySelectorAll(".session-chip").forEach((el) => {
    el.classList.toggle("is-selected", el === chip);
  });

  scheduledWhenEl.textContent = `${formatDate(session.date)} · ${sliceTime(session.start)}–${sliceTime(session.end)}`;
  scheduledVenueEl.textContent = session.venue || "TBC";

  startTimeField.value = sliceTime(session.start);
  endTimeField.value = sliceTime(session.end);
  notesField.value = "";
  formError.hidden = true;
  updateDuration();

  attendanceCardEl.hidden = false;
  attendanceCardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- submit ----------

function showToast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedCourse || !selectedSession) return;

  const hours = computeHours();
  if (!hours) {
    formError.textContent = "The ending time must be after the starting time.";
    formError.hidden = false;
    return;
  }
  if (hours < 0.5) {
    formError.textContent =
      "That's under 30 minutes — double-check the times before submitting.";
    formError.hidden = false;
    return;
  }

  const payload = {
    date: toDateStr(selectedSession.date),
    hours: Number(hours.toFixed(1)),
    startTime: startTimeField.value,
    endTime: endTimeField.value,
    taskType: "Peer support",
    courseId: selectedCourse.id,
    notes: notesField.value.trim(),
  };

  const duplicate = await findDuplicateEntry(payload);
  if (duplicate) {
    formError.textContent =
      "This overlaps an entry you've already logged for this day.";
    formError.hidden = false;
    return;
  }

  formError.hidden = true;
  submitBtn.disabled = true;
  try {
    await addEntry(payload);
    notesField.value = "";
    showToast("Attendance submitted — it's on your timesheets.");
  } catch (err) {
    formError.textContent =
      err.message || "Couldn't submit your attendance — try again.";
    formError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- init ----------

(async () => {
  let courses = null;
  try {
    const res = await fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error);

    // Modules I'm approved on — each approved application's joined course.
    const byCourse = new Map();
    rows
      .filter(
        (app) => (app.status || "").toLowerCase() === "approved" && app.courses,
      )
      .forEach((app) => {
        const course = {
          ...app.courses,
          id: app.course_id ?? app.courses.id,
        };
        if (!byCourse.has(course.id)) byCourse.set(course.id, course);
      });
    courses = [...byCourse.values()];
  } catch {
    courses = null;
  }

  if (!courses) {
    courseChipsEl.innerHTML = `<p class="empty-state">Couldn't load your modules right now — try again later.</p>`;
    return;
  }
  renderCourseChips(courses);
})();
