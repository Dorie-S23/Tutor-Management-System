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
// JS Date.getDay(), so a course's weekly session day can be projected onto
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

// A course can run a Tutorial, a Lab, or both — each is its own weekly
// session. Returns whichever of the two are fully scheduled.
function courseSessions(course) {
  return [
    {
      key: "tutorial",
      type: "Tutorial",
      day: course.Day_of_tut,
      start: course.tutor_start_time,
      end: course.tutor_end_time,
      venue: course.venues,
    },
    {
      key: "lab",
      type: "Lab",
      day: course.Day_of_lab,
      start: course.lab_start_time,
      end: course.lab_end_time,
      venue: course.lab_venues,
    },
  ].filter((s) => s.day && s.start && s.end);
}

function formatTimes(session) {
  return `${session.start.slice(0, 5)}–${session.end.slice(0, 5)}`;
}

function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Days from today until the next occurrence of a weekly session
// (0 = today ... 6). A session that has already ended today counts as
// next week's.
function daysUntil(dayName, endTime) {
  const targetIdx = DAY_NAMES.indexOf(dayName);
  if (targetIdx === -1) return null;
  const now = new Date();
  const days = (targetIdx - now.getDay() + 7) % 7;
  const nowHHMM = now.toTimeString().slice(0, 5);
  return days === 0 && endTime.slice(0, 5) <= nowHHMM ? 7 : days;
}

function daysBetweenTodayAnd(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00`);
  return Math.round((target - today) / 86400000);
}

function describeDaysAway(daysAway) {
  if (daysAway === 0) return "today";
  if (daysAway === 1) return "tomorrow";
  return `in ${daysAway} days`;
}

function formatDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// The next occurrence of each Tutorial/Lab on the courses this student is
// approved to volunteer on.
async function fetchRegularSessions() {
  const res = await fetch(
    `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
  );
  const rows = await res.json();
  if (!res.ok) throw new Error(rows.error || "Failed to load sessions");

  return rows
    .filter((app) => (app.status || "").toLowerCase() === "approved")
    .flatMap((app) => {
      const course = app.courses;
      if (!course) return [];
      return courseSessions(course)
        .map((s) => ({
          kind: "regular",
          courseId: app.course_id,
          courseCode: course.course_code,
          courseName: course.course_name,
          label: `${s.type} · ${s.day} · ${formatTimes(s)}`,
          startTime: s.start,
          daysAway: daysUntil(s.day, s.end),
        }))
        .filter((s) => s.daysAway !== null);
    });
}

// Sessions this student has been assigned to cover for an excused tutor.
// Turns an excusal row into an upcoming-sessions entry — either a session
// this student is covering (kind "cover") or one another volunteer has
// asked them to take over (kind "swap_request"). Null once it's over.
function toCoverEntry(excusal, kind) {
  const course = excusal.courses;
  const session = course
    ? courseSessions(course).find((s) => s.key === excusal.session_type)
    : null;
  const daysAway = daysBetweenTodayAnd(excusal.session_date);
  if (!course || daysAway < 0) return null;
  if (
    daysAway === 0 &&
    session &&
    session.end.slice(0, 5) <= new Date().toTimeString().slice(0, 5)
  ) {
    return null; // already happened today
  }
  return {
    kind,
    excusalId: excusal.id,
    courseId: excusal.course_id,
    courseCode: course.course_code,
    courseName: course.course_name,
    tutorName: excusal.tutors?.name || "a tutor",
    coverName: excusal.cover?.name || "Another volunteer",
    swapToName: excusal.swap_to_user_id
      ? excusal.swap_to?.name || "another volunteer"
      : null,
    label: [
      session?.type,
      formatDate(excusal.session_date),
      session ? formatTimes(session) : null,
      session?.venue,
    ]
      .filter(Boolean)
      .join(" · "),
    startTime: session?.start || "00:00",
    daysAway,
  };
}

async function fetchExcusalsWhere(param, kind) {
  const res = await fetch(
    `/api/session-excusals?${param}=${encodeURIComponent(currentUser.id)}`,
  );
  const rows = await res.json();
  if (!res.ok) throw new Error(rows.error || "Failed to load covers");
  return rows.map((excusal) => toCoverEntry(excusal, kind)).filter(Boolean);
}

async function fetchUpcomingSessions() {
  const results = await Promise.allSettled([
    fetchExcusalsWhere("swapToUserId", "swap_request"),
    fetchExcusalsWhere("coverUserId", "cover"),
    fetchRegularSessions(),
  ]);
  const sessions = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort(
      (a, b) =>
        a.daysAway - b.daysAway || a.startTime.localeCompare(b.startTime),
    );
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
      <h3></h3>
      <p class="session-when"></p>
      <span class="status-pill"></span>
    `;
    article.querySelector("h3").textContent =
      `${s.courseCode} — ${s.courseName}`;
    article.querySelector(".session-when").textContent = s.label;
    article.querySelector(".status-pill").textContent = describeDaysAway(
      s.daysAway,
    );

    if (s.kind === "cover") {
      article.classList.add("session-cover");
      article.dataset.coverId = s.excusalId;
      article.prepend(badge(`Covering for ${s.tutorName}`));
      article.appendChild(
        s.swapToName ? buildPendingSwap(s) : buildCantMakeIt(s),
      );
    } else if (s.kind === "swap_request") {
      article.classList.add("session-cover", "session-swap-request");
      article.dataset.swapId = s.excusalId;
      article.prepend(
        badge(
          `${s.coverName} asked you to take this over (covering for ${s.tutorName})`,
        ),
      );
      article.appendChild(buildSwapAnswer(s));
    }

    upcomingSessionsListEl.appendChild(article);
  });
}

function badge(text) {
  const el = document.createElement("p");
  el.className = "session-cover-badge";
  el.textContent = text;
  return el;
}

function actionButton(label, className, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

// POSTs to one of an excusal's cover/swap actions, toasting the outcome and
// refreshing the list on success. Returns whether it worked.
async function coverAction(excusalId, action, body, successMessage) {
  try {
    const res = await fetch(
      `/api/session-excusals/${encodeURIComponent(excusalId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: currentUser.id, ...body }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || "Something went wrong — try again.");
      return false;
    }
    showToast(successMessage);
    fetchUpcomingSessions();
    return true;
  } catch {
    showToast("Network error — couldn't reach the server.");
    return false;
  }
}

