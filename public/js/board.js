const COURSES = [];

// ---------- state ----------

let activeCourseId = null;
let tutorCount = 0; // total tutors in the system, for the header stat
let volunteerCounts = {}; // course_id -> number of approved volunteers
let shortfallOnly = false; // when true, course rail shows only short-staffed courses, worst-first
let pendingApplicationCounts = {}; // course_id -> number of pending tutor applications
let pendingVolunteerCounts = {}; // course_id -> number of pending student volunteers

// ---------- data loading ----------

function mapCourseRow(row) {
  return {
    id: row.id,
    code: row.course_code,
    name: row.course_name,
    minMark: row.min_mark,
    department: row.department,
    hoursNeeded: row.hours_per_week,
    tutorsNeeded: row.tutors_needed,
    tutorsAssigned: row.no_of_tutors_assigned ?? 0,
    dayOfTut: row.Day_of_tut,
    startTime: row.tutor_start_time,
    endTime: row.tutor_end_time,
    budget: row.budget,
    session:
      row.Day_of_tut && row.tutor_start_time && row.tutor_end_time
        ? {
            day: row.Day_of_tut,
            start: row.tutor_start_time.slice(0, 5),
            end: row.tutor_end_time.slice(0, 5),
          }
        : null,
  };
}

async function fetchCourses() {
  try {
    const res = await fetch("/api/courses");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load courses");

    COURSES.length = 0;
    rows.forEach((row) => COURSES.push(mapCourseRow(row)));
  } catch (err) {
    showToast("Couldn't load courses from the database.");
  }
  renderCourseList();
  renderDetail();
}

async function fetchVolunteerCounts() {
  try {
    const res = await fetch("/api/course-volunteers/counts?status=approved");
    const counts = await res.json();
    if (!res.ok) throw new Error(counts.error || "Failed to load volunteers");
    volunteerCounts = counts;
  } catch (err) {
    volunteerCounts = {};
  }
  renderCourseList();
  renderDetail();
}

let TUTORS_BY_ID = {}; // tutor_id -> { name, hourly_rate }

async function fetchTutorCount() {
  try {
    const res = await fetch("/api/tutors");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load tutors");
    tutorCount = rows.length;
    TUTORS_BY_ID = Object.fromEntries(
      rows.map((t) => [t.id, { name: t.name, hourlyRate: t.hourly_rate }]),
    );
  } catch (err) {
    tutorCount = 0;
    TUTORS_BY_ID = {};
  }
  statTutorsEl.textContent = tutorCount;
}

// No dedicated "pending applications across all courses" endpoint exists,
// so this fetches per-course the same way renderApplicants() already does,
// just for every course at once, and keeps only the counts.
async function fetchPendingApplicationCounts() {
  if (COURSES.length === 0) {
    pendingApplicationCounts = {};
    renderCourseList();
    return;
  }
  try {
    const results = await Promise.all(
      COURSES.map(async (course) => {
        const res = await fetch(
          `/api/tutor-applications?courseId=${course.id}`,
        );
        const rows = await res.json();
        if (!res.ok) throw new Error(rows.error || "Failed to load applications");
        const pending = rows.filter(
          (a) => (a.status || "pending").toLowerCase() === "pending",
        ).length;
        return [course.id, pending];
      }),
    );
    pendingApplicationCounts = Object.fromEntries(results);
  } catch (err) {
    // Fails open, same as the rest of the board: badges just show 0 rather
    // than blocking the page if one course's fetch has a hiccup.
    pendingApplicationCounts = {};
  }
  renderCourseList();
}

// Assumes /api/course-volunteers/counts accepts status=pending the same
// way it already accepts status=approved (see fetchVolunteerCounts above).
async function fetchPendingVolunteerCounts() {
  try {
    const res = await fetch("/api/course-volunteers/counts?status=pending");
    const counts = await res.json();
    if (!res.ok) throw new Error(counts.error || "Failed to load volunteers");
    pendingVolunteerCounts = counts;
  } catch (err) {
    pendingVolunteerCounts = {};
  }
  renderCourseList();
}

