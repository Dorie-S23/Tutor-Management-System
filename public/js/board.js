/* ============================================================
   Tutor Allocation Board — organiser view (Basic tier)
   Covers: hold courses/tutors data, single-board assignment
   with live checks on marks / timetable clash / hours remaining.
   ============================================================ */

// ---------- sample data (stand-in for a real API / database) ----------

const COURSES = [
  {
    id: "c1", code: "COMS1000", name: "Introduction to Computer Science",
    hoursNeeded: 10, minMark: 65,
    session: { day: "Mon", start: "09:00", end: "11:00" },
  },
  {
    id: "c2", code: "COMS2011", name: "Data Structures & Algorithms",
    hoursNeeded: 8, minMark: 70,
    session: { day: "Tue", start: "13:00", end: "15:00" },
  },
  {
    id: "c3", code: "COMS3011", name: "Advanced Algorithms",
    hoursNeeded: 6, minMark: 75,
    session: { day: "Wed", start: "10:00", end: "12:00" },
  },
  {
    id: "c4", code: "MATH1014", name: "Calculus for Computer Science",
    hoursNeeded: 12, minMark: 60,
    session: { day: "Mon", start: "14:00", end: "16:00" },
  },
  {
    id: "c5", code: "COMS2012", name: "Software Design",
    hoursNeeded: 8, minMark: 65,
    session: { day: "Thu", start: "11:00", end: "13:00" },
  },
];

const TUTORS = [
  {
    id: "t1", name: "Naledi Mokoena", weeklyHours: 15,
    marks: { c1: 78, c2: 82, c5: 71 },
    busy: [{ day: "Tue", start: "12:00", end: "14:00" }],
  },
  {
    id: "t2", name: "Sipho Dlamini", weeklyHours: 10,
    marks: { c1: 68, c3: 80, c4: 74 },
    busy: [{ day: "Mon", start: "09:00", end: "10:00" }],
  },
  {
    id: "t3", name: "Amy van der Merwe", weeklyHours: 12,
    marks: { c2: 91, c3: 88, c5: 85 },
    busy: [{ day: "Wed", start: "09:00", end: "13:00" }],
  },
  {
    id: "t4", name: "Thabo Nkosi", weeklyHours: 8,
    marks: { c1: 59, c4: 66 },
    busy: [],
  },
  {
    id: "t5", name: "Priya Naidoo", weeklyHours: 14,
    marks: { c2: 73, c4: 91, c5: 69 },
    busy: [{ day: "Thu", start: "10:00", end: "12:00" }],
  },
  {
    id: "t6", name: "Kagiso Motaung", weeklyHours: 6,
    marks: { c1: 84, c3: 77 },
    busy: [],
  },
  {
    id: "t7", name: "Lerato Sithole", weeklyHours: 10,
    marks: { c1: 72, c2: 64, c5: 90 },
    busy: [{ day: "Mon", start: "13:00", end: "15:00" }],
  },
];

// ---------- state ----------

// assignments: courseId -> tutorId | null
const assignments = {};
COURSES.forEach(c => assignments[c.id] = null);

let activeCourseId = null;
let pendingTutorId = null; // tutor picked but not yet confirmed

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
  document.getElementById("dSession").textContent =
    `${course.session.day} · ${course.session.start}–${course.session.end}  ·  requires a mark of ${course.minMark}+`;
  document.getElementById("dHours").textContent = course.hoursNeeded;

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

renderCourseList();
renderDetail();