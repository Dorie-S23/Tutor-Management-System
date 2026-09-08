const COURSES = [];

// ---------- state ----------

let activeCourseId = null;
let tutorCount = 0; // total tutors in the system, for the header stat
let volunteerCounts = {}; // course_id -> number of approved volunteers

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
    tutorialVenue: row.tutorial_venue,
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

// Returns every scheduled tutorial session across all courses, tagged with
// its course — the flat list the timetable grid and the venue-clash check
// both work from.
function getAllSessions() {
  const sessions = [];
  COURSES.forEach((course) => {
    if (course.session) {
      sessions.push({
        courseId: course.id,
        courseCode: course.code,
        type: "Tutorial",
        day: course.session.day,
        start: course.session.start,
        end: course.session.end,
        venue: course.tutorialVenue || "",
      });
    }
  });
  return sessions;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function timesOverlap(startA, endA, startB, endB) {
  return timeToMinutes(startA) < timeToMinutes(endB) &&
    timeToMinutes(startB) < timeToMinutes(endA);
}

// A venue field can list several rooms for one session (e.g. multiple
// tutorial groups) as "MSL004,005,006" — a shorthand where bare numbers
// inherit the last letter prefix (so "005" means "MSL005"). Split that into
// individual, fully-qualified room names rather than comparing the whole
// field as one string.
function parseVenues(venueStr) {
  const tokens = (venueStr || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  let prefix = "";
  return tokens.map((token) => {
    const match = token.match(/^([A-Za-z]+)(\d.*)$/);
    if (match) {
      prefix = match[1];
      return token;
    }
    return prefix && /^\d/.test(token) ? prefix + token : token;
  });
}

// Rooms shared between two venue fields, preserving venueA's original casing.
function sharedVenues(venueA, venueB) {
  const setB = new Set(parseVenues(venueB).map((v) => v.toLowerCase()));
  return parseVenues(venueA).filter((v) => setB.has(v.toLowerCase()));
}

// Venue double-bookings: same day, at least one room in common, overlapping
// time. excludeCourseId lets the edit modal check a course's own
// in-progress edits against everyone else without flagging itself.
function findVenueClashes(session, excludeCourseId = null) {
  if (!session.day || !session.start || !session.end || !session.venue) {
    return [];
  }
  return getAllSessions().filter(
    (other) =>
      other.courseId !== excludeCourseId &&
      other.day === session.day &&
      sharedVenues(session.venue, other.venue).length > 0 &&
      timesOverlap(session.start, session.end, other.start, other.end),
  );
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
          <span>${course.tutorsAssigned} / ${course.tutorsNeeded ?? "—"} assigned, ${volunteerCounts[course.id] ?? 0} volunteered</span>
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
  document.getElementById("dSession").textContent = course.session
    ? `Tutorial ${course.session.day} ${course.session.start}–${course.session.end}${course.tutorialVenue ? ` (${course.tutorialVenue})` : ""}  ·  requires a mark of ${course.minMark}+`
    : `${course.department}  ·  requires a mark of ${course.minMark}+  ·  not yet scheduled`;
  document.getElementById("dHours").textContent = course.hoursNeeded ?? "—";
  document.getElementById("dTutorsAssigned").textContent =
    `${course.tutorsAssigned} / ${course.tutorsNeeded ?? "—"}`;
  document.getElementById("dVolunteered").textContent =
    volunteerCounts[course.id] ?? 0;

  renderAssignmentCard(course);
  renderApplicants(course);
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
    renderVolunteers(course);
    fetchVolunteerCounts();
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
const courseClashWarningEl = document.getElementById("courseClashWarning");

const tutorialVenueInput = document.getElementById("tutorialVenueInput");

let editingCourseId = null; // null = adding a new course, otherwise id of course being edited

function openCourseModal(course = null) {
  editingCourseId = course ? course.id : null;
  addCourseForm.reset();
  addCourseError.hidden = true;
  courseClashWarningEl.hidden = true;

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
    tutorialVenueInput.value = course.tutorialVenue ?? "";
  }

  addCourseModal.showModal();
  document.getElementById("courseCodeInput").focus();
  checkModalClashes();
}

// Live venue-clash preview while editing a course's tutorial time — purely
// client-side against the already-loaded COURSES list, so it updates instantly
// as the organiser types. Never blocks saving, just warns.
function checkModalClashes() {
  const tutorialSession = {
    day: document.getElementById("dayOfTutInput").value.trim(),
    start: document.getElementById("tutorStartTimeInput").value,
    end: document.getElementById("tutorEndTimeInput").value,
    venue: tutorialVenueInput.value.trim(),
  };

  const clashes = findVenueClashes(tutorialSession, editingCourseId);

  if (clashes.length === 0) {
    courseClashWarningEl.hidden = true;
    return;
  }

  const c = clashes[0];
  const shared = sharedVenues(tutorialSession.venue, c.venue).join(", ");
  courseClashWarningEl.textContent = `⚠ Venue clash: ${shared} is already booked for ${c.courseCode} ${c.type} (${c.day} ${c.start}–${c.end})${clashes.length > 1 ? ` and ${clashes.length - 1} more` : ""}.`;
  courseClashWarningEl.hidden = false;
}

[
  "dayOfTutInput",
  "tutorStartTimeInput",
  "tutorEndTimeInput",
  "tutorialVenueInput",
].forEach((id) => {
  document.getElementById(id).addEventListener("input", checkModalClashes);
});

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
    tutorial_venue: tutorialVenueInput.value.trim() || null,
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

async function init() {
  await fetchCourses();
  fetchTutorCount();
  fetchVolunteerCounts();

  // Arriving from the timetable grid with ?edit=<courseId> jumps straight to
  // that course's edit modal, so a session block there is a one-click edit.
  const editId = Number(new URLSearchParams(location.search).get("edit"));
  if (Number.isInteger(editId) && editId > 0) {
    const course = COURSES.find((c) => c.id === editId);
    if (course) {
      selectCourse(course.id);
      openCourseModal(course);
    }
  }
}

init();
