/* ============================================================
   Volunteer dashboard (StudentView.html)

   Stat cards, "Available volunteer sessions" (open modules you
   can claim — each card carries your application's state) and
   your upcoming sessions. Renderers guard on their containers
   existing so a missing one degrades quietly.
   ============================================================ */

import { getEntries, requireRole } from "./storage.js";
import { highlightActiveTab } from "./nav.js";
import { consumeQueryParam, scrollAndHighlight } from "./highlightTarget.js";
import { initTranscriptUpload } from "./transcript-upload.js";

// These pages are volunteer-only — symmetric with the guard on the tutor
// pages, so a tutor can't wander in here either.
const currentUser = requireRole("volunteer");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

const courseListEl = document.getElementById("courseList");
const upcomingSessionsListEl = document.getElementById("upcomingSessionsList");
const availableHintEl = document.getElementById("available-hint");

// The tour points at the stat row and lists below, so auto-starting it
// stays behind this guard.
const isDashboard = !!document.querySelector(".stat-grid");

function setStat(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ---------- icons (inline SVG, matching the Figma cards) ----------

const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const CLOCK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
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

// The soonest Tutorial/Lab a course still has ahead of it — used to show
// "Mon 18 Aug · 11:00 · 2h" on the claimable-session cards.
function nextSessionOccurrence(course) {
  const candidates = courseSessions(course)
    .map((session) => ({
      ...session,
      daysAway: daysUntil(session.day, session.end),
    }))
    .filter((session) => session.daysAway !== null)
    .sort((a, b) => a.daysAway - b.daysAway);
  if (candidates.length === 0) return null;

  const next = candidates[0];
  const date = new Date();
  date.setDate(date.getDate() + next.daysAway);
  return { ...next, date };
}

function formatDuration(start, end) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const hours = (eh * 60 + em - (sh * 60 + sm)) / 60;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return `${Number(hours.toFixed(1))}h`;
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
  setStat("stat-upcoming-sessions", String(sessions.length));
  if (!upcomingSessionsListEl) return;

  if (sessions.length === 0) {
    upcomingSessionsListEl.innerHTML = `<p class="empty-state">No upcoming sessions yet — claim a session above to get started.</p>`;
    return;
  }

  upcomingSessionsListEl.innerHTML = "";

  sessions.forEach((s) => {
    const article = document.createElement("article");
    article.className = "session-card";
    article.dataset.courseId = s.courseId;

    const body = document.createElement("div");
    body.className = "session-card__body";

    if (s.kind === "cover") {
      article.dataset.coverId = s.excusalId;
      body.appendChild(badge(`Covering for ${s.tutorName}`));
    } else if (s.kind === "swap_request") {
      article.dataset.swapId = s.excusalId;
      body.appendChild(
        badge(
          `${s.coverName} asked you to take this over (covering for ${s.tutorName})`,
        ),
      );
    }

    body.insertAdjacentHTML(
      "beforeend",
      `<p class="session-code"></p>
       <h3 class="session-title"></h3>
       <p class="session-meta"><span>${CALENDAR_ICON}<span class="session-when"></span></span></p>`,
    );
    body.querySelector(".session-code").textContent = s.courseCode;
    body.querySelector(".session-title").textContent = s.courseName;
    body.querySelector(".session-when").textContent = s.label;

    if (s.kind === "cover") {
      body.appendChild(s.swapToName ? buildPendingSwap(s) : buildCantMakeIt(s));
    } else if (s.kind === "swap_request") {
      body.appendChild(buildSwapAnswer(s));
    }

    const pill = document.createElement("span");
    pill.className = "status-pill";
    pill.textContent = describeDaysAway(s.daysAway);

    article.append(body, pill);
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

// ---------- hours this month ----------

async function renderHoursMonth() {
  const el = document.getElementById("stat-hours-month");
  if (!el) return;
  try {
    const entries = await getEntries();
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const hours = entries
      .filter((entry) => (entry.date || "").startsWith(monthPrefix))
      .reduce((sum, entry) => sum + Number(entry.hours), 0);
    el.textContent = `${Number(hours.toFixed(1))}h`;
  } catch {
    el.textContent = "0h";
  }
}

// ---------- open modules (claim / apply cards) ----------

// Fetched once and shared: the course cards use it to show their claim
// state, and the "Pending claims" stat counts straight from it.
let myApplicationsPromise = null;

function loadMyApplications() {
  if (!myApplicationsPromise) {
    myApplicationsPromise = fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
    ).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load applications");
      return data;
    });
  }
  return myApplicationsPromise;
}

function refreshApplications() {
  myApplicationsPromise = null;
  return Promise.allSettled([renderCourses(), renderApplicationStats()]);
}