// ---------- helpers ----------

function initials(name) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ---------- rendering: course rail ----------

const courseListEl = document.getElementById("courseList");
const courseSearchEl = document.getElementById("courseSearch");
const shortfallToggleEl = document.getElementById("shortfallToggle");
const statFilledEl = document.getElementById("statFilled");
const statTutorsEl = document.getElementById("statTutors");
const statPendingEl = document.getElementById("statPending");

function shortfall(course) {
  return course.tutorsNeeded ? course.tutorsNeeded - course.tutorsAssigned : 0;
}

// Total items on this course awaiting an organiser's decision: pending
// tutor applications + pending student volunteers.
function pendingCount(course) {
  return (
    (pendingApplicationCounts[course.id] || 0) +
    (pendingVolunteerCounts[course.id] || 0)
  );
}

function renderCourseList() {
  const query = courseSearchEl.value.trim().toLowerCase();
  const filled = COURSES.filter(
    (c) => c.tutorsNeeded && c.tutorsAssigned >= c.tutorsNeeded,
  ).length;
  statFilledEl.textContent = `${filled} / ${COURSES.length}`;

  const totalPending = COURSES.reduce((sum, c) => sum + pendingCount(c), 0);
  statPendingEl.textContent = totalPending;
  statPendingEl.classList.toggle("stat-value--attention", totalPending > 0);

  courseListEl.innerHTML = "";

  let visible = COURSES.filter(
    (c) =>
      !query ||
      c.code.toLowerCase().includes(query) ||
      c.name.toLowerCase().includes(query),
  );

  if (shortfallOnly) {
    visible = visible
      .filter((c) => shortfall(c) > 0)
      .sort((a, b) => shortfall(b) - shortfall(a));
  }

  visible.forEach((course) => {
    const li = document.createElement("li");
    const isFull =
      !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;
    const pending = pendingCount(course);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "course-card" + (course.id === activeCourseId ? " active" : "");
    btn.setAttribute("aria-pressed", course.id === activeCourseId);
    btn.innerHTML = `
        <span class="course-code">${course.code}</span>
        <span class="course-name">${course.name}</span>
        <div class="card-foot">
          <span>${course.tutorsAssigned} / ${course.tutorsNeeded ?? "—"} assigned, ${volunteerCounts[course.id] ?? 0} volunteered</span>
          <span class="status-pill ${isFull ? "filled" : "open"}">${isFull ? "Staffed" : shortfall(course) > 0 ? `Short ${shortfall(course)}` : "Open"}</span>
          ${pending > 0 ? `<span class="status-pill pending">${pending} to review</span>` : ""}
        </div>
      `;
    btn.addEventListener("click", () => selectCourse(course.id));
    li.appendChild(btn);
    courseListEl.appendChild(li);
  });
}

// ---------- rendering: detail pane ----------

const emptyStateEl = document.getElementById("emptyState");
const courseDetailEl = document.getElementById("courseDetail");
const assignmentCardEl = document.getElementById("assignmentCard");

function selectCourse(courseId) {
  activeCourseId = courseId;
  renderCourseList();
  renderDetail();
}

function renderDetail() {
  if (!activeCourseId) {
    emptyStateEl.hidden = false;
    courseDetailEl.hidden = true;
    return;
  }
  emptyStateEl.hidden = true;
  courseDetailEl.hidden = false;

  const course = COURSES.find((c) => c.id === activeCourseId);

  document.getElementById("dCode").textContent = course.code;
  document.getElementById("dName").textContent = course.name;
  const timeRange =
    course.startTime && course.endTime
      ? `${course.startTime.slice(0, 5)}–${course.endTime.slice(0, 5)}`
      : null;
  document.getElementById("dSession").textContent = course.session
    ? `${course.session.day} · ${course.session.start}–${course.session.end}  ·  requires a mark of ${course.minMark}+`
    : `${course.department}  ·  requires a mark of ${course.minMark}+  ·  ${timeRange ? timeRange : "not yet scheduled"}`;
  document.getElementById("dHours").textContent = course.hoursNeeded ?? "—";
  document.getElementById("dTutorsAssigned").textContent =
    `${course.tutorsAssigned} / ${course.tutorsNeeded ?? "—"}`;
  document.getElementById("dVolunteered").textContent =
    volunteerCounts[course.id] ?? 0;
  document.getElementById("dBudget").textContent = formatMoney(course.budget);
  document.getElementById("dRemainingBudget").textContent = "—";

  renderAssignmentCard(course);
  renderApplicants(course);
  renderExcusals(course);
  renderVolunteers(course);
}

