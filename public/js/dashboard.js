import { highlightActiveTab } from "./nav.js";
import { getWeekStart, getWeekTotal, todayStr } from "./storage.js";

const WEEKLY_HOUR_LIMIT = 6;

highlightActiveTab();

const hoursWorkedEl = document.getElementById("stat-hours-worked");
const hoursRemainingEl = document.getElementById("stat-hours-remaining");
const hoursSublabelEl = document.getElementById("stat-hours-sublabel");
const welcomeHeadingEl = document.getElementById("welcome-heading");

function getCurrentUser() {
  const raw = sessionStorage.getItem("user");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function renderWelcome() {
  const user = getCurrentUser();
  if (user?.name) welcomeHeadingEl.textContent = `Welcome, ${user.name}`;
}

async function renderHoursStats() {
  const weekStart = getWeekStart(todayStr());
  const worked = await getWeekTotal(weekStart);
  const remaining = WEEKLY_HOUR_LIMIT - worked;

  hoursWorkedEl.textContent = worked;

  if (remaining >= 0) {
    hoursRemainingEl.textContent = remaining;
    hoursRemainingEl.classList.remove("danger");
    hoursSublabelEl.textContent = `of ${WEEKLY_HOUR_LIMIT} hrs/week limit`;
  } else {
    hoursRemainingEl.textContent = 0;
    hoursRemainingEl.classList.add("danger");
    hoursSublabelEl.textContent = `over the ${WEEKLY_HOUR_LIMIT} hrs/week limit by ${-remaining}`;
  }
}

renderHoursStats().catch((err) => {
  console.error("Failed to load hours stats:", err);
});
renderWelcome();

// ---------- upcoming sessions ----------

// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday, matching
// JS Date.getDay(), so a course's weekly Day_of_tut can be projected onto
// the next real calendar date.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// A light pastel palette, cycled by course id, so each course's row in
// "Upcoming sessions" gets a consistent colour instead of one flat grey list.
const COURSE_COLORS = [
  { bg: "#e6eeef", text: "#26424b", border: "#26424b" }, // navy
  { bg: "#e3eee6", text: "#2f6b4f", border: "#b9d2c1" }, // green
  { bg: "#f5ead5", text: "#a66a17", border: "#e3cb9a" }, // amber
  { bg: "#ece6f5", text: "#5b3a91", border: "#c9b8e0" }, // purple
  { bg: "#dff0ef", text: "#1f7a72", border: "#a9d9d4" }, // teal
  { bg: "#f6e3ea", text: "#a13d67", border: "#e3b9cc" }, // rose
  { bg: "#e1ecf7", text: "#2560a3", border: "#b7d3ee" }, // blue
  { bg: "#eef0d8", text: "#6b7a1f", border: "#d6dba0" }, // olive
  { bg: "#f3e2d8", text: "#a85332", border: "#e6c2ac" }, // terracotta
];

function courseColor(courseId) {
  return COURSE_COLORS[Number(courseId) % COURSE_COLORS.length];
}

const upcomingListEl = document.getElementById("upcoming-sessions-list");
const upcomingItemsEl = document.getElementById("upcoming-sessions-items");
const upcomingEmptyEl = document.getElementById("upcoming-sessions-empty");
const nextSessionEl = document.getElementById("stat-next-session");
const nextSessionSublabelEl = document.getElementById(
  "stat-next-session-sublabel",
);

const excuseBtn = document.getElementById("excuse-btn");
const excuseModal = document.getElementById("excuse-modal");
const excuseForm = document.getElementById("excuse-form");
const excuseError = document.getElementById("excuse-form-error");
const excuseSubmitBtn = document.getElementById("excuse-submit-btn");
const excuseCourseSelect = document.getElementById("excuse-course-select");
const excuseDateInput = document.getElementById("excuse-date-input");
const excuseReasonInput = document.getElementById("excuse-reason-input");
const excusalsListEl = document.getElementById("excusals-list");
const excusalsItemsEl = document.getElementById("excusals-items");
const toastEl = document.getElementById("toast");

// Populated by fetchUpcomingSessions() — reused here so the excuse-yourself
// modal's course dropdown doesn't need its own extra fetch.
let myApplications = [];
let myExcusals = [];

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

function formatSession(course) {
  if (!course.Day_of_tut || !course.tutor_start_time || !course.tutor_end_time)
    return null;
  return `${course.Day_of_tut} · ${course.tutor_start_time.slice(0, 5)}–${course.tutor_end_time.slice(0, 5)}`;
}

// Days from today until the next occurrence of a weekly tutorial day
// (0 = today, 1 = tomorrow, ... 6 = a week from today at the latest).
function daysUntil(dayName) {
  const targetIdx = DAY_NAMES.indexOf(dayName);
  if (targetIdx === -1) return null;
  const todayIdx = new Date().getDay();
  return (targetIdx - todayIdx + 7) % 7;
}

function describeDaysAway(daysAway) {
  if (daysAway === 0) return "today";
  if (daysAway === 1) return "tomorrow";
  return `in ${daysAway} days`;
}

async function fetchUpcomingSessions(tutorId) {
  let sessions = [];
  try {
    const res = await fetch(
      `/api/tutor-applications?tutorId=${encodeURIComponent(tutorId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load sessions");
    myApplications = rows;

    sessions = rows
      .filter((app) => (app.status || "").toLowerCase() === "approved")
      .map((app) => {
        const course = app.courses;
        const session = course ? formatSession(course) : null;
        const daysAway = course ? daysUntil(course.Day_of_tut) : null;
        if (!course || !session || daysAway === null) return null;
        return {
          courseId: app.course_id,
          courseCode: course.course_code,
          courseName: course.course_name,
          session,
          startTime: course.tutor_start_time,
          daysAway,
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.daysAway - b.daysAway || a.startTime.localeCompare(b.startTime),
      );
  } catch {
    sessions = [];
    myApplications = [];
  }
  renderUpcomingSessions(sessions);
}

function renderUpcomingSessions(sessions) {
  if (sessions.length === 0) {
    upcomingListEl.hidden = true;
    upcomingEmptyEl.hidden = false;
    nextSessionEl.textContent = "—";
    nextSessionSublabelEl.textContent = "";
    return;
  }

  upcomingEmptyEl.hidden = true;
  upcomingListEl.hidden = false;
  upcomingItemsEl.innerHTML = "";

  sessions.forEach((s) => {
    const palette = courseColor(s.courseId);
    const li = document.createElement("li");
    li.className = "application-row application-row--course";
    li.style.background = palette.bg;
    li.style.borderColor = palette.border;
    li.innerHTML = `
      <span><strong style="color: ${palette.text}">${s.courseCode}</strong> — ${s.courseName}<br />${s.session}</span>
      <span class="status-pill" style="background: rgba(255, 255, 255, 0.6); color: ${palette.text}; border-color: ${palette.border}">${describeDaysAway(s.daysAway)}</span>
    `;
    upcomingItemsEl.appendChild(li);
  });

  const next = sessions[0];
  nextSessionEl.textContent = next.session;
  nextSessionSublabelEl.textContent = `${next.courseCode} · ${describeDaysAway(next.daysAway)}`;
}

(async function initUpcomingSessions() {
  const user = getCurrentUser();
  if (user) {
    // Independent endpoints — no need to wait for one before starting the other.
    await Promise.all([
      fetchUpcomingSessions(user.id),
      fetchMyExcusals(user.id),
    ]);
  }
})();

// ---------- excuse yourself from a session ----------

function renderExcusalsList() {
  const today = todayStr();
  const upcoming = myExcusals
    .filter((e) => e.session_date >= today)
    .sort((a, b) => a.session_date.localeCompare(b.session_date));

  if (upcoming.length === 0) {
    excusalsListEl.hidden = true;
    return;
  }
  excusalsListEl.hidden = false;
  excusalsItemsEl.innerHTML = "";

  upcoming.forEach((excusal) => {
    const course = excusal.courses;
    const li = document.createElement("li");
    li.className = "application-row";
    li.innerHTML = `
      <span>${course ? `${course.course_code} — ${excusal.session_date}` : excusal.session_date}${excusal.reason ? ` (${excusal.reason})` : ""}</span>
      <button type="button" class="btn-link" data-action="cancel-excusal">Cancel</button>
    `;
    li.querySelector('[data-action="cancel-excusal"]').addEventListener(
      "click",
      () => cancelExcusal(excusal.id),
    );
    excusalsItemsEl.appendChild(li);
  });
}

async function fetchMyExcusals(tutorId) {
  try {
    const res = await fetch(
      `/api/session-excusals?tutorId=${encodeURIComponent(tutorId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load excusals");
    myExcusals = rows;
  } catch {
    myExcusals = [];
  }
  renderExcusalsList();
}

async function cancelExcusal(id) {
  try {
    const res = await fetch(`/api/session-excusals/${id}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Couldn't cancel that excusal.");
      return;
    }
    showToast("Excusal cancelled.");
    const user = getCurrentUser();
    if (user) await fetchMyExcusals(user.id);
  } catch {
    showToast("Network error — couldn't reach the server.");
  }
}

function populateExcuseCourseSelect() {
  const approvedCourses = myApplications
    .filter((a) => a.status === "approved")
    .map((a) => a.courses)
    .filter(Boolean);

  excuseCourseSelect.innerHTML =
    '<option value="" disabled selected>Choose a course&hellip;</option>';
  myApplications
    .filter((a) => a.status === "approved")
    .forEach((a) => {
      const option = document.createElement("option");
      option.value = a.course_id;
      option.textContent = a.courses
        ? `${a.courses.course_code} — ${a.courses.course_name}`
        : `Course ${a.course_id}`;
      excuseCourseSelect.appendChild(option);
    });

  return approvedCourses;
}

function openExcuseModal() {
  const user = getCurrentUser();
  if (!user) {
    showToast("Please log in as a tutor to excuse yourself.");
    return;
  }

  excuseForm.reset();
  excuseError.hidden = true;
  excuseDateInput.min = todayStr();
  const approvedCourses = populateExcuseCourseSelect();

  if (approvedCourses.length === 0) {
    showToast("You need an approved course assignment first.");
    return;
  }

  excuseModal.showModal();
}

function closeExcuseModal() {
  excuseModal.close();
}

excuseBtn?.addEventListener("click", openExcuseModal);
document
  .getElementById("excuse-modal-close-btn")
  ?.addEventListener("click", closeExcuseModal);
document
  .getElementById("excuse-cancel-btn")
  ?.addEventListener("click", closeExcuseModal);
excuseModal?.addEventListener("click", (e) => {
  if (e.target === excuseModal) closeExcuseModal();
});

excuseForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  excuseError.hidden = true;

  const user = getCurrentUser();
  if (!user) {
    showToast("Please log in as a tutor to excuse yourself.");
    return;
  }

  const payload = {
    tutorId: user.id,
    courseId: Number(excuseCourseSelect.value),
    sessionDate: excuseDateInput.value,
    reason: excuseReasonInput.value.trim(),
  };

  excuseSubmitBtn.disabled = true;
  excuseSubmitBtn.textContent = "Submitting…";

  try {
    const res = await fetch("/api/session-excusals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    if (!res.ok) {
      excuseError.textContent = body.error || "Couldn't submit that excusal.";
      excuseError.hidden = false;
      return;
    }

    closeExcuseModal();
    showToast("You're excused from that session.");
    await fetchMyExcusals(user.id);
  } catch {
    excuseError.textContent = "Network error — couldn't reach the server.";
    excuseError.hidden = false;
  } finally {
    excuseSubmitBtn.disabled = false;
    excuseSubmitBtn.textContent = "Excuse me from this session";
  }
});
