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

async function fetchTutorCount() {
  try {
    const res = await fetch("/api/tutors");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load tutors");
    tutorCount = rows.length;
  } catch (err) {
    tutorCount = 0;
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
        if (!res.ok)
          throw new Error(rows.error || "Failed to load applications");
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
    // Roving tabindex: only the active card (or the first, if none is active
    // yet) sits in the page's Tab order — Up/Down/Home/End move between the
    // rest, so an organiser paging through many courses isn't tabbing past
    // every single one to get anywhere else on the page.
    btn.tabIndex = course.id === activeCourseId ? 0 : -1;
    btn.dataset.courseId = String(course.id);
    btn.innerHTML = `
        <span class="course-code">${course.code}</span>
        <span class="course-name">${course.name}</span>
        <div class="card-foot">
          <span>${course.tutorsAssigned} / ${course.tutorsNeeded ?? "—"} assigned, ${volunteerCounts[course.id] ?? 0} volunteered</span>
          <span class="status-pill ${isFull ? "filled" : "open"}">${isFull ? "Staffed" : shortfall(course) > 0 ? `Short ${shortfall(course)}` : "Open"}</span>
          ${pending > 0 ? `<span class="status-pill pending">${pending} to review</span>` : ""}
        </div>
      `;
    btn.addEventListener("click", () => {
      selectCourse(course.id);
      // selectCourse() rebuilds this whole list, destroying the button that
      // was just clicked — without this, focus silently falls back to
      // <body> and the next arrow-key press just scrolls the page instead
      // of reaching the keydown handler below.
      focusCourseCard(course.id);
    });
    li.appendChild(btn);
    courseListEl.appendChild(li);
  });

  const cards = Array.from(courseListEl.querySelectorAll(".course-card"));
  if (cards.length && !cards.some((c) => c.tabIndex === 0)) {
    cards[0].tabIndex = 0;
  }
}

function focusCourseCard(courseId) {
  const card = courseListEl.querySelector(
    `.course-card[data-course-id="${CSS.escape(String(courseId))}"]`,
  );
  if (card) card.focus();
}

function isTypingInField() {
  const active = document.activeElement;
  return !!(
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  );
}

