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
  console.error('Failed to load hours stats:', err);
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

const upcomingListEl = document.getElementById("upcoming-sessions-list");
const upcomingItemsEl = document.getElementById("upcoming-sessions-items");
const upcomingEmptyEl = document.getElementById("upcoming-sessions-empty");
const nextSessionEl = document.getElementById("stat-next-session");
const nextSessionSublabelEl = document.getElementById(
  "stat-next-session-sublabel",
);

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

    sessions = rows
      .filter((app) => (app.status || "").toLowerCase() === "approved")
      .map((app) => {
        const course = app.courses;
        const session = course ? formatSession(course) : null;
        const daysAway = course ? daysUntil(course.Day_of_tut) : null;
        if (!course || !session || daysAway === null) return null;
        return {
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
    const li = document.createElement("li");
    li.className = "application-row";
    li.innerHTML = `
      <span>${s.courseCode} — ${s.courseName}<br />${s.session}</span>
      <span class="status-pill">${describeDaysAway(s.daysAway)}</span>
    `;
    upcomingItemsEl.appendChild(li);
  });

  const next = sessions[0];
  nextSessionEl.textContent = next.session;
  nextSessionSublabelEl.textContent = `${next.courseCode} · ${describeDaysAway(next.daysAway)}`;
}

(async function initUpcomingSessions() {
  const user = getCurrentUser();
  if (user) await fetchUpcomingSessions(user.id);
})();
