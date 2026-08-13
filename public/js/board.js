/* ============================================================
   Tutor Allocation Board — organiser view (Basic tier)
   Covers: hold courses/tutors data, single-board assignment
   with live checks on marks / timetable clash / hours remaining.
   ============================================================ */

// ---------- data (courses come from Supabase via /api/courses) ----------

const COURSES = [];

const TUTORS = [];

// ---------- state ----------

// assignments: courseId -> tutorId | null
const assignments = {};

let activeCourseId = null;
let pendingTutorId = null; // tutor picked but not yet confirmed

// ---------- data loading ----------

function mapCourseRow(row){
  return {
    id: row.id,
    code: row.course_code,
    name: row.course_name,
    minMark: row.min_mark,
    department: row.department,
    // not tracked in the courses table yet — assignment features stay dormant until they are
    hoursNeeded: null,
    session: null,
  };
}

async function fetchCourses(){
  try {
    const res = await fetch("/api/courses");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load courses");

    COURSES.length = 0;
    rows.forEach(row => {
      COURSES.push(mapCourseRow(row));
      if (!(row.id in assignments)) assignments[row.id] = null;
    });
  } catch (err) {
    showToast("Couldn't load courses from the database.");
  }
  renderCourseList();
  renderDetail();
}

// ---------- helpers ----------

function initials(name){
  return name.split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase();
}