function formatMoney(value) {
  if (value == null) return "Not set";
  return `R${Number(value).toFixed(2)}`;
}

// Weekly cost projection: budget minus each currently-assigned (approved)
// tutor's hourly_rate × this course's hours_per_week. This is a forward-
// looking projection based on who's assigned right now — for actual
// logged-hours cost over time, see the Hours & Budget report page.
function renderRemainingBudget(course, applicantRows) {
  const remainingEl = document.getElementById("dRemainingBudget");
  if (course.budget == null) {
    remainingEl.textContent = "No budget set";
    return;
  }

  const approved = applicantRows.filter(
    (app) => (app.status || "").toLowerCase() === "approved",
  );
  const hasUnknownRate = approved.some(
    (app) => TUTORS_BY_ID[app.tutor_id]?.hourlyRate == null,
  );
  const weeklyCost = approved.reduce((sum, app) => {
    const rate = TUTORS_BY_ID[app.tutor_id]?.hourlyRate;
    return sum + (rate != null ? rate * (course.hoursNeeded || 0) : 0);
  }, 0);

  const remaining = course.budget - weeklyCost;
  remainingEl.textContent =
    formatMoney(remaining) + (hasUnknownRate ? " (partial — some rates unknown)" : "");
  remainingEl.classList.toggle("stat-value--attention", remaining < 0);
}

// ---------- applications ----------

const LEVEL_LABELS = {
  second_year: "2nd year",
  third_year: "3rd year",
  honours: "Honours",
  masters: "Masters",
  phd: "PhD",
};

const applicantListEl = document.getElementById("applicantList");
const applicantsEmptyEl = document.getElementById("applicantsEmpty");

let applicantsRequestId = 0;

