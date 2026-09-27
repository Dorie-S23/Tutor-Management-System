/* ============================================================
   My Sessions
   Every claimed overflow session (course_volunteers rows with a
   session_date) that's been approved, split into Upcoming and Past by
   date. A plain classic script, not a module — reads the signed-in user
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

function sessionCard(app) {
  const time = `${formatSessionTime(app.start_time)}–${formatSessionTime(app.end_time)}`;
  const venue = app.venue ? ` &bull; ${app.venue}` : "";
  const article = document.createElement("article");
  article.innerHTML = `
    <h3>${app.courses.course_code}</h3>
    <p class="session-meta">${app.courses.course_name}</p>
    <p class="session-note">${formatSessionDate(app.session_date)}, ${time}${venue}</p>
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

  const upcoming = claimedSessions
    .filter((app) => app.session_date >= today)
    .sort((a, b) => a.session_date.localeCompare(b.session_date));
  const past = claimedSessions
    .filter((app) => app.session_date < today)
    .sort((a, b) => b.session_date.localeCompare(a.session_date));

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
