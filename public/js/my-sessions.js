/* ============================================================
   My Sessions
   Two kinds of commitments live in course_volunteers, and this page
   shows both under Upcoming — same merge as the dashboard's "Upcoming
   Sessions" card, whose "View all" link lands here, so the two views
   can't disagree on what counts as a session:
   - Claimed overflow sessions (rows with a session_date) that have
     been approved — one-off dates, split into Upcoming and Past.
   - Approved whole-course applications (a mark, no session_date) —
     standing weekly commitments whose slot lives on the course row
     (Day_of_tut/Day_of_lab). Each contributes its next occurrence to
     Upcoming, tagged "(repeats weekly)". Past occurrences of a
     recurring slot aren't recorded anywhere (there's no per-week
     attendance history), so Past stays claimed one-offs only.
   A plain classic script, not a module — reads the signed-in user
   straight out of sessionStorage, same as board.js does, rather than
   importing storage.js's requireRole().
   ============================================================ */

const ROLE_HOME = {
  student: "StudentView.html",
  tutor: "dashboard.html",
  educator: "educator.html",
  organiser: "board.html",
};

function requireStudent() {
  let user = null;
  try {
    const raw = sessionStorage.getItem("user");
    user = raw ? JSON.parse(raw) : null;
  } catch {
    user = null;
  }
  if (!user) {
    window.location.href = "login.html";
    return null;
  }
  if (user.role !== "student") {
    window.location.href = ROLE_HOME[user.role] || "login.html";
    return null;
  }
  return user;
}

const currentUser = requireStudent();

// Same "Welcome, {name}!" heading as every other student page, for a
// consistent header no matter which page you're actually on.
if (currentUser) {
  const welcomeHeadingEl = document.getElementById("welcome-heading");
  if (welcomeHeadingEl)
    welcomeHeadingEl.textContent = `Welcome, ${currentUser.name}!`;
}

const upcomingListEl = document.getElementById("upcomingList");
const pastListEl = document.getElementById("pastList");

function formatSessionDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function formatSessionTime(t) {
  return t ? t.slice(0, 5) : "";
}

// Mirrors the copies in studentview.js (and DAY_NAMES in
// server/dayNames.js) — index 0 = Sunday, matching Date#getDay() — so a
// course's weekly Day_of_tut/Day_of_lab can be projected onto the next
// real calendar date.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function nextOccurrenceIso(dayName) {
  const targetIdx = DAY_NAMES.indexOf(dayName);
  if (targetIdx === -1) return null;
  const d = new Date();
  d.setDate(d.getDate() + ((targetIdx - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// Same schedule extraction as studentview.js's courseSchedule() — a
// course's own recurring Tutorial/Lab slot, off the course row itself.
function courseSchedule(course) {
  const sessions = [];
  if (course.Day_of_tut && course.tutor_start_time && course.tutor_end_time) {
    sessions.push({
      type: "Tutorial",
      day: course.Day_of_tut,
      start: course.tutor_start_time,
      end: course.tutor_end_time,
      venue: course.venues,
    });
  }
  if (course.Day_of_lab && course.lab_start_time && course.lab_end_time) {
    sessions.push({
      type: "Lab",
      day: course.Day_of_lab,
      start: course.lab_start_time,
      end: course.lab_end_time,
      venue: course.lab_venues,
    });
  }
  return sessions;
}

// Next occurrence of every approved whole-course application's weekly
// slot(s), shaped like a claimed-session row so sessionCard() can render
// either kind the same way (with `recurring: true` adding the tag).
function recurringSessionEntries(applications) {
  const entries = [];
  applications
    .filter(
      (app) => app.status === "approved" && !app.session_date && app.courses,
    )
    .forEach((app) => {
      courseSchedule(app.courses).forEach((s) => {
        const nextDate = nextOccurrenceIso(s.day);
        if (!nextDate) return;
        entries.push({
          courses: app.courses,
          session_date: nextDate,
          start_time: s.start,
          end_time: s.end,
          venue: s.venue,
          type: s.type,
          recurring: true,
        });
      });
    });
  return entries;
}

function sessionCard(app) {
  const time = `${formatSessionTime(app.start_time)}–${formatSessionTime(app.end_time)}`;
  const venue = app.venue ? ` &bull; ${app.venue}` : "";
  const typePrefix = app.type ? `${app.type}: ` : "";
  const recurringNote = app.recurring ? " (repeats weekly)" : "";
  const article = document.createElement("article");
  article.innerHTML = `
    <h3>${app.courses.course_code}</h3>
    <p class="session-meta">${app.courses.course_name}</p>
    <p class="session-note">${typePrefix}${formatSessionDate(app.session_date)}, ${time}${venue}${recurringNote}</p>
  `;
  return article;
}

async function renderSessions() {
  if (!currentUser) return;

  let applications;
  try {
    const res = await fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
    );
    if (!res.ok) throw new Error("Failed to load sessions");
    applications = await res.json();
  } catch (err) {
    upcomingListEl.innerHTML = `<p class="empty-state">Couldn't load your sessions right now.</p>`;
    pastListEl.innerHTML = "";
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const claimedSessions = applications.filter(
    (app) => app.status === "approved" && app.session_date,
  );

  const past = claimedSessions
    .filter((app) => app.session_date < today)
    .sort((a, b) => b.session_date.localeCompare(a.session_date));

  const upcoming = [
    ...claimedSessions.filter((app) => app.session_date >= today),
    ...recurringSessionEntries(applications),
  ].sort(
    (a, b) =>
      a.session_date.localeCompare(b.session_date) ||
      (a.start_time || "").localeCompare(b.start_time || ""),
  );

  upcomingListEl.innerHTML = "";
  if (upcoming.length === 0) {
    upcomingListEl.innerHTML = `<p class="empty-state">No upcoming sessions</p>`;
  } else {
    upcoming.forEach((app) => upcomingListEl.appendChild(sessionCard(app)));
  }

  pastListEl.innerHTML = "";
  if (past.length === 0) {
    pastListEl.innerHTML = `<p class="empty-state">No past sessions</p>`;
  } else {
    past.forEach((app) => pastListEl.appendChild(sessionCard(app)));
  }
}

renderSessions();