// Listens on the whole page, not just the course list, so Up/Down/Home/End
// navigate courses no matter where focus currently is (including nowhere,
// e.g. right after a mouse click elsewhere) — the only thing that opts out
// is actually typing into a text field, where arrow keys should do their
// normal job of moving the cursor.
document.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (isTypingInField()) return;

  const cards = Array.from(courseListEl.querySelectorAll(".course-card"));
  if (cards.length === 0) return;

  const currentIndex = cards.findIndex(
    (c) => c.dataset.courseId === String(activeCourseId),
  );

  let targetIndex;
  switch (event.key) {
    case "ArrowDown":
      targetIndex =
        currentIndex < 0 ? 0 : Math.min(currentIndex + 1, cards.length - 1);
      break;
    case "ArrowUp":
      targetIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
      break;
    case "Home":
      targetIndex = 0;
      break;
    case "End":
      targetIndex = cards.length - 1;
      break;
  }

  event.preventDefault();
  const targetCourseId = cards[targetIndex].dataset.courseId;
  const targetCourse = COURSES.find((c) => String(c.id) === targetCourseId);
  if (!targetCourse) return;

  selectCourse(targetCourse.id);
  focusCourseCard(targetCourse.id);
});

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

  renderAssignmentCard(course);
  renderApplicants(course);
  renderExcusals(course);
  renderVolunteers(course);
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
    const overrideStamp = app.overrideInfo
      ? `<span class="stamp warn">Overridden: ${app.overrideInfo.reason}</span>`
      : "";

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
        ${overrideStamp}
      </span>
      <span class="status-pill ${status}">${status}</span>
      <span class="applicant-actions"></span>
    `;

    const actionsEl = row.querySelector(".applicant-actions");
    const isFull =
      !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;
    const overCap = check?.workload?.overCap;
    const blockReason =
      (isFull && "This course already has all the tutors it needs") ||
      (overCap &&
        `This would put ${name} at ${check.workload.projectedHours} hrs/week, over their ${check.workload.weeklyHourCap} hr cap`);

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
          blockReason,
        ),
      );
      if (blockReason) {
        actionsEl.appendChild(
          makeApplicantActionBtn("Override", "override", () =>
            openOverrideModal(course, app, name, blockReason),
          ),
        );
      }
      actionsEl.appendChild(
        makeApplicantActionBtn("Reject", "", () =>
          setApplicationStatus(course, app, "rejected", name),
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

async function setApplicationStatus(course, app, status, name) {
  const previousStatus = (app.status || "pending").toLowerCase();
  try {
    const res = await fetch(`/api/tutor-applications/${app.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
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

// ---------- override modal ----------

let pendingOverride = null; // { course, app, name } for whichever row opened the modal

const overrideModal = document.getElementById("overrideModal");
const overrideForm = document.getElementById("overrideForm");
const overrideFormError = document.getElementById("overrideFormError");
const overrideModalContext = document.getElementById("overrideModalContext");
const overrideReasonInput = document.getElementById("overrideReasonInput");
const overrideSubmitBtn = document.getElementById("overrideSubmitBtn");

function openOverrideModal(course, app, name, blockReason) {
  pendingOverride = { course, app, name };
  overrideForm.reset();
  overrideFormError.hidden = true;
  overrideModalContext.textContent = `${blockReason}. Approving ${name} for ${course.code} anyway will be recorded against your account with the reason below.`;
  overrideModal.showModal();
  overrideReasonInput.focus();
}

function closeOverrideModal() {
  overrideModal.close();
  pendingOverride = null;
}

document
  .getElementById("overrideModalCloseBtn")
  .addEventListener("click", closeOverrideModal);
document
  .getElementById("overrideCancelBtn")
  .addEventListener("click", closeOverrideModal);
overrideModal.addEventListener("click", (e) => {
  if (e.target === overrideModal) closeOverrideModal();
});

overrideForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  overrideFormError.hidden = true;
  if (!pendingOverride) return;

  const { course, app, name } = pendingOverride;
  const reason = overrideReasonInput.value.trim();

  overrideSubmitBtn.disabled = true;
  overrideSubmitBtn.textContent = "Approving…";

  try {
    const res = await fetch(`/api/tutor-applications/${app.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "approved",
        override: true,
        organiserId: getSessionUserId(),
        reason,
      }),
    });
    const body = await res.json();

    if (!res.ok) {
      overrideFormError.textContent =
        body.error || "Couldn't override that rule.";
      overrideFormError.hidden = false;
      return;
    }

    closeOverrideModal();
    showToast(`${name} approved for ${course.code} (override recorded)`);
    await fetchCourses();
  } catch (err) {
    overrideFormError.textContent =
      "Network error — couldn't reach the server.";
    overrideFormError.hidden = false;
  } finally {
    overrideSubmitBtn.disabled = false;
    overrideSubmitBtn.textContent = "Approve with override";
  }
});

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
          setVolunteerStatus(course, vol, "rejected", name),
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

async function setVolunteerStatus(course, vol, status, name) {
  const previousStatus = (vol.status || "pending").toLowerCase();
  try {
    const res = await fetch(`/api/course-volunteers/${vol.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
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

// ---------- bulk-fill obvious assignments ----------

const obviousFillBtn = document.getElementById("obviousFillBtn");
const obviousFillModal = document.getElementById("obviousFillModal");
const obviousFillList = document.getElementById("obviousFillList");
const obviousFillEmpty = document.getElementById("obviousFillEmpty");
const obviousFillHint = document.getElementById("obviousFillHint");
const obviousFillConfirmBtn = document.getElementById("obviousFillConfirmBtn");

function closeObviousFillModal() {
  obviousFillModal.close();
}

async function openObviousFillModal() {
  obviousFillList.innerHTML = "";
  obviousFillEmpty.hidden = true;
  obviousFillHint.textContent = "Loading…";
  obviousFillConfirmBtn.hidden = false;
  obviousFillConfirmBtn.disabled = true;
  obviousFillModal.showModal();

  let groups = [];
  try {
    const res = await fetch("/api/tutor-applications/obvious-fill");
    groups = await res.json();
    if (!res.ok)
      throw new Error(groups.error || "Failed to load obvious fills");
  } catch (err) {
    obviousFillHint.textContent = "Couldn't load obvious fills — try again.";
    return;
  }

  const totalApplications = groups.reduce(
    (sum, g) => sum + g.applications.length,
    0,
  );

  if (totalApplications === 0) {
    obviousFillHint.textContent = "";
    obviousFillEmpty.hidden = false;
    obviousFillConfirmBtn.hidden = true;
    return;
  }

  obviousFillHint.textContent = `${totalApplications} application${totalApplications === 1 ? "" : "s"} across ${groups.length} course${groups.length === 1 ? "" : "s"} can be filled without any judgment call — uncheck anything you'd rather decide yourself.`;

  groups.forEach((group) => {
    const heading = document.createElement("li");
    heading.className = "obvious-fill-course-head";
    heading.textContent = `${group.course.code} — ${group.course.name}`;
    obviousFillList.appendChild(heading);

    group.applications.forEach((app) => {
      const li = document.createElement("li");
      const row = document.createElement("label");
      row.className = "tutor-row";
      row.style.cursor = "pointer";
      row.innerHTML = `
        <input type="checkbox" class="obvious-fill-check" data-id="${app.id}" checked>
        <span class="name-block">
          <span class="name">${app.tutorName || "Unknown"}</span>
        </span>
        <span class="stamp-row">
          <span class="stamp ok">Mark ${app.mark}</span>
        </span>
      `;
      li.appendChild(row);
      obviousFillList.appendChild(li);
    });
  });

  obviousFillConfirmBtn.disabled = false;
}

obviousFillBtn.addEventListener("click", openObviousFillModal);
document
  .getElementById("obviousFillCloseBtn")
  .addEventListener("click", closeObviousFillModal);
document
  .getElementById("obviousFillCancelBtn")
  .addEventListener("click", closeObviousFillModal);
obviousFillModal.addEventListener("click", (e) => {
  if (e.target === obviousFillModal) closeObviousFillModal();
});

obviousFillConfirmBtn.addEventListener("click", async () => {
  const ids = Array.from(
    obviousFillList.querySelectorAll(".obvious-fill-check:checked"),
  ).map((cb) => cb.dataset.id);

  if (ids.length === 0) {
    closeObviousFillModal();
    return;
  }

  obviousFillConfirmBtn.disabled = true;
  obviousFillConfirmBtn.textContent = "Approving…";

  try {
    const res = await fetch("/api/tutor-applications/bulk-approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationIds: ids }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't fill those assignments.");
      return;
    }
    const failed = body.results.filter((r) => !r.success);
    const succeeded = body.results.length - failed.length;
    showToast(
      failed.length === 0
        ? `${succeeded} assignment${succeeded === 1 ? "" : "s"} filled.`
        : `${succeeded} filled, ${failed.length} couldn't be — something changed since you opened this.`,
    );
    closeObviousFillModal();
    await fetchCourses();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  } finally {
    obviousFillConfirmBtn.disabled = false;
    obviousFillConfirmBtn.textContent = "Approve selected";
  }
});

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

// "/" jumps to the course search from anywhere on the page, unless the
// organiser is already typing into a field (so it doesn't hijack real input).
document.addEventListener("keydown", (event) => {
  if (event.key !== "/") return;
  if (isTypingInField()) return;
  event.preventDefault();
  courseSearchEl.focus();
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
    body: 'This counts every pending tutor application and student volunteer across all courses. Courses with something waiting also get a "to review" badge in the list on the left.',
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
