/* ============================================================
   Student Dashboard
   Two ways to volunteer, both living in the course_volunteers table:
   - Modules You Can Tutor: a mark-based application for a whole course
     (has a mark, no session_date). Being approved for one means taking on
     that course's own recurring weekly Tutorial/Lab slot (Day_of_tut etc.
     sit directly on the course row — there's no separate "sessions" table
     for this, same as how a regularly-assigned tutor's schedule works).
   - Open Sessions You Can Cover: an organiser-posted, dated overflow gap
     a student claims (has a session_date, no mark) — a one-off date, not
     a recurring commitment. A claim starts 'open', moves to 'pending' on
     claim, then approved/rejected exactly like a course application.
   My Applications shows both kinds together. Upcoming Sessions surfaces
   both: approved future-dated claims, and the next occurrence of every
   approved whole-course application's recurring slot.
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
const openSessionsListEl = document.getElementById("openSessionsList");
const pendingListEl = document.getElementById("pendingList");
const upcomingSessionsListEl = document.getElementById("upcomingSessionsList");

welcomeHeadingEl.textContent = `Welcome, ${currentUser.name}!`;

function formatSessionDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function formatSessionTime(t) {
  return t ? t.slice(0, 5) : "";
}

function sessionDetailLine(app) {
  const date = formatSessionDate(app.session_date);
  const time = `${formatSessionTime(app.start_time)}–${formatSessionTime(app.end_time)}`;
  const venue = app.venue ? ` &bull; ${app.venue}` : "";
  return `${date}, ${time}${venue}`;
}

// Mirrors DAY_NAMES in server/dayNames.js and dashboard.js's own copy —
// index 0 = Sunday, matching Date#getDay() — so a course's weekly
// Day_of_tut/Day_of_lab can be projected onto the next real calendar date.
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

// A course's own recurring Tutorial/Lab slot — shown on the course card
// before volunteering (so a student knows the time commitment up front)
// and used to build a recurring entry in Upcoming Sessions once approved.
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

function courseScheduleSummary(course) {
  return courseSchedule(course)
    .map((s) => {
      const venueNote = s.venue ? ` (${s.venue})` : "";
      return `${s.type} ${s.day} ${formatSessionTime(s.start)}–${formatSessionTime(s.end)}${venueNote}`;
    })
    .join(" &bull; ");
}

async function renderHoursVolunteered() {
  const entries = await getEntries();
  hoursVolunteeredEl.textContent = entries.reduce(
    (sum, entry) => sum + Number(entry.hours),
    0,
  );
}

async function renderCourses(applications) {
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

  // A course the student already has an application or claimed session
  // against (any status) shows that status instead of a Volunteer button —
  // otherwise it looks like they can apply again, and clicking Volunteer
  // just fails with "you've already volunteered for this course".
  const applicationByCourseId = new Map(
    (applications || []).map((app) => [app.course_id, app]),
  );

  openCourses.forEach((course) => {
    const article = document.createElement("article");
    article.dataset.courseId = String(course.id);

    const scheduleSummary = courseScheduleSummary(course);
    const scheduleHtml = scheduleSummary
      ? `<p class="session-note">${scheduleSummary}</p>`
      : "";

    const existingApp = applicationByCourseId.get(course.id);
    if (existingApp) {
      const status = existingApp.status || "pending";
      const reasonHtml =
        status === "rejected" && existingApp.rejection_reason
          ? `<p class="session-note">Reason: ${existingApp.rejection_reason}</p>`
          : "";
      article.innerHTML = `
        <h3>${course.course_code}</h3>
        <p class="session-meta">${course.course_name}</p>
        <p class="session-note">${course.department}</p>
        ${scheduleHtml}
        <span class="status-pill ${status}">${status[0].toUpperCase()}${status.slice(1)}</span>
        ${reasonHtml}
      `;
      courseListEl.appendChild(article);
      return;
    }

    const minMarkNote = Number.isInteger(course.min_mark)
      ? ` &bull; Min mark ${course.min_mark}`
      : "";
    article.innerHTML = `
      <h3>${course.course_code}</h3>
      <p class="session-meta">${course.course_name}</p>
      <p class="session-note">${course.department}${minMarkNote}</p>
      ${scheduleHtml}
      <button type="button" class="volunteer-btn btn btn-primary">Volunteer</button>
      <div class="mark-form" hidden>
        <div class="form-field">
          <label>Your mark for this module</label>
          <input type="number" class="mark-input" min="0" max="100" placeholder="0-100" />
        </div>
        <div class="form-actions">
          <button type="button" class="submit-mark-btn btn btn-primary">Submit</button>
          <button type="button" class="cancel-mark-btn btn btn-ghost">Cancel</button>
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
      if (Number.isInteger(course.min_mark) && mark < course.min_mark) {
        showToast(
          `You need at least ${course.min_mark} for ${course.course_code} to volunteer`,
        );
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

        showToast(
          `Applied for ${course.course_code} — waiting for organiser approval`,
        );
        await refreshVolunteerState();
      } catch (err) {
        showToast("Something went wrong, try again");
        submitMarkBtn.disabled = false;
      }
    });

    courseListEl.appendChild(article);
  });

  enableCardKeyboardNav(courseListEl);
}

async function renderOpenSessions() {
  openSessionsListEl.innerHTML = "";

  let sessions;
  try {
    const res = await fetch("/api/course-volunteers?status=open");
    if (!res.ok) throw new Error("Failed to load open sessions");
    sessions = await res.json();
  } catch (err) {
    openSessionsListEl.innerHTML = `<p class="empty-state">Couldn't load open sessions right now.</p>`;
    return;
  }

  if (sessions.length === 0) {
    openSessionsListEl.innerHTML = `<p class="empty-state">No open sessions right now — check back soon.</p>`;
    return;
  }

  sessions.forEach((session) => {
    const article = document.createElement("article");
    const reasonHtml = session.reason
      ? `<p class="session-note">${session.reason}</p>`
      : "";
    article.innerHTML = `
      <h3>${session.courses.course_code}</h3>
      <p class="session-meta">${session.courses.course_name}</p>
      <p class="session-note">${sessionDetailLine(session)}</p>
      ${reasonHtml}
    `;

    const claimBtn = document.createElement("button");
    claimBtn.type = "button";
    claimBtn.className = "btn btn-primary";
    claimBtn.textContent = "Claim";
    claimBtn.addEventListener("click", () => claimSession(session, claimBtn));
    article.appendChild(claimBtn);

    openSessionsListEl.appendChild(article);
  });

  enableCardKeyboardNav(openSessionsListEl);
}

async function claimSession(session, button) {
  button.disabled = true;
  try {
    const res = await fetch(`/api/course-volunteers/${session.id}/claim`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: currentUser.id }),
    });
    const body = await res.json();

    if (!res.ok) {
      showToast(body.error || "Couldn't claim that session.");
      // Someone else may have just taken it — refresh so the list matches reality.
      renderOpenSessions();
      button.disabled = false;
      return;
    }

    showToast(
      `Claimed the ${session.courses.course_code} session on ${formatSessionDate(session.session_date)} — waiting for organiser approval`,
    );
    renderOpenSessions();
    await refreshVolunteerState();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    button.disabled = false;
  }
}

// Shared by every action that changes what the student has applied/claimed
// (submitting a mark, claiming a session, withdrawing) — courseList,
// pendingList and upcomingSessionsList all key off the same applications
// fetch, so they're always kept in sync with each other rather than one
// being patched ad hoc while the others go stale.
async function fetchApplications() {
  const res = await fetch(
    `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
  );
  if (!res.ok) throw new Error("Failed to load applications");
  return res.json();
}

async function refreshVolunteerState() {
  let applications = null;
  try {
    applications = await fetchApplications();
  } catch (err) {
    // Individual render functions show their own error copy when passed null.
  }
  await Promise.all([
    renderCourses(applications),
    renderApplications(applications),
    renderUpcomingSessions(applications),
  ]);
}

function renderApplications(applications) {
  pendingListEl.innerHTML = "";

  if (!applications) {
    pendingListEl.innerHTML = `<p class="empty-state">Couldn't load your applications right now.</p>`;
    return;
  }

  if (applications.length === 0) {
    pendingListEl.innerHTML = `<p class="empty-state">You haven't volunteered for anything yet.</p>`;
    return;
  }

  applications.forEach((app) => {
    const status = app.status || "pending";
    const article = document.createElement("article");
    article.dataset.applicationId = app.id;

    const reasonHtml =
      status === "rejected" && app.rejection_reason
        ? `<p class="session-note">Reason: ${app.rejection_reason}</p>`
        : status === "approved" && app.approval_reason
          ? `<p class="session-note">Note: ${app.approval_reason}</p>`
          : "";

    // A row is either a whole-course application (has a mark) or a claimed
    // overflow session (has a session_date instead) — never both.
    const detailLine = app.session_date
      ? sessionDetailLine(app)
      : `Mark submitted: ${app.mark}`;

    article.innerHTML = `
      <h3>${app.courses.course_code}</h3>
      <p>${app.courses.course_name} &bull; ${detailLine}</p>
      ${reasonHtml}
      <span class="status-pill ${status}">${status[0].toUpperCase()}${status.slice(1)}</span>
    `;

    // A rejected row also gets a button — otherwise it's a dead end: the
    // student can never clear it to try again, since the same (student,
    // course) pair can't have a second row while this one still exists.
    if (status === "pending" || status === "rejected") {
      const withdrawBtn = document.createElement("button");
      withdrawBtn.type = "button";
      withdrawBtn.className = "btn btn-ghost";
      withdrawBtn.textContent = status === "rejected" ? "Remove" : "Withdraw";
      withdrawBtn.addEventListener("click", () =>
        withdrawApplication(app, withdrawBtn),
      );
      article.appendChild(withdrawBtn);
    }

    pendingListEl.appendChild(article);
  });

  enableCardKeyboardNav(pendingListEl);
}

// Only an approved, claimed session (session_date set) belongs on the
// dashboard's "Upcoming Sessions" card — a plain course application has no
// date to show yet, and a rejected or still-pending claim isn't a real
// commitment. Past-dated ones are excluded too — those live on My Sessions.
// A whole-course approval has no session_date of its own — it's a standing
// recurring commitment, not a one-off — so its "next occurrence" is derived
// from the course's own Day_of_tut/Day_of_lab here rather than read off the
// row. One entry per weekly Tutorial/Lab slot, showing the soonest date
// it'll next happen.
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
        const venueNote = s.venue ? ` &bull; ${s.venue}` : "";
        entries.push({
          courseId: app.course_id,
          courseCode: app.courses.course_code,
          date: nextDate,
          startTime: s.start,
          label: `${s.type}: ${formatSessionDate(nextDate)}, ${formatSessionTime(s.start)}–${formatSessionTime(s.end)}${venueNote} (repeats weekly)`,
        });
      });
    });
  return entries;
}

function renderUpcomingSessions(applications) {
  if (!applications) {
    upcomingSessionsListEl.innerHTML = `<p class="empty-state">Couldn't load your sessions right now.</p>`;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const claimedSessions = applications
    .filter(
      (app) =>
        app.status === "approved" &&
        app.session_date &&
        app.session_date >= today,
    )
    .map((app) => ({
      courseId: app.course_id,
      courseCode: app.courses.course_code,
      date: app.session_date,
      startTime: app.start_time,
      label: sessionDetailLine(app),
    }));

  const upcoming = [
    ...claimedSessions,
    ...recurringSessionEntries(applications),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.startTime || "").localeCompare(b.startTime || ""),
  );

  if (upcoming.length === 0) {
    upcomingSessionsListEl.innerHTML = `<p class="empty-state">No upcoming sessions</p>`;
    return;
  }

  upcomingSessionsListEl.innerHTML = "";
  upcoming.forEach((entry) => {
    const article = document.createElement("article");
    article.dataset.courseId = String(entry.courseId);
    article.innerHTML = `
      <h3>${entry.courseCode}</h3>
      <p class="session-note">${entry.label}</p>
    `;
    upcomingSessionsListEl.appendChild(article);
  });

  enableCardKeyboardNav(upcomingSessionsListEl);
}

async function withdrawApplication(app, button) {
  button.disabled = true;
  try {
    const res = await fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}&courseId=${encodeURIComponent(app.course_id)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Couldn't withdraw that application.");
      button.disabled = false;
      return;
    }

    // A claimed session's row survives the DELETE (the server reopens it
    // for someone else instead) — a plain course application's doesn't.
    showToast(
      app.session_date
        ? `Released the ${app.courses.course_code} session on ${formatSessionDate(app.session_date)} back to the pool`
        : app.status === "rejected"
          ? `Removed your application for ${app.courses.course_code} — you can apply again`
          : `Withdrew your application for ${app.courses.course_code}`,
    );

    // A full re-render (not a one-off DOM patch) so the course card, the
    // applications list and upcoming sessions all agree on the new state.
    await refreshVolunteerState();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    button.disabled = false;
  }
}

// ---------- keyboard navigation ----------
// Same roving-tabindex pattern as board.js's course list, generalised to
// this page's four independent card lists: Up/Down/Home/End move focus
// between the <article> cards in whichever list already has focus, instead
// of scrolling the page. Each list is scoped to its own container (rather
// than one page-wide listener like board.js) since there's no single
// "active" list here for a key press to default to before the student has
// tabbed into one.
function isTypingInField() {
  const active = document.activeElement;
  return !!(
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  );
}

function enableCardKeyboardNav(container) {
  const cards = () =>
    Array.from(container.children).filter((el) => el.tagName === "ARTICLE");

  cards().forEach((el, i) => {
    el.tabIndex = i === 0 ? 0 : -1;
  });

  // The container itself persists across re-renders (only its <article>
  // children get thrown away and rebuilt), so this only needs binding once.
  if (container.dataset.keyboardNavBound) return;
  container.dataset.keyboardNavBound = "true";

  container.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (isTypingInField()) return;

    const els = cards();
    if (els.length === 0) return;

    const currentIndex = els.indexOf(document.activeElement);
    let targetIndex;
    switch (event.key) {
      case "ArrowDown":
        targetIndex =
          currentIndex < 0 ? 0 : Math.min(currentIndex + 1, els.length - 1);
        break;
      case "ArrowUp":
        targetIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
        break;
      case "Home":
        targetIndex = 0;
        break;
      case "End":
        targetIndex = els.length - 1;
        break;
    }

    event.preventDefault();
    els.forEach((el, i) => {
      el.tabIndex = i === targetIndex ? 0 : -1;
    });
    els[targetIndex].focus();
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
    selector: "section[aria-labelledby='open-sessions-heading']",
    title: "Open sessions you can cover",
    body: "Specific, dated gaps an organiser has flagged — a one-off session with nobody to run it. Claim one and an organiser will confirm it.",
    placement: "top",
  },
  {
    selector: "section[aria-labelledby='pending-heading']",
    title: "My applications",
    body: "Every module and claimed session you've volunteered for, with its outcome — including a reason if one was rejected. You can withdraw a pending one any time.",
    placement: "top",
  },
  {
    selector: "section[aria-labelledby='sessions-heading']",
    title: "Upcoming sessions",
    body: "Once a claimed session is approved, it shows up here — closest first.",
    placement: "top",
  },
  {
    selector: "a[href='my-sessions.html']",
    title: "My Sessions",
    body: "A full view of your tutoring sessions, past and upcoming.",
    placement: "bottom",
  },
  {
    selector: "a[href='student-log-hours.html']",
    title: "Log Hours",
    body: "After a session, log the hours you spent tutoring here.",
    placement: "bottom",
  },
  {
    selector: "a[href='student-calendar.html']",
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
  // below, which only depends on refreshVolunteerState() having finished.
  await Promise.allSettled([
    renderHoursVolunteered(),
    renderOpenSessions(),
    refreshVolunteerState(),
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

  // "Take the tour" on the other student pages links here with ?tour=1 —
  // arriving with it means that click explicitly asked for the walkthrough,
  // so replay it even if the once-per-user auto-show was already consumed.
  window.Onboarding?.start(VOLUNTEER_TOUR_STEPS, {
    tourId: "volunteer-dashboard",
    userId: currentUser.id,
    force: Boolean(consumeQueryParam("tour")),
  });
})();