function buildMarkForm() {
  const form = document.createElement("div");
  form.className = "mark-form";
  form.hidden = true;
  form.innerHTML = `
    <div class="form-field">
      <label>Your mark for this module</label>
      <input type="number" class="mark-input" min="0" max="100" placeholder="0-100" />
    </div>
    <div class="form-actions">
      <button type="button" class="submit-mark-btn btn-primary">Submit</button>
      <button type="button" class="cancel-mark-btn btn-secondary">Cancel</button>
    </div>
  `;
  return form;
}

// Wires a claim/apply button + its mark form: open the form, validate the
// mark, POST the application, then refresh the cards and the stat so every
// view agrees on what's been claimed.
function wireApplicationFlow(course, openBtn, markForm) {
  const markInput = markForm.querySelector(".mark-input");
  const submitMarkBtn = markForm.querySelector(".submit-mark-btn");
  const cancelMarkBtn = markForm.querySelector(".cancel-mark-btn");

  openBtn.addEventListener("click", () => {
    openBtn.hidden = true;
    markForm.hidden = false;
    markInput.value = "";
    markInput.focus();
  });

  cancelMarkBtn.addEventListener("click", () => {
    markForm.hidden = true;
    openBtn.hidden = false;
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

      showToast(
        `Applied for ${course.course_code} — waiting for organiser approval`,
      );
      refreshApplications();
    } catch (err) {
      showToast("Something went wrong, try again");
      submitMarkBtn.disabled = false;
    }
  });
}

// Dashboard card: the course's next session, styled like the prototype's
// "Available volunteer sessions" rows.
function buildSessionCard(course, myApp) {
  const card = document.createElement("article");
  card.className = "session-card";
  card.dataset.courseId = course.id;

  const body = document.createElement("div");
  body.className = "session-card__body";
  body.insertAdjacentHTML(
    "beforeend",
    `<p class="session-code"></p>
     <h3 class="session-title"></h3>
     <p class="session-meta"></p>`,
  );
  body.querySelector(".session-code").textContent = course.course_code;
  body.querySelector(".session-title").textContent = course.course_name;

  const metaEl = body.querySelector(".session-meta");
  const next = nextSessionOccurrence(course);
  if (next) {
    const duration = formatDuration(next.start, next.end);
    metaEl.innerHTML = `<span>${CALENDAR_ICON}<span class="session-when"></span></span><span>${CLOCK_ICON}<span class="session-duration"></span></span>`;
    metaEl.querySelector(".session-when").textContent = formatDate(
      toLocalDateStr(next.date),
    );
    metaEl.querySelector(".session-duration").textContent =
      `${next.start.slice(0, 5)}${duration ? ` · ${duration}` : ""}`;
  } else {
    metaEl.remove();
  }

  if (course.department) {
    const note = document.createElement("p");
    note.className = "session-note";
    note.textContent = course.department;
    body.appendChild(note);
  }

  card.appendChild(body);

  if (myApp) card.dataset.applicationId = myApp.id;

  if (myApp?.status === "rejected") {
    // The unique (user, course) constraint blocks a fresh application, so
    // offer to clear the rejected one first — the recovery path the old
    // applications list used to provide.
    const note = document.createElement("p");
    note.className = "session-note";
    note.textContent = "Your last application for this module wasn't accepted.";
    const reapplyBtn = document.createElement("button");
    reapplyBtn.type = "button";
    reapplyBtn.className = "btn-link";
    reapplyBtn.textContent = "Remove & volunteer again";
    reapplyBtn.style.marginTop = "8px";
    reapplyBtn.addEventListener("click", () =>
      removeVolunteerApplication(course.id),
    );
    body.append(note, reapplyBtn);
    return card;
  }

  if (myApp?.status === "pending" || myApp?.status === "approved") {
    const pill = document.createElement("span");
    pill.className = "claimed-pill";
    pill.textContent =
      myApp.status === "pending"
        ? "Claimed by you — awaiting approval"
        : "You're a volunteer on this module";
    body.appendChild(pill);
    return card;
  }

  const volunteerBtn = document.createElement("button");
  volunteerBtn.type = "button";
  volunteerBtn.className = "volunteer-btn";
  volunteerBtn.textContent = "Volunteer";

  const markForm = buildMarkForm();
  card.append(volunteerBtn, markForm);
  wireApplicationFlow(course, volunteerBtn, markForm);
  return card;
}

async function renderCourses() {
  if (!courseListEl) return;

  let courses;
  let applications = [];
  try {
    const [coursesRes, apps] = await Promise.all([
      fetch("/api/courses"),
      loadMyApplications().catch(() => {
        myApplicationsPromise = null;
        return [];
      }),
    ]);
    if (!coursesRes.ok) throw new Error("Failed to load courses");
    courses = await coursesRes.json();
    applications = apps;
  } catch (err) {
    courseListEl.innerHTML = `<p class="empty-state">Couldn't load courses right now.</p>`;
    return;
  }

  const myByCourseId = new Map(applications.map((app) => [app.course_id, app]));

  // Only show courses that still need tutors - hide ones already fully staffed.
  const openCourses = courses.filter(
    (course) => (course.no_of_tutors_assigned || 0) < course.tutors_needed,
  );

  setStat("stat-open-sessions", String(openCourses.length));
  if (availableHintEl) {
    availableHintEl.textContent = `${openCourses.length} currently open`;
  }

  courseListEl.innerHTML = "";

  if (openCourses.length === 0) {
    courseListEl.innerHTML = `<p class="empty-state">No courses need tutors right now — check back soon.</p>`;
    return;
  }

  openCourses.forEach((course) => {
    courseListEl.appendChild(
      buildSessionCard(course, myByCourseId.get(course.id)),
    );
  });
}