function timeToMinutes(t){
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function overlaps(a, b){
  if (a.day !== b.day) return false;
  return timeToMinutes(a.start) < timeToMinutes(b.end) &&
         timeToMinutes(b.start) < timeToMinutes(a.end);
}

// hours a tutor already carries across CONFIRMED assignments, excluding one course
function hoursAssigned(tutorId, excludeCourseId = null){
  return COURSES.reduce((sum, course) => {
    if (course.id === excludeCourseId) return sum;
    return assignments[course.id] === tutorId ? sum + course.hoursNeeded : sum;
  }, 0);
}

// sessions a tutor is already committed to via confirmed assignments
function committedSessions(tutorId, excludeCourseId = null){
  return COURSES
    .filter(c => c.id !== excludeCourseId && assignments[c.id] === tutorId)
    .map(c => ({ ...c.session, sourceCourse: c }));
}

// core validation: given a tutor and the course being staffed, work out status
function evaluate(tutor, course){
  // 1. marks
  const mark = tutor.marks[course.id];
  const marksOk = typeof mark === "number" && mark >= course.minMark;

  // 2. timetable clash — personal busy times + other confirmed teaching sessions
  const allBusy = [...tutor.busy, ...committedSessions(tutor.id, course.id)];
  const clash = allBusy.find(b => overlaps(b, course.session));
  const clashOk = !clash;

  // 3. hours remaining this week
  const already = hoursAssigned(tutor.id, course.id);
  const remaining = tutor.weeklyHours - already;
  const hoursOk = remaining >= course.hoursNeeded;

  const eligible = marksOk && clashOk && hoursOk;

  return { mark, marksOk, clash, clashOk, remaining, hoursOk, eligible };
}

// ---------- rendering: course rail ----------

const courseListEl = document.getElementById("courseList");
const courseSearchEl = document.getElementById("courseSearch");
const statFilledEl = document.getElementById("statFilled");
const statTutorsEl = document.getElementById("statTutors");

function renderCourseList(){
  const query = courseSearchEl.value.trim().toLowerCase();
  const filled = COURSES.filter(c => assignments[c.id]).length;
  statFilledEl.textContent = `${filled} / ${COURSES.length}`;
  statTutorsEl.textContent = TUTORS.length;

  courseListEl.innerHTML = "";

  COURSES
    .filter(c => !query || c.code.toLowerCase().includes(query) || c.name.toLowerCase().includes(query))
    .forEach(course => {
      const li = document.createElement("li");
      const isFilled = !!assignments[course.id];
      const tutorName = isFilled ? TUTORS.find(t => t.id === assignments[course.id]).name : null;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "course-card" + (course.id === activeCourseId ? " active" : "");
      btn.setAttribute("aria-pressed", course.id === activeCourseId);
      btn.innerHTML = `
        <span class="course-code">${course.code}</span>
        <span class="course-name">${course.name}</span>
        <div class="card-foot">
          <span>${isFilled ? tutorName : "Unassigned"}</span>
          <span class="status-pill ${isFilled ? "filled" : "open"}">${isFilled ? "Staffed" : "Open"}</span>
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
const tutorSearchEl = document.getElementById("tutorSearch");
const tutorListEl = document.getElementById("tutorList");
const assignmentCardEl = document.getElementById("assignmentCard");
const confirmBarEl = document.getElementById("confirmBar");

function selectCourse(courseId){
  activeCourseId = courseId;
  pendingTutorId = null;
  renderCourseList();
  renderDetail();
}

function renderDetail(){
  if (!activeCourseId){
    emptyStateEl.hidden = false;
    courseDetailEl.hidden = true;
    return;
  }
  emptyStateEl.hidden = true;
  courseDetailEl.hidden = false;

  const course = COURSES.find(c => c.id === activeCourseId);

  document.getElementById("dCode").textContent = course.code;
  document.getElementById("dName").textContent = course.name;
  document.getElementById("dSession").textContent = course.session
    ? `${course.session.day} · ${course.session.start}–${course.session.end}  ·  requires a mark of ${course.minMark}+`
    : `${course.department}  ·  requires a mark of ${course.minMark}+  ·  not yet scheduled`;
  document.getElementById("dHours").textContent = course.hoursNeeded ?? "—";

  renderAssignmentCard(course);
  renderTutorList(course);
  renderConfirmBar(course);
}

function renderAssignmentCard(course){
  const tutorId = assignments[course.id];

  if (!tutorId){
    assignmentCardEl.className = "assignment-card empty";
    assignmentCardEl.innerHTML = `<p class="empty-copy">Nobody is assigned to this course yet. Pick a tutor below — you'll see why they do or don't qualify before anything is saved.</p>`;
    return;
  }

  const tutor = TUTORS.find(t => t.id === tutorId);
  assignmentCardEl.className = "assignment-card filled";
  assignmentCardEl.innerHTML = `
    <div class="assignment-row">
      <div class="assigned-tutor">
        <span class="avatar">${initials(tutor.name)}</span>
        <div>
          <div class="name">${tutor.name}</div>
          <div class="meta">${course.hoursNeeded} hrs/week on this course · ${tutor.weeklyHours - hoursAssigned(tutor.id)} hrs left overall</div>
        </div>
      </div>
      <button class="btn-small" id="unassignBtn" type="button">Remove</button>
    </div>
  `;
  document.getElementById("unassignBtn").addEventListener("click", () => {
    assignments[course.id] = null;
    pendingTutorId = null;
    showToast(`Removed ${tutor.name} from ${course.code}`);
    renderCourseList();
    renderDetail();
  });
}

function renderTutorList(course){
  const query = tutorSearchEl.value.trim().toLowerCase();
  const currentTutorId = assignments[course.id];

  const rows = TUTORS
    .filter(t => !query || t.name.toLowerCase().includes(query))
    .map(t => ({ tutor: t, status: evaluate(t, course) }))
    .sort((a, b) => {
      // eligible first, then by mark descending
      if (a.status.eligible !== b.status.eligible) return a.status.eligible ? -1 : 1;
      return (b.status.mark || 0) - (a.status.mark || 0);
    });

  tutorListEl.innerHTML = "";

  rows.forEach(({ tutor, status }) => {
    const li = document.createElement("li");
    const isSelected = tutor.id === pendingTutorId;
    const isCurrent = tutor.id === currentTutorId;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tutor-row" + (isSelected ? " selected" : "") + (!status.eligible ? " blocked" : "");
    btn.disabled = isCurrent;
    if (isCurrent) btn.title = "Already assigned to this course";

    const marksStamp = status.mark === undefined
      ? `<span class="stamp blocked">No mark on record</span>`
      : status.marksOk
        ? `<span class="stamp ok">Mark ${status.mark}</span>`
        : `<span class="stamp blocked">Mark ${status.mark} · below ${course.minMark}</span>`;

    const clashStamp = status.clashOk
      ? `<span class="stamp ok">Free at this time</span>`
      : `<span class="stamp blocked">Clashes ${status.clash.day} ${status.clash.start}–${status.clash.end}${status.clash.sourceCourse ? " · " + status.clash.sourceCourse.code : ""}</span>`;

    const hoursStamp = status.hoursOk
      ? `<span class="stamp ok">${status.remaining} hrs free</span>`
      : `<span class="stamp warn">Only ${Math.max(status.remaining,0)} hrs free · needs ${course.hoursNeeded}</span>`;

    btn.innerHTML = `
      <span class="avatar">${initials(tutor.name)}</span>
      <span class="name-block">
        <span class="name">${tutor.name}</span>
        <span class="role">${isCurrent ? "Currently assigned" : status.eligible ? "Qualifies" : "Doesn't qualify"}</span>
      </span>
      <span class="stamp-row">
        ${marksStamp}
        ${clashStamp}
        ${hoursStamp}
      </span>
    `;

    btn.addEventListener("click", () => {
      pendingTutorId = pendingTutorId === tutor.id ? null : tutor.id;
      renderTutorList(course);
      renderConfirmBar(course);
    });

    li.appendChild(btn);
    tutorListEl.appendChild(li);
  });

  if (rows.length === 0){
    tutorListEl.innerHTML = `<li class="empty-copy" style="padding:12px;">No tutors match "${tutorSearchEl.value}".</li>`;
  }
}

function renderConfirmBar(course){
  if (!pendingTutorId){
    confirmBarEl.hidden = true;
    return;
  }
  const tutor = TUTORS.find(t => t.id === pendingTutorId);
  const status = evaluate(tutor, course);

  confirmBarEl.hidden = false;
  document.getElementById("confirmName").textContent = tutor.name;
  document.getElementById("confirmCourse").textContent = course.code;

  const confirmBtn = document.getElementById("confirmBtn");
  confirmBtn.textContent = status.eligible ? "Confirm assignment" : "Assign anyway (override)";
  confirmBtn.onclick = () => {
    assignments[course.id] = tutor.id;
    pendingTutorId = null;
    showToast(`${tutor.name} assigned to ${course.code}${status.eligible ? "" : " — with an override"}`);
    renderCourseList();
    renderDetail();
  };
}

document.getElementById("cancelBtn").addEventListener("click", () => {
  pendingTutorId = null;
  renderDetail();
});

// ---------- add course modal ----------

const addCourseBtn = document.getElementById("addCourseBtn");
const addCourseModal = document.getElementById("addCourseModal");
const addCourseForm = document.getElementById("addCourseForm");
const addCourseError = document.getElementById("addCourseError");
const addCourseSubmitBtn = document.getElementById("addCourseSubmitBtn");

function openAddCourseModal(){
  addCourseForm.reset();
  addCourseError.hidden = true;
  addCourseModal.showModal();
  document.getElementById("courseCodeInput").focus();
}

function closeAddCourseModal(){
  addCourseModal.close();
}

addCourseBtn.addEventListener("click", openAddCourseModal);
document.getElementById("addCourseCloseBtn").addEventListener("click", closeAddCourseModal);
document.getElementById("addCourseCancelBtn").addEventListener("click", closeAddCourseModal);

addCourseModal.addEventListener("click", (e) => {
  if (e.target === addCourseModal) closeAddCourseModal();
});

addCourseForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  addCourseError.hidden = true;

  const payload = {
    course_code: document.getElementById("courseCodeInput").value.trim(),
    course_name: document.getElementById("courseNameInput").value.trim(),
    min_mark: Number(document.getElementById("minMarkInput").value),
    department: document.getElementById("departmentInput").value.trim(),
  };

  addCourseSubmitBtn.disabled = true;
  addCourseSubmitBtn.textContent = "Adding…";

  try {
    const res = await fetch("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    if (!res.ok) {
      addCourseError.textContent = body.error || "Couldn't add that course.";
      addCourseError.hidden = false;
      return;
    }

    closeAddCourseModal();
    showToast(`${body.course_code} added to the course register.`);
    await fetchCourses();
  } catch (err) {
    addCourseError.textContent = "Network error — couldn't reach the server.";
    addCourseError.hidden = false;
  } finally {
    addCourseSubmitBtn.disabled = false;
    addCourseSubmitBtn.textContent = "Add course";
  }
});

// ---------- toast ----------

let toastTimer = null;
function showToast(message){
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- search wiring ----------

courseSearchEl.addEventListener("input", renderCourseList);
tutorSearchEl.addEventListener("input", () => {
  const course = COURSES.find(c => c.id === activeCourseId);
  if (course) renderTutorList(course);
});

// ---------- init ----------

fetchCourses();