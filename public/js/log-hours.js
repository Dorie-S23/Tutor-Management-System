import { highlightActiveTab } from "./nav.js";
import {
  getCurrentUser,
  addEntry,
  updateEntry,
  deleteEntry,
  findDuplicateEntry,
  getWeekStart,
  addDays,
  getEntriesForWeek,
  todayStr,
} from "./storage.js";

const currentUser = getCurrentUser();
if (!currentUser) {
  window.location.href = "login.html";
  throw new Error("Not logged in");
}

highlightActiveTab();

// This page is shared between the tutor and student volunteer flows, so the
// "Dashboard" link has to point at whichever dashboard actually matches the
// signed-in user's role.
const dashboardNavLink = document.getElementById("dashboard-nav-link");
const mySessionsNavLink = document.getElementById("my-sessions-nav-link");
const timesheetsNavLink = document.getElementById("timesheets-nav-link");
if (currentUser.role !== "tutor") {
  if (dashboardNavLink) dashboardNavLink.href = "StudentView.html";
  // Timesheets is a tutor-only payroll claim — no use to a student volunteer.
  if (timesheetsNavLink) timesheetsNavLink.hidden = true;
} else {
  // "My Sessions" is a student-volunteer concept (sessions they've
  // volunteered for) — hide it for tutors so they can't wander onto a
  // student-only page and get stuck (its Dashboard link only knows how
  // to get back to StudentView.html).
  if (mySessionsNavLink) mySessionsNavLink.hidden = true;
}

const form = document.getElementById("entry-form");
const entryIdField = document.getElementById("entry-id");
const dateField = document.getElementById("date");
const hoursField = document.getElementById("hours");
const startTimeField = document.getElementById("startTime");
const endTimeField = document.getElementById("endTime");
const taskTypeField = document.getElementById("taskType");
const courseSelectField = document.getElementById("courseSelect");
const notesField = document.getElementById("notes");
const formTitle = document.getElementById("form-title");
const submitBtn = document.getElementById("submit-btn");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const prevWeekBtn = document.getElementById("prev-week-btn");
const nextWeekBtn = document.getElementById("next-week-btn");
const weekLabel = document.getElementById("week-label");
const weekTotalEl = document.getElementById("week-total");
const entriesBody = document.getElementById("entries-body");
const emptyState = document.getElementById("empty-state");
const formError = document.getElementById("form-error");

let currentWeekStart = getWeekStart(todayStr());

dateField.value = todayStr();

let COURSES = [];

async function loadCourseOptions() {
  try {
    const res = await fetch("/api/courses");
    if (!res.ok) throw new Error("Failed to load courses");
    COURSES = await res.json();
  } catch {
    COURSES = [];
  }

  courseSelectField.innerHTML = '<option value="">No specific course</option>';
  COURSES.forEach((course) => {
    const option = document.createElement("option");
    option.value = course.id;
    option.textContent = `${course.course_code} — ${course.course_name}`;
    courseSelectField.appendChild(option);
  });
}

function formatWeekLabel(weekStart) {
  const start = new Date(weekStart);
  const end = new Date(addDays(weekStart, 6));
  const opts = { month: "short", day: "numeric" };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, {
    ...opts,
    year: "numeric",
  });
  return `${startStr} - ${endStr}`;
}

function exitEditMode() {
  entryIdField.value = "";
  form.reset();
  dateField.value = todayStr();
  courseSelectField.value = "";
  formTitle.textContent = "Log hours";
  submitBtn.textContent = "Add entry";
  cancelEditBtn.hidden = true;
  formError.hidden = true;
}

function enterEditMode(entry) {
  entryIdField.value = entry.id;
  dateField.value = entry.date;
  hoursField.value = entry.hours;
  startTimeField.value = entry.startTime || "";
  endTimeField.value = entry.endTime || "";
  taskTypeField.value = entry.taskType || "Tutoring";

  if (entry.courseId != null) {
    courseSelectField.value = String(entry.courseId);
  } else {
    // Older entries logged before courses were linked properly only have
    // a free-text subject — best-effort match it to a course code so
    // editing one doesn't silently lose that context.
    const matched = COURSES.find(
      (c) => c.course_code.toLowerCase() === (entry.subject || "").toLowerCase(),
    );
    courseSelectField.value = matched ? String(matched.id) : "";
  }

  notesField.value = entry.notes;
  formTitle.textContent = "Edit entry";
  submitBtn.textContent = "Save changes";
  cancelEditBtn.hidden = false;
  formError.hidden = true;
}

async function render() {
  weekLabel.textContent = formatWeekLabel(currentWeekStart);

  const entries = await getEntriesForWeek(currentWeekStart);
  weekTotalEl.textContent = entries.reduce(
    (sum, e) => sum + Number(e.hours),
    0,
  );
  entriesBody.innerHTML = "";
  emptyState.hidden = entries.length > 0;

  for (const entry of entries) {
    const row = document.createElement("tr");

    const cells = [
      entry.date,
      entry.hours,
      entry.taskType,
      entry.subject,
      entry.notes,
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value || "";
      row.appendChild(td);
    }

    const actionsTd = document.createElement("td");
    actionsTd.className = "actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn-link";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => enterEditMode(entry));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Delete this entry?")) return;
      await deleteEntry(entry.id);
      if (entryIdField.value === entry.id) exitEditMode();
      await render();
    });

    actionsTd.append(editBtn, deleteBtn);
    row.appendChild(actionsTd);
    entriesBody.appendChild(row);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const courseId = courseSelectField.value ? Number(courseSelectField.value) : null;
  const selectedCourse = COURSES.find((c) => c.id === courseId);

  const payload = {
    date: dateField.value,
    hours: Number(hoursField.value),
    startTime: startTimeField.value,
    endTime: endTimeField.value,
    taskType: taskTypeField.value,
    courseId,
    // Kept in sync with the selected course so other pages that still read
    // the free-text subject (e.g. the calendar's session pills) keep working.
    subject: selectedCourse ? selectedCourse.course_code : "",
    notes: notesField.value.trim(),
  };

  const duplicate = await findDuplicateEntry(
    payload,
    entryIdField.value || null,
  );
  if (duplicate) {
    formError.textContent =
      "An identical entry (same date, hours, task type and course) is already logged.";
    formError.hidden = false;
    return;
  }
  formError.hidden = true;

  if (entryIdField.value) {
    await updateEntry(entryIdField.value, payload);
  } else {
    await addEntry(payload);
  }

  currentWeekStart = getWeekStart(payload.date);
  exitEditMode();
  await render();
});

cancelEditBtn.addEventListener("click", exitEditMode);

prevWeekBtn.addEventListener("click", async () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  await render();
});

nextWeekBtn.addEventListener("click", async () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  await render();
});

await loadCourseOptions();
await render();