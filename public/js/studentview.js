/* ============================================================
   Student Dashboard
   Modules You Can Tutor (real courses from Supabase, display-only)
   + Upcoming Sessions (cancel one you can't make, still fake data
   from session-data.js until real scheduling exists).
   ============================================================ */

const courseListEl = document.getElementById("courseList");
const upcomingSessionsListEl = document.getElementById("upcomingSessionsList");

async function renderCourses() {
  courseListEl.innerHTML = "";

  let courses;
  try {
    const res = await fetch("/api/courses");
    if (!res.ok) throw new Error("Failed to load courses");
    courses = await res.json();
  } catch (err) {
    courseListEl.innerHTML = `<p class="empty-state">Couldn't load courses right now.</p>`;
    return;
  }

  if (courses.length === 0) {
    courseListEl.innerHTML = `<p class="empty-state">No courses need tutors right now — check back soon.</p>`;
    return;
  }

  courses.forEach((course) => {
    const article = document.createElement("article");
    article.innerHTML = `
      <h3>${course.course_code}</h3>
      <p class="session-meta">${course.course_name}</p>
      <p class="session-note">${course.department}</p>
    `;
    courseListEl.appendChild(article);
  });
}

function renderUpcomingSessions() {
  const sessions = StudentData.getUpcomingSessions();

  upcomingSessionsListEl.innerHTML = "";

  if (sessions.length === 0) {
    upcomingSessionsListEl.innerHTML = `<p class="empty-state">No upcoming sessions.</p>`;
    return;
  }

  sessions.forEach((session) => {
    const article = document.createElement("article");
    article.innerHTML = `
      <h3>${session.subject}</h3>
      <p>With ${session.withWho} • ${session.when}</p>
      <strong>Confirmed</strong>
      <button type="button" class="btn-cancel">Can't make it</button>
    `;
    article.querySelector(".btn-cancel").addEventListener("click", () => {
      StudentData.cancelUpcomingSession(session.id);
      renderUpcomingSessions();
      showToast(`Cancelled ${session.subject} with ${session.withWho}`);
    });
    upcomingSessionsListEl.appendChild(article);
  });
}

// ---------- toast ----------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- init ----------

renderCourses();
renderUpcomingSessions();
