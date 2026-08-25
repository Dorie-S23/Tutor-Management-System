import { highlightActiveTab } from './nav.js';
import { getWeekStart, getWeekTotal, todayStr } from './storage.js';

const WEEKLY_HOUR_LIMIT = 6;

highlightActiveTab();

const hoursWorkedEl = document.getElementById('stat-hours-worked');
const hoursRemainingEl = document.getElementById('stat-hours-remaining');
const hoursSublabelEl = document.getElementById('stat-hours-sublabel');
const welcomeHeadingEl = document.getElementById('welcome-heading');

function getCurrentUser() {
  const raw = sessionStorage.getItem('user');
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
    hoursRemainingEl.classList.remove('danger');
    hoursSublabelEl.textContent = `of ${WEEKLY_HOUR_LIMIT} hrs/week limit`;
  } else {
    hoursRemainingEl.textContent = 0;
    hoursRemainingEl.classList.add('danger');
    hoursSublabelEl.textContent = `over the ${WEEKLY_HOUR_LIMIT} hrs/week limit by ${-remaining}`;
  }
}

renderHoursStats().catch((err) => {
  console.error('Failed to load hours stats:', err);
});
renderWelcome();

// ---------- apply to tutor a subject ----------

const applyBtn = document.getElementById('apply-to-tutor-btn');
const applyModal = document.getElementById('apply-modal');
const applyForm = document.getElementById('apply-form');
const applyError = document.getElementById('apply-form-error');
const applySubmitBtn = document.getElementById('apply-submit-btn');
const courseSelect = document.getElementById('apply-course-select');
const courseMeta = document.getElementById('apply-course-meta');
const yearSelect = document.getElementById('apply-year-select');
const markInput = document.getElementById('apply-mark-input');
const availabilitySelect = document.getElementById('apply-availability-select');
const availabilityLabel = document.getElementById('apply-availability-label');
const applicationsListEl = document.getElementById('applications-list');
const applicationsItemsEl = document.getElementById('applications-items');
const toastEl = document.getElementById('toast');

let COURSES = [];
let myApplications = [];
let myAcademicLevel = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function formatSession(course) {
  if (!course.Day_of_tut || !course.tutor_start_time || !course.tutor_end_time) return null;
  return `${course.Day_of_tut} · ${course.tutor_start_time.slice(0, 5)}–${course.tutor_end_time.slice(0, 5)}`;
}

async function fetchCourses() {
  try {
    const res = await fetch('/api/courses');
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load courses');
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
    if (!res.ok) throw new Error(row.error || 'Failed to load tutor record');
    myAcademicLevel = row.academic_level || null;
  } catch {
    myAcademicLevel = null;
  }
}

async function fetchMyApplications(tutorId) {
  try {
    const res = await fetch(`/api/tutor-applications?tutorId=${encodeURIComponent(tutorId)}`);
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || 'Failed to load applications');
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
  applicationsItemsEl.innerHTML = '';

  myApplications.forEach((app) => {
    const li = document.createElement('li');
    li.className = 'application-row';
    const course = app.courses;
    const status = (app.status || 'pending').toLowerCase();
    li.innerHTML = `
      <span>${course ? `${course.course_code} — ${course.course_name}` : 'Course'}</span>
      <span class="status-pill ${status}">${status}</span>
    `;
    applicationsItemsEl.appendChild(li);
  });
}

function populateCourseSelect() {
  const appliedCourseIds = new Set(myApplications.map((a) => a.course_id));

  courseSelect.innerHTML = '<option value="" disabled selected>Choose a course&hellip;</option>';
  COURSES.forEach((course) => {
    const option = document.createElement('option');
    option.value = course.id;
    option.textContent = `${course.course_code} — ${course.course_name}`;
    if (appliedCourseIds.has(course.id)) {
      option.textContent += ' (already applied)';
      option.disabled = true;
    }
    courseSelect.appendChild(option);
  });
}

function updateCourseMeta() {
  const course = COURSES.find((c) => String(c.id) === courseSelect.value);
  if (!course) {
    courseMeta.hidden = true;
    availabilityLabel.textContent = 'Are you free at the tutorial time?';
    return;
  }

  const session = formatSession(course);
  courseMeta.hidden = false;
  courseMeta.textContent = session
    ? `Requires a mark of ${course.min_mark}+ · tutorial is ${session}`
    : `Requires a mark of ${course.min_mark}+ · tutorial day/time not yet set`;

  availabilityLabel.textContent = session
    ? `Are you free on ${session}?`
    : 'Are you free at the tutorial time?';
}

function openApplyModal() {
  const user = getCurrentUser();
  if (!user) {
    showToast('Please log in as a tutor to apply.');
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

applyBtn?.addEventListener('click', openApplyModal);
document.getElementById('apply-modal-close-btn')?.addEventListener('click', closeApplyModal);
document.getElementById('apply-cancel-btn')?.addEventListener('click', closeApplyModal);
applyModal?.addEventListener('click', (e) => {
  if (e.target === applyModal) closeApplyModal();
});
courseSelect?.addEventListener('change', updateCourseMeta);

applyForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  applyError.hidden = true;

  const user = getCurrentUser();
  if (!user) {
    showToast('Please log in as a tutor to apply.');
    return;
  }

  const payload = {
    tutorId: user.id,
    courseId: Number(courseSelect.value),
    academicLevel: yearSelect.value,
    mark: Number(markInput.value),
    availability: availabilitySelect.value === 'true',
  };

  applySubmitBtn.disabled = true;
  applySubmitBtn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/tutor-applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    if (!res.ok) {
      applyError.textContent = body.error || "Couldn't submit that application.";
      applyError.hidden = false;
      return;
    }

    closeApplyModal();
    showToast('Application submitted!');
    myAcademicLevel = payload.academicLevel;
    await fetchMyApplications(user.id);
  } catch {
    applyError.textContent = "Network error — couldn't reach the server.";
    applyError.hidden = false;
  } finally {
    applySubmitBtn.disabled = false;
    applySubmitBtn.textContent = 'Submit application';
  }
});

(async function initApply() {
  await fetchCourses();
  const user = getCurrentUser();
  if (user) {
    await fetchMyAcademicLevel(user.id);
    await fetchMyApplications(user.id);
  }
})();
