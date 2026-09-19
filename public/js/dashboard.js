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

// ---------- apply to tutor a subject ----------

const applyBtn = document.getElementById("apply-to-tutor-btn");
const applyModal = document.getElementById("apply-modal");
const applyForm = document.getElementById("apply-form");
const applyError = document.getElementById("apply-form-error");
const applySubmitBtn = document.getElementById("apply-submit-btn");
const courseSelect = document.getElementById("apply-course-select");
const courseMeta = document.getElementById("apply-course-meta");
const yearSelect = document.getElementById("apply-year-select");
const markInput = document.getElementById("apply-mark-input");
const availabilitySelect = document.getElementById("apply-availability-select");
const availabilityLabel = document.getElementById("apply-availability-label");
const applicationsListEl = document.getElementById("applications-list");
const applicationsItemsEl = document.getElementById("applications-items");
const toastEl = document.getElementById("toast");

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

let COURSES = [];
let myApplications = [];
let myAcademicLevel = null;
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

async function fetchCourses() {
  try {
    const res = await fetch("/api/courses");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load courses");
    COURSES = rows;
  } catch {
    showToast("Couldn't load courses from the database.");
    COURSES = [];
  }
}

async function fetchMyAcademicLevel(tutorId) {
  try {
    const res = await fetch(`/api/tutors/${encodeURIComponent(tutorId)}`);
    const row = await res.json();
    if (!res.ok) throw new Error(row.error || "Failed to load tutor record");
    myAcademicLevel = row.academic_level || null;
  } catch {
    myAcademicLevel = null;
  }
}

async function fetchMyApplications(tutorId) {
  try {
    const res = await fetch(
      `/api/tutor-applications?tutorId=${encodeURIComponent(tutorId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load applications");
    myApplications = rows;
  } catch {
    myApplications = [];
  }
  renderApplicationsList();
}

function renderApplicationsList() {
  if (myApplications.length === 0) {
    applicationsListEl.hidden = true;
    return;
  }
  applicationsListEl.hidden = false;
  applicationsItemsEl.innerHTML = "";

  myApplications.forEach((app) => {
    const li = document.createElement("li");
    li.className = "application-row";
    const course = app.courses;
    const status = (app.status || "pending").toLowerCase();
    li.innerHTML = `
      <span>${course ? `${course.course_code} — ${course.course_name}` : "Course"}</span>
      <span class="status-pill ${status}">${status}</span>
      ${
        status === "rejected" && app.rejection_reason
          ? `<p class="hint">Reason: ${app.rejection_reason}</p>`
          : ""
      }
      ${status === "rejected" ? `<button type="button" class="btn-link" data-action="remove-application">Remove &amp; apply again</button>` : ""}
    `;
    if (status === "rejected") {
      li.querySelector('[data-action="remove-application"]').addEventListener(
        "click",
        () => removeApplication(app.id),
      );
    }
    applicationsItemsEl.appendChild(li);
  });
}

// Lets a tutor dismiss a rejected application themselves rather than
// waiting on an organiser to move it back to pending — the course frees
// up in the apply dropdown as soon as this resolves.
async function removeApplication(id) {
  if (!confirm("Remove this application? You'll be able to apply for this course again.")) return;
  try {
    const res = await fetch(`/api/tutor-applications/${id}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Couldn't remove that application.");
      return;
    }
    showToast("Application removed.");
    const user = getCurrentUser();
    if (user) await fetchMyApplications(user.id);
  } catch {
    showToast("Network error — couldn't reach the server.");
  }
}

function populateCourseSelect() {
  const appliedCourseIds = new Set(myApplications.map((a) => a.course_id));

  courseSelect.innerHTML =
    '<option value="" disabled selected>Choose a course&hellip;</option>';
  COURSES.forEach((course) => {
    const option = document.createElement("option");
    option.value = course.id;
    option.textContent = `${course.course_code} — ${course.course_name}`;
    if (appliedCourseIds.has(course.id)) {
      option.textContent += " (already applied)";
      option.disabled = true;
    }
    courseSelect.appendChild(option);
  });
}

function updateCourseMeta() {
  const course = COURSES.find((c) => String(c.id) === courseSelect.value);
  if (!course) {
    courseMeta.hidden = true;
    availabilityLabel.textContent = "Are you free at the tutorial time?";
    return;
  }

  const session = formatSession(course);
  courseMeta.hidden = false;
  courseMeta.textContent = session
    ? `Requires a mark of ${course.min_mark}+ · tutorial is ${session}`
    : `Requires a mark of ${course.min_mark}+ · tutorial day/time not yet set`;

  availabilityLabel.textContent = session
    ? `Are you free on ${session}?`
    : "Are you free at the tutorial time?";
}