// "Can't make it" opens a picker: ask a specific volunteer to take over
// (they have to accept), or let the system hand it to whoever's free.
const AUTO_PICK = "__auto__";

function buildCantMakeIt(cover) {
  const wrap = document.createElement("div");
  wrap.className = "swap-controls";

  const openBtn = actionButton("Can't make it", "btn-cancel", () => {
    openBtn.hidden = true;
    panel.hidden = false;
    loadSwapCandidates(cover, select, sendBtn);
  });

  const panel = document.createElement("div");
  panel.className = "swap-panel";
  panel.hidden = true;

  const label = document.createElement("label");
  label.className = "swap-label";
  label.textContent = "Who should take it over?";
  const select = document.createElement("select");
  select.className = "swap-select";
  label.appendChild(select);

  const sendBtn = actionButton("Send request", "btn-primary", async (btn) => {
    if (!select.value) {
      showToast("Choose who should take it over first.");
      return;
    }
    btn.disabled = true;
    const ok =
      select.value === AUTO_PICK
        ? await coverAction(
            cover.excusalId,
            "decline-cover",
            {},
            "It's been handed to another available volunteer.",
          )
        : await coverAction(
            cover.excusalId,
            "swap-request",
            { toUserId: select.value },
            `Request sent to ${select.selectedOptions[0].textContent} — you're still covering it until they accept.`,
          );
    if (!ok) btn.disabled = false;
  });

  const cancelBtn = actionButton("Cancel", "btn-secondary", () => {
    panel.hidden = true;
    openBtn.hidden = false;
  });

  const buttons = document.createElement("div");
  buttons.className = "swap-buttons";
  buttons.append(sendBtn, cancelBtn);
  panel.append(label, buttons);
  wrap.append(openBtn, panel);
  return wrap;
}

async function loadSwapCandidates(cover, select, sendBtn) {
  select.innerHTML = "<option>Loading volunteers…</option>";
  select.disabled = true;
  sendBtn.disabled = true;

  let candidates = [];
  try {
    const res = await fetch(
      `/api/session-excusals/${encodeURIComponent(cover.excusalId)}/swap-candidates?userId=${encodeURIComponent(currentUser.id)}`,
    );
    candidates = await res.json();
    if (!res.ok) throw new Error(candidates.error);
  } catch (err) {
    showToast(err.message || "Couldn't load the other volunteers.");
    candidates = [];
  }

  select.innerHTML = "";
  const placeholder = new Option(
    candidates.length
      ? "Choose a volunteer…"
      : "No other volunteer is free then",
    "",
  );
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  candidates.forEach((c) => select.appendChild(new Option(c.name, c.user_id)));
  select.appendChild(
    new Option("Anyone free — let the system choose", AUTO_PICK),
  );
  select.disabled = false;
  sendBtn.disabled = false;
}

// Waiting on the volunteer who was asked — the requester can withdraw.
function buildPendingSwap(cover) {
  const wrap = document.createElement("div");
  wrap.className = "swap-controls";
  const note = document.createElement("p");
  note.className = "swap-pending";
  note.textContent = `Waiting for ${cover.swapToName} to accept your swap request — you're still covering it until they do.`;
  wrap.append(
    note,
    actionButton("Withdraw request", "btn-secondary", async (btn) => {
      btn.disabled = true;
      const ok = await coverAction(
        cover.excusalId,
        "swap-withdraw",
        {},
        "Swap request withdrawn — you're still covering it.",
      );
      if (!ok) btn.disabled = false;
    }),
  );
  return wrap;
}

// Another volunteer asked this student to take their session over.
function buildSwapAnswer(request) {
  const wrap = document.createElement("div");
  wrap.className = "swap-buttons";
  const respond = (accept) => async (btn) => {
    wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const ok = await coverAction(
      request.excusalId,
      "swap-respond",
      { accept },
      accept
        ? `You're now covering ${request.courseCode} (${request.label}).`
        : `Declined — ${request.coverName} is still covering it.`,
    );
    if (!ok)
      wrap.querySelectorAll("button").forEach((b) => (b.disabled = false));
  };
  wrap.append(
    actionButton("Accept", "btn-primary", respond(true)),
    actionButton("Decline", "btn-secondary", respond(false)),
  );
  return wrap;
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

  // Arriving from a "you're covering a session" notification — flash that
  // cover (it may be gone if it was cancelled or handed on; that's fine).
  const highlightCoverId = consumeQueryParam("highlightCover");
  if (highlightCoverId) {
    scrollAndHighlight(
      upcomingSessionsListEl.querySelector(
        `[data-cover-id="${CSS.escape(highlightCoverId)}"]`,
      ),
    );
  }

  // Arriving from a "someone asked you to take over a session" notification.
  const highlightSwapId = consumeQueryParam("highlightSwap");
  if (highlightSwapId) {
    scrollAndHighlight(
      upcomingSessionsListEl.querySelector(
        `[data-swap-id="${CSS.escape(highlightSwapId)}"]`,
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
