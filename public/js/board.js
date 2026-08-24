const COURSES = [];

// ---------- state ----------

let activeCourseId = null;
let tutorCount = 0; // total tutors in the system, for the header stat

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
const statFilledEl = document.getElementById("statFilled");
const statTutorsEl = document.getElementById("statTutors");

function renderCourseList() {
  const query = courseSearchEl.value.trim().toLowerCase();
  const filled = COURSES.filter(
    (c) => c.tutorsNeeded && c.tutorsAssigned >= c.tutorsNeeded,
  ).length;
  statFilledEl.textContent = `${filled} / ${COURSES.length}`;

  courseListEl.innerHTML = "";

  COURSES.filter(
    (c) =>
      !query ||
      c.code.toLowerCase().includes(query) ||
      c.name.toLowerCase().includes(query),
  ).forEach((course) => {
    const li = document.createElement("li");
    const isFull =
      !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "course-card" + (course.id === activeCourseId ? " active" : "");
    btn.setAttribute("aria-pressed", course.id === activeCourseId);
    btn.innerHTML = `
        <span class="course-code">${course.code}</span>
        <span class="course-name">${course.name}</span>
        <div class="card-foot">
          <span>${course.tutorsAssigned} / ${course.tutorsNeeded ?? "—"} assigned</span>
          <span class="status-pill ${isFull ? "filled" : "open"}">${isFull ? "Staffed" : "Open"}</span>
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

  renderAssignmentCard(course);
  renderApplicants(course);
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

  rows.forEach((app) => {
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
      </span>
      <span class="status-pill ${status}">${status}</span>
      <span class="applicant-actions"></span>
    `;

    const actionsEl = row.querySelector(".applicant-actions");
    const isFull =
      !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;

    if (status === "pending") {
      actionsEl.appendChild(
        makeApplicantActionBtn(
          "Approve",
          "approve",
          () => setApplicationStatus(course, app, "approved", name),
          isFull && "This course already has all the tutors it needs",
        ),
      );
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
    await fetchCourses();
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

// ---------- misc ----------

// prevent accidental scroll-to-change on number fields (min mark / hours per week)
document.querySelectorAll('input[type="number"]').forEach((el) => {
  el.addEventListener("wheel", () => el.blur(), { passive: true });
});

// ---------- init ----------

fetchCourses();
fetchTutorCount();
