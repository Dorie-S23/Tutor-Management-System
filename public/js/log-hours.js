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

// This page is shared across roles (tutor, student volunteer, organiser),
// so the "Dashboard" and "Calendar" links have to point at
// whichever version actually matches the signed-in user's role.
const dashboardNavLink = document.getElementById("dashboard-nav-link");
const calendarNavLink = document.getElementById("calendar-nav-link");
const mySessionsNavLink = document.getElementById("my-sessions-nav-link");
const timesheetsNavLink = document.getElementById("timesheets-nav-link");
const modulesNavLink = document.getElementById("modules-nav-link");
if (currentUser.role === "student") {
  if (dashboardNavLink) dashboardNavLink.href = "StudentView.html";
  // calendar.html is the tutor calendar (timetable import, recurring
  // classes) — a student volunteer needs their own version instead, or
  // they'd land on a tutor-only page with no way back except this link.
  if (calendarNavLink) calendarNavLink.href = "student_calender.html";
  // Timesheets is a tutor-only payroll claim, and applying to tutor a
  // module is a tutor-only concept — neither is useful to a student
  // volunteer.
  if (timesheetsNavLink) timesheetsNavLink.hidden = true;
  if (modulesNavLink) modulesNavLink.hidden = true;
} else {
  // "My Sessions" is a student-volunteer concept (sessions they've
  // volunteered for) — hide it for anyone else (tutors, organisers) so
  // they can't wander onto a student-only page and get stuck
  // (its Dashboard link only knows how to get back to StudentView.html).
  if (mySessionsNavLink) mySessionsNavLink.hidden = true;
}

const form = document.getElementById("entry-form");
const entryIdField = document.getElementById("entry-id");
const dateField = document.getElementById("date");
const hoursField = document.getElementById("hours");
const hoursDisplay = document.getElementById("hours-display");
const startTimeField = document.getElementById("startTime");
const endTimeField = document.getElementById("endTime");
const taskTypeField = document.getElementById("taskType");
const subjectField = document.getElementById("subject");
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

let toastTimer = null;
function showToast(message, type = "success") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("toast--success", "toast--danger");
  el.classList.add(`toast--${type}`, "show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// Replaces the browser's native confirm() with an in-app dialog matching the
// rest of the UI, since the native one can't be styled at all. Resolves true
// on "Confirm", false on "Cancel" or Escape/backdrop dismissal.
const confirmModal = document.getElementById("confirm-modal");
const confirmModalMessage = document.getElementById("confirm-modal-message");
const confirmModalConfirmBtn = document.getElementById(
  "confirm-modal-confirm-btn",
);
const confirmModalCancelBtn = document.getElementById(
  "confirm-modal-cancel-btn",
);

function showConfirm(message, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    confirmModalMessage.textContent = message;
    confirmModalConfirmBtn.textContent = confirmLabel;
    confirmModal.showModal();

    function settle(result) {
      confirmModal.close();
      confirmModalConfirmBtn.removeEventListener("click", onConfirm);
      confirmModalCancelBtn.removeEventListener("click", onCancel);
      confirmModal.removeEventListener("cancel", onCancel);
      resolve(result);
    }
    function onConfirm() {
      settle(true);
    }
    function onCancel() {
      settle(false);
    }

    confirmModalConfirmBtn.addEventListener("click", onConfirm);
    confirmModalCancelBtn.addEventListener("click", onCancel);
    confirmModal.addEventListener("cancel", onCancel); // Escape key
  });
}

// Hours worked is never typed in directly — it's derived from start/end
// time and shown read-only, rounded to a whole hour since tutors are only
// credited in whole hours (minutes don't count either way). Only reacts to
// the user actually typing a time (the "input" event) — enterEditMode()
// below sets .value directly, which doesn't fire "input", so it never
// recomputes over a stored entry's hours just because it also carries
// start/end times.
function computeHoursFromTimes() {
  const start = startTimeField.value;
  const end = endTimeField.value;
  if (!start || !end) {
    hoursField.value = "";
    hoursDisplay.textContent = "—";
    return;
  }

  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const diffMinutes = endH * 60 + endM - (startH * 60 + startM);
  if (diffMinutes <= 0) return; // end time isn't after start time — leave hours alone

  const wholeHours = Math.round(diffMinutes / 60);
  if (wholeHours === 0) {
    // Under 30 minutes rounds down to nothing billable — leave hours unset
    // rather than crediting a session that rounds to zero.
    hoursField.value = "";
    hoursDisplay.textContent = "Too short to log (rounds to 0 hours)";
    return;
  }
  hoursField.value = wholeHours;
  hoursDisplay.textContent = wholeHours;
}

startTimeField.addEventListener("input", computeHoursFromTimes);
endTimeField.addEventListener("input", computeHoursFromTimes);

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
  hoursDisplay.textContent = "—";
  formTitle.textContent = "Log hours";
  submitBtn.textContent = "Add entry";
  cancelEditBtn.hidden = true;
  formError.hidden = true;
}

function enterEditMode(entry) {
  entryIdField.value = entry.id;
  dateField.value = entry.date;
  hoursField.value = entry.hours;
  hoursDisplay.textContent = entry.hours;
  startTimeField.value = entry.startTime || "";
  endTimeField.value = entry.endTime || "";
  taskTypeField.value = entry.taskType || "Tutoring";
  subjectField.value = entry.subject;
  notesField.value = entry.notes;
  formTitle.textContent = "Edit entry";
  submitBtn.textContent = "Save changes";
  cancelEditBtn.hidden = false;
  formError.hidden = true;
  // scrollIntoView on the form itself stops right at its top edge, leaving
  // the "Edit entry" heading (a sibling above it, not inside it) scrolled
  // out of view — going to the very top of the page instead brings the
  // heading and the whole form into view together.
  window.scrollTo({ top: 0, behavior: "smooth" });
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
      if (!(await showConfirm("Delete this entry?", "Delete"))) return;
      await deleteEntry(entry.id);
      if (entryIdField.value === entry.id) exitEditMode();
      await render();
      showToast("Entry deleted.", "danger");
    });

    actionsTd.append(editBtn, deleteBtn);
    row.appendChild(actionsTd);
    entriesBody.appendChild(row);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  // hours is a hidden field with no native validation of its own now that
  // it's derived rather than typed in — check it explicitly instead.
  if (!hoursField.value) {
    formError.textContent =
      "Enter a start and end time that add up to at least one whole hour.";
    formError.hidden = false;
    return;
  }

  const payload = {
    date: dateField.value,
    hours: Number(hoursField.value),
    startTime: startTimeField.value,
    endTime: endTimeField.value,
    taskType: taskTypeField.value,
    subject: subjectField.value.trim(),
    notes: notesField.value.trim(),
  };

  const duplicate = await findDuplicateEntry(
    payload,
    entryIdField.value || null,
  );
  if (duplicate) {
    formError.textContent =
      "This overlaps an entry you've already logged for this day.";
    formError.hidden = false;
    return;
  }
  formError.hidden = true;

  const isEdit = Boolean(entryIdField.value);
  if (isEdit) {
    await updateEntry(entryIdField.value, payload);
  } else {
    await addEntry(payload);
  }

  currentWeekStart = getWeekStart(payload.date);
  exitEditMode();
  await render();
  showToast(isEdit ? "Entry updated." : "Entry added.");
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

await render();