// ---------- my applications ----------

// Feeds the "Pending claims" stat — how many applications an organiser
// hasn't reviewed yet. Each card above shows its own application state.
async function renderApplicationStats() {
  let applications;
  try {
    applications = await loadMyApplications();
  } catch {
    setStat("stat-pending-claims", "0");
    return;
  }

  setStat(
    "stat-pending-claims",
    String(applications.filter((app) => app.status === "pending").length),
  );
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
    refreshApplications();
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
    selector: ".stat-grid",
    title: "Your dashboard",
    body: "See open opportunities, pending claims, completed hours, and upcoming sessions at a glance.",
    placement: "bottom",
  },
  {
    selector: "#courseList",
    title: "Available sessions",
    body: "Sessions you can volunteer for. Claim one, enter the mark you got in that module, and an organiser will review it.",
    placement: "top",
  },
  {
    selector: "#upcomingSessionsList",
    title: "Your upcoming sessions",
    body: "Sessions you're approved for or covering — including swap requests from other volunteers.",
    placement: "top",
  },
  {
    selector: "a[href='volunteer-log-hours.html']",
    title: "Log your hours",
    body: "After a session, submit your attendance here so it shows up under Completed sessions.",
    placement: "bottom",
  },
];

const tourLink = document.getElementById("tour-link");
if (tourLink) {
  tourLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (isDashboard) {
      window.Onboarding?.start(VOLUNTEER_TOUR_STEPS, {
        tourId: "volunteer-dashboard",
        userId: currentUser.id,
        force: true,
      });
    } else {
      // The tour points at the dashboard's pieces — send people there (the
      // dashboard sees ?tour=1 and shows the tour itself).
      window.location.href = "StudentView.html?tour=1";
    }
  });
}

// ---------- init ----------

(async () => {
  // allSettled, not all: one widget's fetch failing (e.g. hours this month)
  // shouldn't stop the others from rendering — including the highlights
  // below, which need the lists above to have rendered first.
  await Promise.allSettled([
    renderHoursMonth(),
    renderCourses(),
    renderApplicationStats(),
    fetchUpcomingSessions(),
    // The transcript panel is below the course boards on this page; a
    // volunteer application isn't accepted until one is on file.
    initTranscriptUpload(currentUser.id),
  ]);

  // Arriving from a "session changed" notification — scroll to and flash
  // the session card it was about, now that the list containing it has
  // rendered.
  const highlightCourseId = consumeQueryParam("highlightCourse");
  if (highlightCourseId) {
    scrollAndHighlight(
      upcomingSessionsListEl?.querySelector(
        `[data-course-id="${CSS.escape(highlightCourseId)}"]`,
      ),
    );
  }

  // Arriving from a "you're covering a session" notification — flash that
  // cover (it may be gone if it was cancelled or handed on; that's fine).
  const highlightCoverId = consumeQueryParam("highlightCover");
  if (highlightCoverId) {
    scrollAndHighlight(
      upcomingSessionsListEl?.querySelector(
        `[data-cover-id="${CSS.escape(highlightCoverId)}"]`,
      ),
    );
  }

  // Arriving from a "someone asked you to take over a session" notification.
  const highlightSwapId = consumeQueryParam("highlightSwap");
  if (highlightSwapId) {
    scrollAndHighlight(
      upcomingSessionsListEl?.querySelector(
        `[data-swap-id="${CSS.escape(highlightSwapId)}"]`,
      ),
    );
  }

  // Arriving from a "volunteer application status changed" notification —
  // flash the card for that module (it shows your application's state).
  const highlightApplicationId = consumeQueryParam("highlightApplication");
  if (highlightApplicationId) {
    scrollAndHighlight(
      courseListEl?.querySelector(
        `[data-application-id="${CSS.escape(highlightApplicationId)}"]`,
      ),
    );
  }

  // ?tour=1 is set by the "Take a Tour" links on the other volunteer pages,
  // which bounce visitors here because the tour points at the dashboard.
  const wantsTour = consumeQueryParam("tour") === "1";

  if (isDashboard) {
    window.Onboarding?.start(VOLUNTEER_TOUR_STEPS, {
      tourId: "volunteer-dashboard",
      userId: currentUser.id,
      force: wantsTour,
    });
  }
})();