// Live timetable-clash + weekly-hours check for one tutor against one course.
// Fails open (returns null) so a check-endpoint hiccup never blocks rendering
// the applicant list — the stamps just don't show for that row.
async function fetchAssignmentCheck(tutorId, courseId) {
  try {
    const res = await fetch(
      `/api/tutors/${tutorId}/assignment-check?courseId=${courseId}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "assignment-check failed");
    return data;
  } catch (err) {
    return null;
  }
}

function hasClash(check) {
  return (
    !!check &&
    (check.clashes.busyTimeClashes.length > 0 ||
      check.clashes.courseClashes.length > 0)
  );
}

function buildClashStamp(check) {
  if (!check) return "";
  const { busyTimeClashes, courseClashes } = check.clashes;
  if (busyTimeClashes.length === 0 && courseClashes.length === 0) {
    return `<span class="stamp ok">No timetable clashes</span>`;
  }
  if (busyTimeClashes.length > 0) {
    const b = busyTimeClashes[0];
    return `<span class="stamp warn">Clashes with ${b.title || "your timetable"} (${b.start_time.slice(0, 5)}–${b.end_time.slice(0, 5)})</span>`;
  }
  const c = courseClashes[0];
  return `<span class="stamp warn">Clashes with ${c.course_code} (${c.tutor_start_time.slice(0, 5)}–${c.tutor_end_time.slice(0, 5)})</span>`;
}

function buildWorkloadStamp(check) {
  if (!check) return "";
  const { weeklyHourCap, projectedHours } = check.workload;
  if (weeklyHourCap == null) {
    return `<span class="stamp">${projectedHours} hrs/wk · no cap set</span>`;
  }
  const over = projectedHours > weeklyHourCap;
  return `<span class="stamp ${over ? "blocked" : "ok"}">${projectedHours}/${weeklyHourCap} hrs/wk${over ? " · over cap" : ""}</span>`;
}

async function renderApplicants(course) {
  const requestId = ++applicantsRequestId;
  applicantListEl.innerHTML = "";
  applicantsEmptyEl.hidden = true;

  let rows = [];
  try {
    const res = await fetch(`/api/tutor-applications?courseId=${course.id}`);
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load applications");
  } catch (err) {
    if (requestId === applicantsRequestId)
      showToast("Couldn't load applications for this course.");
    return;
  }

  // the active course may have changed while this request was in flight
  if (requestId !== applicantsRequestId) return;

  renderRemainingBudget(course, rows);

  if (rows.length === 0) {
    applicantsEmptyEl.hidden = false;
    return;
  }

  const checks = await Promise.all(
    rows.map((app) => fetchAssignmentCheck(app.tutor_id, course.id)),
  );

  if (requestId !== applicantsRequestId) return;

  rows.forEach((app, i) => {
    const check = checks[i];
    const tutor = app.tutors;
    const name = app.Tutor_name || tutor?.name || "Unknown";
    const status = (app.status || "pending").toLowerCase();
    const levelLabel = LEVEL_LABELS[tutor?.academic_level] || "Year not set";
    const markStamp =
      typeof app.tutor_mark === "number" && app.tutor_mark >= course.minMark
        ? `<span class="stamp ok">Mark ${app.tutor_mark}</span>`
        : `<span class="stamp blocked">Mark ${app.tutor_mark} · below ${course.minMark}</span>`;
    const availabilityStamp = app.Availability
      ? `<span class="stamp ok">Free at tutorial time</span>`
      : `<span class="stamp blocked">Not free at tutorial time</span>`;

    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tutor-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="avatar">${initials(name)}</span>
      <span class="name-block">
        <span class="name">${name}</span>
        <span class="role">${levelLabel}</span>
      </span>
      <span class="stamp-row">
        ${markStamp}
        ${availabilityStamp}
        ${buildClashStamp(check)}
        ${buildWorkloadStamp(check)}
      </span>
      <span class="status-pill ${status}">${status}</span>
      <span class="applicant-actions"></span>
    `;

    const actionsEl = row.querySelector(".applicant-actions");
    const isFull =
      !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;
    const overCap = check?.workload?.overCap;

    if (status === "pending") {
      actionsEl.appendChild(
        makeApplicantActionBtn(
          "Approve",
          "approve",
          () => {
            if (
              hasClash(check) &&
              !confirm(`${name} has a timetable clash — assign anyway?`)
            ) {
              return;
            }
            setApplicationStatus(course, app, "approved", name);
          },
          (isFull && "This course already has all the tutors it needs") ||
            (overCap &&
              `This would put ${name} at ${check.workload.projectedHours} hrs/week, over their ${check.workload.weeklyHourCap} hr cap`),
        ),
      );
      actionsEl.appendChild(
        makeApplicantActionBtn("Reject", "", () =>
          openRejectReasonModal(`Reject ${name}'s application?`, (reason) =>
            setApplicationStatus(course, app, "rejected", name, reason),
          ),
        ),
      );
    } else if (status === "approved") {
      actionsEl.appendChild(
        makeApplicantActionBtn("Unassign", "", () =>
          setApplicationStatus(course, app, "pending", name),
        ),
      );
    } else {
      actionsEl.appendChild(
        makeApplicantActionBtn("Reconsider", "", () =>
          setApplicationStatus(course, app, "pending", name),
        ),
      );
    }

    li.appendChild(row);
    applicantListEl.appendChild(li);
  });
}

