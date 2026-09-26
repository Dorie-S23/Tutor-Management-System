/* ============================================================
   Student Dashboard
   Modules You Can Tutor (real courses from Supabase) + a mark-based
   volunteer application + the resulting pending applications +
   upcoming sessions for the courses you're approved to volunteer on.
   ============================================================ */

import { getEntries, requireRole } from "./storage.js";
import { consumeQueryParam, scrollAndHighlight } from "./highlightTarget.js";

// This page (StudentView.html) is student-only — symmetric with the guard
// on the tutor pages, so a tutor can't wander in here either.
const currentUser = requireRole("student");
if (!currentUser) {
  throw new Error("Not authorized");
}

const welcomeHeadingEl = document.getElementById("welcome-heading");
const hoursVolunteeredEl = document.getElementById("stat-hours-volunteered");
const courseListEl = document.getElementById("courseList");
const pendingListEl = document.getElementById("pendingList");
const upcomingSessionsListEl = document.getElementById("upcomingSessionsList");

welcomeHeadingEl.textContent = `Welcome, ${currentUser.name}!`;

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

async function fetchUpcomingSessions() {
  let sessions = [];
  try {
    const res = await fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
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
  }
  renderUpcomingSessions(sessions);
}

function renderUpcomingSessions(sessions) {
  if (sessions.length === 0) {
    upcomingSessionsListEl.innerHTML = `<p class="empty-state">No upcoming sessions</p>`;
    return;
  }

  upcomingSessionsListEl.innerHTML = "";
  upcomingSessionsListEl.className = "session-list";

  sessions.forEach((s) => {
    const article = document.createElement("article");
    article.dataset.courseId = s.courseId;
    article.innerHTML = `
      <h3>${s.courseCode} — ${s.courseName}</h3>
      <p>${s.session}</p>
      <span class="status-pill">${describeDaysAway(s.daysAway)}</span>
    `;
    upcomingSessionsListEl.appendChild(article);
  });
}

async function renderHoursVolunteered() {
  const entries = await getEntries();
  hoursVolunteeredEl.textContent = entries.reduce(
    (sum, entry) => sum + Number(entry.hours),
    0,
  );
}

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

  // Only show courses that still need tutors - hide ones already fully staffed.
  const openCourses = courses.filter(
    (course) => (course.no_of_tutors_assigned || 0) < course.tutors_needed,
  );

  if (openCourses.length === 0) {
    courseListEl.innerHTML = `<p class="empty-state">No courses need tutors right now — check back soon.</p>`;
    return;
  }

  openCourses.forEach((course) => {
    const article = document.createElement("article");
    article.innerHTML = `
      <h3>${course.course_code}</h3>
      <p class="session-meta">${course.course_name}</p>
      <p class="session-note">${course.department}</p>
      <button type="button" class="volunteer-btn">Volunteer</button>
      <div class="mark-form" hidden>
        <div class="form-field">
          <label>Your mark for this module</label>
          <input type="number" class="mark-input" min="0" max="100" placeholder="0-100" />
        </div>
        <div class="form-actions">
          <button type="button" class="submit-mark-btn btn-primary">Submit</button>
          <button type="button" class="cancel-mark-btn btn-secondary">Cancel</button>
        </div>
      </div>
    `;

    const volunteerBtn = article.querySelector(".volunteer-btn");
    const markForm = article.querySelector(".mark-form");
    const markInput = article.querySelector(".mark-input");
    const submitMarkBtn = article.querySelector(".submit-mark-btn");
    const cancelMarkBtn = article.querySelector(".cancel-mark-btn");

    volunteerBtn.addEventListener("click", () => {
      volunteerBtn.hidden = true;
      markForm.hidden = false;
      markInput.value = "";
      markInput.focus();
    });

    cancelMarkBtn.addEventListener("click", () => {
      markForm.hidden = true;
      volunteerBtn.hidden = false;
    });

    markInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitMarkBtn.click();
    });

    submitMarkBtn.addEventListener("click", async () => {
      const mark = Number(markInput.value);
      if (!Number.isInteger(mark) || mark < 0 || mark > 100) {
        showToast("Enter a valid mark between 0 and 100");
        return;
      }

      submitMarkBtn.disabled = true;
      try {
        const res = await fetch("/api/course-volunteers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: currentUser.id,
            courseId: course.id,
            mark,
          }),
        });
        const data = await res.json();

        if (!res.ok) {
          showToast(data.error || "Could not submit your application");
          submitMarkBtn.disabled = false;
          return;
        }

        markForm.hidden = true;
        volunteerBtn.hidden = false;
        volunteerBtn.textContent = "Pending approval";
        volunteerBtn.disabled = true;
        showToast(
          `Applied for ${course.course_code} — waiting for organiser approval`,
        );
        renderPendingApplications();
      } catch (err) {
        showToast("Something went wrong, try again");
        submitMarkBtn.disabled = false;
      }
    });

    courseListEl.appendChild(article);
  });
}