function openApplyModal() {
  const user = getCurrentUser();
  if (!user) {
    showToast("Please log in as a tutor to apply.");
    return;
  }

  applyForm.reset();
  applyError.hidden = true;
  populateCourseSelect();
  updateCourseMeta();
  if (myAcademicLevel) yearSelect.value = myAcademicLevel;
  applyModal.showModal();
}

function closeApplyModal() {
  applyModal.close();
}

applyBtn?.addEventListener("click", openApplyModal);
document
  .getElementById("apply-modal-close-btn")
  ?.addEventListener("click", closeApplyModal);
document
  .getElementById("apply-cancel-btn")
  ?.addEventListener("click", closeApplyModal);
applyModal?.addEventListener("click", (e) => {
  if (e.target === applyModal) closeApplyModal();
});
courseSelect?.addEventListener("change", updateCourseMeta);

applyForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  applyError.hidden = true;

  const user = getCurrentUser();
  if (!user) {
    showToast("Please log in as a tutor to apply.");
    return;
  }

  const payload = {
    tutorId: user.id,
    courseId: Number(courseSelect.value),
    academicLevel: yearSelect.value,
    mark: Number(markInput.value),
    availability: availabilitySelect.value === "true",
  };

  applySubmitBtn.disabled = true;
  applySubmitBtn.textContent = "Submitting…";

  try {
    const res = await fetch("/api/tutor-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    if (!res.ok) {
      applyError.textContent =
        body.error || "Couldn't submit that application.";
      applyError.hidden = false;
      return;
    }

    closeApplyModal();
    showToast("Application submitted!");
    myAcademicLevel = payload.academicLevel;
    await fetchMyApplications(user.id);
  } catch {
    applyError.textContent = "Network error — couldn't reach the server.";
    applyError.hidden = false;
  } finally {
    applySubmitBtn.disabled = false;
    applySubmitBtn.textContent = "Submit application";
  }
});

// ---------- guided tour ----------

const TUTOR_TOUR_STEPS = [
  {
    selector: ".card:has(#welcome-heading)",
    title: "Welcome",
    body: "Your tutoring hub — log hours for the week, review timesheets, and keep an eye on your weekly limit from here.",
    placement: "bottom",
  },
  {
    selector: ".card:has(#apply-to-tutor-btn)",
    title: "Apply to tutor a subject",
    body: "Pick a course that needs tutors, confirm your mark and availability, and it'll go to the organiser board for approval. Track the status of your applications right here once you've applied.",
    placement: "bottom",
  },
  {
    selector: ".card:has(#excuse-btn)",
    title: "Excuse yourself from a session",
    body: "Can't make a tutorial? Let the organiser know which session and why — they can find cover if needed.",
    placement: "bottom",
  },
  {
    selector: ".stat-grid",
    title: "Your week at a glance",
    body: "Hours worked so far this week, how many you have left before your weekly limit, and your next upcoming session.",
    placement: "top",
  },
  {
    selector: ".tile-grid",
    title: "Quick links",
    body: "Jump straight to logging hours, reviewing timesheets, or your calendar — where your imported class schedule lives, with support for cancelling or editing a single class occurrence.",
    placement: "top",
  },
  {
    selector: ".tab-nav",
    title: "Get around",
    body: "These tabs are always here at the top, wherever you are in the app.",
    placement: "bottom",
  },
];

const tourLink = document.getElementById("tour-link");
if (tourLink) {
  tourLink.addEventListener("click", (e) => {
    e.preventDefault();
    window.Onboarding?.start(TUTOR_TOUR_STEPS, {
      tourId: "tutor-dashboard",
      userId: getCurrentUser()?.id,
      force: true,
    });
  });
}

(async function initApply() {
  await fetchCourses();
  const user = getCurrentUser();
  if (user) {
    await fetchMyAcademicLevel(user.id);
    await fetchMyApplications(user.id);
    await fetchMyExcusals(user.id);
  }

  window.Onboarding?.start(TUTOR_TOUR_STEPS, {
    tourId: "tutor-dashboard",
    userId: user?.id,
  });
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