function makeApplicantActionBtn(label, variant, onClick, disabledTitle) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small" + (variant ? ` ${variant}` : "");
  btn.textContent = label;
  if (disabledTitle) {
    btn.disabled = true;
    btn.title = disabledTitle;
  } else {
    btn.addEventListener("click", onClick);
  }
  return btn;
}

// Collects a required reason before a rejection goes through — the tutor or
// student sees this text next to their rejected status on their own
// dashboard, so it needs to actually say something useful to them.
const rejectReasonModal = document.getElementById("rejectReasonModal");
const rejectReasonForm = document.getElementById("rejectReasonForm");
const rejectReasonHeading = document.getElementById("rejectReasonHeading");
const rejectReasonInput = document.getElementById("rejectReasonInput");
const rejectReasonError = document.getElementById("rejectReasonError");

let pendingRejectConfirm = null; // callback set by whichever button opened the modal

function openRejectReasonModal(title, onConfirm) {
  pendingRejectConfirm = onConfirm;
  rejectReasonHeading.textContent = title;
  rejectReasonForm.reset();
  rejectReasonError.hidden = true;
  rejectReasonModal.showModal();
  rejectReasonInput.focus();
}

function closeRejectReasonModal() {
  pendingRejectConfirm = null;
  rejectReasonModal.close();
}

document
  .getElementById("rejectReasonCloseBtn")
  .addEventListener("click", closeRejectReasonModal);
document
  .getElementById("rejectReasonCancelBtn")
  .addEventListener("click", closeRejectReasonModal);
rejectReasonModal.addEventListener("click", (e) => {
  if (e.target === rejectReasonModal) closeRejectReasonModal();
});

rejectReasonForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const reason = rejectReasonInput.value.trim();
  if (!reason) {
    rejectReasonError.textContent = "A reason is required.";
    rejectReasonError.hidden = false;
    return;
  }
  const confirmCallback = pendingRejectConfirm;
  closeRejectReasonModal();
  confirmCallback?.(reason);
});

