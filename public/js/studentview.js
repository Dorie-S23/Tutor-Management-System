/* ============================================================
   Student Dashboard
   Modules You Can Tutor (real courses from Supabase, display-only)
   + Upcoming Sessions (cancel one you can't make, still fake data
   from session-data.js until real scheduling exists).
   ============================================================ */

import { getCurrentUser, getEntries } from './storage.js';

const currentUser = getCurrentUser();
if (!currentUser) {
  window.location.href = 'login.html';
  throw new Error('Not logged in');
}

const welcomeHeadingEl = document.getElementById("welcome-heading");
const hoursVolunteeredEl = document.getElementById("stat-hours-volunteered");
const courseListEl = document.getElementById("courseList");
const upcomingSessionsListEl = document.getElementById("upcomingSessionsList");
const logoutLink = document.getElementById("logout-link");

welcomeHeadingEl.textContent = `Welcome, ${currentUser.name}!`;

async function renderHoursVolunteered() {
  const entries = await getEntries();
  hoursVolunteeredEl.textContent = entries.reduce((sum, entry) => sum + Number(entry.hours), 0);
}

async function renderCourses() {
  courseListEl.innerHTML = "";

  let courses;
  try {
    const res = await fetch(`/api/courses?userId=${encodeURIComponent(currentUser.id)}`);
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
      <button type="button" class="${course.volunteered ? "btn-cancel" : ""}">
        ${course.volunteered ? "Volunteering ✓" : "Volunteer"}
      </button>
    `;

    const btn = article.querySelector("button");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        if (course.volunteered) {
          await fetch(`/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}&courseId=${course.id}`, {
            method: "DELETE",
          });
          showToast(`Withdrew from ${course.course_code}`);
        } else {
          await fetch("/api/course-volunteers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: currentUser.id, courseId: course.id }),
          });
          showToast(`You volunteered for ${course.course_code}`);
        }
      } catch (err) {
        showToast("Something went wrong, try again");
      }
      await renderCourses();
    });

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

// ---------- logout ----------

if (logoutLink) {
  logoutLink.addEventListener("click", (event) => {
    event.preventDefault();
    sessionStorage.removeItem("user");
    sessionStorage.removeItem("access_token");
    window.location.href = "login.html";
  });
}

// ---------- init ----------

renderHoursVolunteered();
renderCourses();
renderUpcomingSessions();