async function renderPendingApplications() {
  pendingListEl.innerHTML = "";

  let applications;
  try {
    const res = await fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
    );
    if (!res.ok) throw new Error("Failed to load applications");
    applications = await res.json();
  } catch (err) {
    pendingListEl.innerHTML = `<p class="empty-state">Couldn't load your applications right now.</p>`;
    return;
  }

  const statusOrder = { pending: 0, approved: 1, rejected: 2 };
  const statusLabels = {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
  };

  const relevant = applications
    .filter((app) => ["pending", "approved", "rejected"].includes(app.status))
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  if (relevant.length === 0) {
    pendingListEl.innerHTML = `<p class="empty-state">No modules waiting on approval.</p>`;
    return;
  }

  relevant.forEach((app) => {
    const status = (app.status || "pending").toLowerCase();
    const article = document.createElement("article");
    article.dataset.applicationId = app.id;
    article.innerHTML = `
      <h3>${app.courses.course_code}</h3>
      <p>${app.courses.course_name} &bull; Mark submitted: ${app.mark}</p>
      <span class="status-pill ${status}">${statusLabels[status] || status}</span>
      ${
        status === "rejected" && app.rejection_reason
          ? `<p class="card-hint">Reason: ${app.rejection_reason}</p>`
          : ""
      }
      ${
        status === "approved" && app.approval_reason
          ? `<p class="card-hint">Note: ${app.approval_reason}</p>`
          : ""
      }
      ${status === "rejected" ? `<button type="button" class="btn-link" data-action="remove-volunteer">Remove &amp; volunteer again</button>` : ""}
    `;
    if (status === "rejected") {
      article
        .querySelector('[data-action="remove-volunteer"]')
        .addEventListener("click", () =>
          removeVolunteerApplication(app.course_id),
        );
    }
    pendingListEl.appendChild(article);
  });
}

// Lets a rejected student volunteer dismiss it themselves so the unique
// (user, course) constraint stops blocking them from volunteering again,
// rather than waiting on an organiser to reset it.
async function removeVolunteerApplication(courseId) {
  if (
    !confirm(
      "Remove this application? You'll be able to volunteer for this course again.",
    )
  )
    return;
  try {
    const res = await fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}&courseId=${encodeURIComponent(courseId)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Couldn't remove that application.");
      return;
    }
    showToast("Application removed.");
    renderPendingApplications();
  } catch {
    showToast("Network error — couldn't reach the server.");
  }
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

// ---------- guided tour ----------

const VOLUNTEER_TOUR_STEPS = [
  {
    selector: "section[aria-labelledby='stats-heading']",
    title: "Your hours",
    body: "Total hours you've volunteered tutoring so far, pulled from your logged sessions.",
    placement: "bottom",
  },
  {
    selector: "#courseList",
    title: "Modules you can tutor",
    body: 'Courses currently looking for volunteers show up here. Click "Volunteer" on one, enter the mark you got in that module, and submit — an organiser will review it.',
    placement: "top",
  },
  {
    selector: "section[aria-labelledby='pending-heading']",
    title: "Awaiting approval",
    body: "Modules you've applied for sit here until an organiser approves or rejects them.",
    placement: "top",
  },
  {
    selector: "section[aria-labelledby='sessions-heading']",
    title: "Upcoming sessions",
    body: "Once you're approved for a module, your scheduled tutoring sessions will appear here.",
    placement: "top",
  },
  {
    selector: "a[href='my-sessions.html']",
    title: "My Sessions",
    body: "A full view of your tutoring sessions, past and upcoming.",
    placement: "bottom",
  },
  {
    selector: "a[href='log-hours.html']",
    title: "Log Hours",
    body: "After a session, log the hours you spent tutoring here.",
    placement: "bottom",
  },
  {
    selector: "a[href='student_calender.html']",
    title: "Calendar",
    body: "See your sessions laid out by date.",
    placement: "bottom",
  },
];

const tourLink = document.getElementById("tour-link");
if (tourLink) {
  tourLink.addEventListener("click", (e) => {
    e.preventDefault();
    window.Onboarding?.start(VOLUNTEER_TOUR_STEPS, {
      tourId: "volunteer-dashboard",
      userId: currentUser.id,
      force: true,
    });
  });
}

// ---------- init ----------

(async () => {
  // allSettled, not all: one widget's fetch failing (e.g. hours volunteered)
  // shouldn't stop the others from rendering — including the highlight
  // below, which only depends on fetchUpcomingSessions having finished.
  await Promise.allSettled([
    renderHoursVolunteered(),
    renderCourses(),
    renderPendingApplications(),
    fetchUpcomingSessions(),
  ]);

  // Arriving from a "session changed" notification — scroll to and flash
  // the course it was about, now that the list containing it has rendered.
  const highlightCourseId = consumeQueryParam("highlightCourse");
  if (highlightCourseId) {
    scrollAndHighlight(
      upcomingSessionsListEl.querySelector(
        `[data-course-id="${CSS.escape(highlightCourseId)}"]`,
      ),
    );
  }

  // Arriving from a "volunteer application status changed" notification.
  const highlightApplicationId = consumeQueryParam("highlightApplication");
  if (highlightApplicationId) {
    scrollAndHighlight(
      pendingListEl.querySelector(
        `[data-application-id="${CSS.escape(highlightApplicationId)}"]`,
      ),
    );
  }

  window.Onboarding?.start(VOLUNTEER_TOUR_STEPS, {
    tourId: "volunteer-dashboard",
    userId: currentUser.id,
  });
})();