async function setApplicationStatus(course, app, status, name, rejectionReason) {
  const previousStatus = (app.status || "pending").toLowerCase();
  try {
    const res = await fetch(`/api/tutor-applications/${app.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, rejectionReason }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that application.");
      return;
    }
    const messages = {
      approved: `${name} assigned to ${course.code}`,
      rejected: `${name}'s application rejected`,
      pending: `${name} moved back to pending`,
    };
    showToast(messages[status] || "Application updated.");

    // Update the pending badge locally instead of re-fetching every
    // course's applications again just to recompute one count.
    const wasPending = previousStatus === "pending";
    const isPending = status === "pending";
    if (wasPending !== isPending) {
      const current = pendingApplicationCounts[course.id] || 0;
      pendingApplicationCounts[course.id] = Math.max(
        0,
        current + (isPending ? 1 : -1),
      );
    }

    await fetchCourses();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

// ---------- session excusals ----------

const excusalListEl = document.getElementById("excusalList");
const excusalsEmptyEl = document.getElementById("excusalsEmpty");

let excusalsRequestId = 0;

async function renderExcusals(course) {
  const requestId = ++excusalsRequestId;
  excusalListEl.innerHTML = "";
  excusalsEmptyEl.hidden = true;

  let rows = [];
  try {
    const res = await fetch(`/api/session-excusals?courseId=${course.id}`);
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load excusals");
  } catch (err) {
    if (requestId === excusalsRequestId)
      showToast("Couldn't load session excusals for this course.");
    return;
  }

  if (requestId !== excusalsRequestId) return;

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter((e) => e.session_date >= today);

  if (upcoming.length === 0) {
    excusalsEmptyEl.hidden = false;
    return;
  }

  upcoming.forEach((excusal) => {
    const name = excusal.tutors?.name || "Unknown";

    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tutor-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="avatar">${initials(name)}</span>
      <span class="name-block">
        <span class="name">${name}</span>
        <span class="role">${excusal.session_date}${excusal.reason ? ` — ${excusal.reason}` : ""}</span>
      </span>
    `;

    li.appendChild(row);
    excusalListEl.appendChild(li);
  });
}

// ---------- volunteers ----------

const volunteerListEl = document.getElementById("volunteerList");
const volunteersEmptyEl = document.getElementById("volunteersEmpty");

let volunteersRequestId = 0;

async function renderVolunteers(course) {
  const requestId = ++volunteersRequestId;
  volunteerListEl.innerHTML = "";
  volunteersEmptyEl.hidden = true;

  let rows = [];
  try {
    const res = await fetch(`/api/course-volunteers?courseId=${course.id}`);
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load volunteers");
  } catch (err) {
    if (requestId === volunteersRequestId)
      showToast("Couldn't load volunteers for this course.");
    return;
  }

  // the active course may have changed while this request was in flight
  if (requestId !== volunteersRequestId) return;

  if (rows.length === 0) {
    volunteersEmptyEl.hidden = false;
    return;
  }

  rows.forEach((vol) => {
    const student = vol.users;
    const name = student?.name || "Unknown";
    const status = (vol.status || "pending").toLowerCase();
    const markStamp =
      typeof vol.mark === "number"
        ? `<span class="stamp ok">Mark ${vol.mark}</span>`
        : "";

    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tutor-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="avatar">${initials(name)}</span>
      <span class="name-block">
        <span class="name">${name}</span>
        <span class="role">${student?.email || ""}</span>
      </span>
      <span class="stamp-row">
        ${markStamp}
      </span>
      <span class="status-pill ${status}">${status}</span>
      <span class="applicant-actions"></span>
    `;

    const actionsEl = row.querySelector(".applicant-actions");

    if (status === "pending") {
      actionsEl.appendChild(
        makeApplicantActionBtn("Approve", "approve", () =>
          setVolunteerStatus(course, vol, "approved", name),
        ),
      );
      actionsEl.appendChild(
        makeApplicantActionBtn("Reject", "", () =>
          openRejectReasonModal(`Reject ${name}'s volunteer request?`, (reason) =>
            setVolunteerStatus(course, vol, "rejected", name, reason),
          ),
        ),
      );
    } else {
      actionsEl.appendChild(
        makeApplicantActionBtn("Reconsider", "", () =>
          setVolunteerStatus(course, vol, "pending", name),
        ),
      );
    }

    li.appendChild(row);
    volunteerListEl.appendChild(li);
  });
}

async function setVolunteerStatus(course, vol, status, name, rejectionReason) {
  const previousStatus = (vol.status || "pending").toLowerCase();
  try {
    const res = await fetch(`/api/course-volunteers/${vol.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, rejectionReason }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that volunteer.");
      return;
    }
    const messages = {
      approved: `${name} approved for ${course.code}`,
      rejected: `${name}'s volunteer request rejected`,
      pending: `${name} moved back to pending`,
    };
    showToast(messages[status] || "Volunteer updated.");

    const wasPending = previousStatus === "pending";
    const isPending = status === "pending";
    if (wasPending !== isPending) {
      const current = pendingVolunteerCounts[course.id] || 0;
      pendingVolunteerCounts[course.id] = Math.max(
        0,
        current + (isPending ? 1 : -1),
      );
    }

    renderVolunteers(course);
    fetchVolunteerCounts();
    renderCourseList();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

function renderAssignmentCard(course) {
  const isFull =
    !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;
  assignmentCardEl.className =
    "assignment-card " + (course.tutorsAssigned > 0 ? "filled" : "empty");
  assignmentCardEl.innerHTML = isFull
    ? `<p class="empty-copy">This course is fully staffed — ${course.tutorsAssigned} of ${course.tutorsNeeded} tutor spots filled.</p>`
    : `<p class="empty-copy">${course.tutorsAssigned} of ${course.tutorsNeeded ?? "—"} tutor spots filled. Approve an applicant below to fill the rest.</p>`;
}

// ---------- add / edit course modal ----------

const addCourseBtn = document.getElementById("addCourseBtn");
const editCourseBtn = document.getElementById("editCourseBtn");
const addCourseModal = document.getElementById("addCourseModal");
const addCourseForm = document.getElementById("addCourseForm");
const addCourseError = document.getElementById("addCourseError");
const addCourseSubmitBtn = document.getElementById("addCourseSubmitBtn");
const addCourseHeading = document.getElementById("addCourseHeading");

let editingCourseId = null; // null = adding a new course, otherwise id of course being edited

function openCourseModal(course = null) {
  editingCourseId = course ? course.id : null;
  addCourseForm.reset();
  addCourseError.hidden = true;

  addCourseHeading.textContent = course ? "Edit course" : "Add a course";
  addCourseSubmitBtn.textContent = course ? "Save changes" : "Add course";

  if (course) {
    document.getElementById("courseCodeInput").value = course.code;
    document.getElementById("courseNameInput").value = course.name;
    document.getElementById("minMarkInput").value = course.minMark;
    document.getElementById("departmentInput").value = course.department ?? "";
    document.getElementById("hoursPerWeekInput").value =
      course.hoursNeeded ?? "";
    document.getElementById("TutorsNeededInput").value =
      course.tutorsNeeded ?? "";
    document.getElementById("budgetInput").value = course.budget ?? "";
    document.getElementById("dayOfTutInput").value = course.dayOfTut ?? "";
    document.getElementById("tutorStartTimeInput").value = course.startTime
      ? course.startTime.slice(0, 5)
      : "";
    document.getElementById("tutorEndTimeInput").value = course.endTime
      ? course.endTime.slice(0, 5)
      : "";
  }

  addCourseModal.showModal();
  document.getElementById("courseCodeInput").focus();
}

function closeCourseModal() {
  addCourseModal.close();
}

addCourseBtn.addEventListener("click", () => openCourseModal());
editCourseBtn.addEventListener("click", () => {
  const course = COURSES.find((c) => c.id === activeCourseId);
  if (course) openCourseModal(course);
});
document
  .getElementById("addCourseCloseBtn")
  .addEventListener("click", closeCourseModal);
document
  .getElementById("addCourseCancelBtn")
  .addEventListener("click", closeCourseModal);

addCourseModal.addEventListener("click", (e) => {
  if (e.target === addCourseModal) closeCourseModal();
});

addCourseForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  addCourseError.hidden = true;

  const hoursValue = document.getElementById("hoursPerWeekInput").value;
  const tutorsNeededValue = document.getElementById("TutorsNeededInput").value;
  const dayOfTutValue = document.getElementById("dayOfTutInput").value.trim();
  const startTimeValue = document.getElementById("tutorStartTimeInput").value;
  const endTimeValue = document.getElementById("tutorEndTimeInput").value;
  const budgetValue = document.getElementById("budgetInput").value;
  const payload = {
    course_code: document.getElementById("courseCodeInput").value.trim(),
    course_name: document.getElementById("courseNameInput").value.trim(),
    min_mark: Number(document.getElementById("minMarkInput").value),
    department: document.getElementById("departmentInput").value.trim(),
    hours_per_week: hoursValue === "" ? null : Number(hoursValue),
    tutors_needed: tutorsNeededValue === "" ? null : Number(tutorsNeededValue),
    day_of_tut: dayOfTutValue === "" ? null : dayOfTutValue,
    tutor_start_time: startTimeValue === "" ? null : startTimeValue,
    tutor_end_time: endTimeValue === "" ? null : endTimeValue,
    budget: budgetValue === "" ? null : Number(budgetValue),
  };

  const isEditing = editingCourseId !== null;
  addCourseSubmitBtn.disabled = true;
  addCourseSubmitBtn.textContent = isEditing ? "Saving…" : "Adding…";

  try {
    const res = await fetch(
      isEditing ? `/api/courses/${editingCourseId}` : "/api/courses",
      {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const body = await res.json();

    if (!res.ok) {
      addCourseError.textContent = body.error || "Couldn't save that course.";
      addCourseError.hidden = false;
      return;
    }

    closeCourseModal();
    showToast(
      isEditing
        ? `${body.course_code} updated.`
        : `${body.course_code} added to the course register.`,
    );
    await fetchCourses();
  } catch (err) {
    addCourseError.textContent = "Network error — couldn't reach the server.";
    addCourseError.hidden = false;
  } finally {
    addCourseSubmitBtn.disabled = false;
    addCourseSubmitBtn.textContent = isEditing ? "Save changes" : "Add course";
  }
});

// ---------- toast ----------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- search wiring ----------

courseSearchEl.addEventListener("input", renderCourseList);
shortfallToggleEl.addEventListener("change", () => {
  shortfallOnly = shortfallToggleEl.checked;
  renderCourseList();
});

// ---------- misc ----------

// prevent accidental scroll-to-change on number fields (min mark / hours per week)
document.querySelectorAll('input[type="number"]').forEach((el) => {
  el.addEventListener("wheel", () => el.blur(), { passive: true });
});

// ---------- guided tour ----------

// board.js has no login/session guard of its own today, so this reads the
// same sessionStorage "user" key storage.js's getCurrentUser() uses,
// rather than assuming a currentUser variable exists here.
function getSessionUserId() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw).id : "anon";
  } catch {
    return "anon";
  }
}

const ORGANISER_TOUR_STEPS = [
  {
    selector: ".header-right",
    title: "Your snapshot",
    body: "At a glance: how many courses are fully staffed, how many tutors are on the roll, and how many applications or volunteers still need a decision.",
    placement: "bottom",
  },
  {
    selector: "#statPending",
    title: "Needs review",
    body: "This counts every pending tutor application and student volunteer across all courses. Courses with something waiting also get a \"to review\" badge in the list on the left.",
    placement: "bottom",
  },
  {
    selector: "#courseSearch",
    title: "Find a course",
    body: "Search by course code or name to jump straight to it.",
    placement: "bottom",
  },
  {
    selector: ".shortfall-toggle",
    title: "Spot the gaps",
    body: "Toggle this to show only short-staffed courses, worst shortfall first — handy when you're trying to close gaps quickly.",
    placement: "bottom",
  },
  {
    selector: "#addCourseBtn",
    title: "Add a course",
    body: "New course to staff? Add it here with its code, department, hours needed, and session time.",
    placement: "bottom",
  },
  {
    selector: "#courseList",
    title: "Pick a course",
    body: "Click any course to see who's assigned, who's applied, who's volunteered, and any session excusals — approve or reject right from there.",
    placement: "right",
  },
  {
    selector: "a[href='tutors.html']",
    title: "Manage tutors",
    body: "The full tutor roster lives here — add, edit, or remove tutors, and set hourly rates and weekly hour caps.",
    placement: "bottom",
  },
  {
    selector: "a[href='timesheet-review.html']",
    title: "Review timesheets",
    body: "Logged hours from tutors show up here for you to review.",
    placement: "bottom",
  },
  {
    selector: "a[href='hours-budget-report.html']",
    title: "Hours & budget report",
    body: "See logged tutoring hours broken down by tutor and course, with cost calculated against each course's budget.",
    placement: "bottom",
  },
];

const tourBtn = document.getElementById("tour-button");
if (tourBtn) {
  tourBtn.addEventListener("click", () => {
    window.Onboarding?.start(ORGANISER_TOUR_STEPS, {
      tourId: "organiser-board",
      userId: getSessionUserId(),
      force: true,
    });
  });
}

// ---------- init ----------

(async () => {
  await fetchCourses();
  fetchTutorCount();
  fetchVolunteerCounts();
  fetchPendingApplicationCounts();
  fetchPendingVolunteerCounts();

  window.Onboarding?.start(ORGANISER_TOUR_STEPS, {
    tourId: "organiser-board",
    userId: getSessionUserId(),
  });
})();