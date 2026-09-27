// Tutor "Log hours": pick one of the modules you tutor, then choose an
// upcoming scheduled session (its tutorial or lab). The date and times are
// locked to that session's allocated slot — the same rule the server
// enforces — and the entry lands in the week table below, rolling up into
// the Timesheets page. Rebuilt on the app.css design system (teal tutor
// theme) while keeping every legacy hook — the #entry-form and the
// per-week table — intact.

import {
  requireRole,
  addEntry,
  updateEntry,
  deleteEntry,
  findDuplicateEntry,
  getWeekStart,
  addDays,
  getEntriesForWeek,
  todayStr,
  toDateStr,
} from "./storage.js";

const currentUser = requireRole("tutor");
if (!currentUser) {
  throw new Error("Not authorized");
}

// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday, matching
// JS Date.getDay().
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const CHIP_ACCENTS = [
  "chip-icon--blue",
  "chip-icon--violet",
  "chip-icon--teal",
  "chip-icon--amber",
];

const MODULE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5.5 6.7 12 10.4l6.5-3.7L12 3Z"/><path d="m7.5 9 4.5 2.6L16.5 9v5L12 16.6 7.5 14V9Z"/><path d="M18.5 7v5"/></svg>`;
const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

// ---------- element handles ----------

const courseChipsEl = document.getElementById("courseChips");
const sessionStepEl = document.getElementById("sessionStep");
const sessionChipsEl = document.getElementById("sessionChips");
const attendanceCardEl = document.getElementById("attendanceCard");
const scheduledBoxEl = document.getElementById("scheduledBox");
const scheduledWhenEl = document.getElementById("scheduledWhen");
const scheduledVenueEl = document.getElementById("scheduledVenue");

const form = document.getElementById("entry-form");
const entryIdField = document.getElementById("entry-id");
const dateField = document.getElementById("date");
const hoursField = document.getElementById("hours");
const hoursDisplay = document.getElementById("hours-display");
const startTimeField = document.getElementById("startTime");
const endTimeField = document.getElementById("endTime");
const taskTypeField = document.getElementById("taskType");
const courseSelectField = document.getElementById("courseSelect");
const notesField = document.getElementById("notes");
const formTitle = document.getElementById("form-title");
const submitBtn = document.getElementById("submit-btn");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const formError = document.getElementById("form-error");

const prevWeekBtn = document.getElementById("prev-week-btn");
const nextWeekBtn = document.getElementById("next-week-btn");
const weekLabel = document.getElementById("week-label");
const weekTotalEl = document.getElementById("week-total");
const entriesBody = document.getElementById("entries-body");
const emptyState = document.getElementById("empty-state");

// Modules the signed-in tutor has been approved to tutor; filled by the
// init IIFE once /api/tutor-applications answers.
let myCourses = [];
let selectedCourse = null;
let selectedSession = null;
let currentWeekStart = getWeekStart(todayStr());

dateField.value = todayStr();

// ---------- small helpers ----------

function sliceTime(time) {
  return (time || "").slice(0, 5);
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// Entry dates come out of storage as "YYYY-MM-DD" strings — parse them as
// local dates so the weekday shown never shifts by a timezone.
function formatEntryDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return formatDate(new Date(y, m - 1, d));
}

// The next few occurrences of a course's weekly Tutorial/Lab, soonest
// first — the sessions a tutor can prefill an entry from.
function upcomingSessions(course, count = 4) {
  const definitions = [
    {
      type: "Tutorial",
      day: course.Day_of_tut,
      start: course.tutor_start_time,
      end: course.tutor_end_time,
      venue: course.venues,
    },
    {
      type: "Lab",
      day: course.Day_of_lab,
      start: course.lab_start_time,
      end: course.lab_end_time,
      venue: course.lab_venues,
    },
  ].filter((s) => s.day && s.start && s.end);

  const now = new Date();
  const nowHHMM = now.toTimeString().slice(0, 5);
  const occurrences = [];

  definitions.forEach((definition) => {
    const targetIdx = DAY_NAMES.indexOf(definition.day);
    if (targetIdx === -1) return;
    for (let week = 0; week < count; week += 1) {
      const days = ((targetIdx - now.getDay() + 7) % 7) + week * 7;
      // Today's session only counts while it hasn't ended yet.
      if (week === 0 && days === 0 && sliceTime(definition.end) <= nowHHMM) {
        continue;
      }
      const date = new Date(now);
      date.setDate(date.getDate() + days);
      occurrences.push({ ...definition, date });
    }
  });

  return occurrences.sort((a, b) => a.date - b.date).slice(0, count);
}

// ---------- logged duration (sidebar) ----------

// Hours worked is never typed in directly — it's derived from start/end
// time and shown read-only, rounded to a whole hour since tutors are only
// credited in whole hours (minutes don't count either way). Only reacts to
// the user actually typing a time (the "input" event) — enterEditMode() and
// selectSession() set .value directly, which doesn't fire "input", so they
// call this explicitly when they need it.
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
    hoursDisplay.textContent = "Rounds to 0h";
    return;
  }
  hoursField.value = wholeHours;
  hoursDisplay.textContent = `${wholeHours}h`;
}

startTimeField.addEventListener("input", computeHoursFromTimes);
endTimeField.addEventListener("input", computeHoursFromTimes);

// ---------- scheduled-session box ----------

function setScheduledBox(whenText, venueText) {
  const hasSession = Boolean(whenText);
  scheduledBoxEl.hidden = !hasSession;
  scheduledWhenEl.textContent = whenText || "";
  scheduledVenueEl.textContent = venueText || "TBC";
}

function sessionBoxValues(session) {
  return [
    `${formatDate(session.date)} · ${sliceTime(session.start)}–${sliceTime(session.end)}`,
    session.venue || "TBC",
  ];
}

// ---------- module + session chips ----------

function renderCourseChips(courses) {
  courseChipsEl.innerHTML = "";

  if (courses.length === 0) {
    courseChipsEl.innerHTML = `<p class="empty-state">You're not tutoring any modules yet. <a href="modules.html">Apply to tutor a module</a> and it will show up here.</p>`;
    return;
  }

  courses.forEach((course, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "course-chip";
    chip.dataset.courseId = course.id;
    chip.innerHTML = `
      <span class="chip-icon ${CHIP_ACCENTS[index % CHIP_ACCENTS.length]}">${MODULE_ICON}</span>
      <span class="course-chip__text">
        <span class="course-chip__code"></span>
        <span class="course-chip__name"></span>
      </span>
    `;
    chip.querySelector(".course-chip__code").textContent = course.course_code;
    chip.querySelector(".course-chip__name").textContent = course.course_name;
    chip.addEventListener("click", () => selectCourse(course, chip));
    courseChipsEl.appendChild(chip);
  });
}

// Highlights whichever chip matches the module select — used when the
// select changes or an entry being edited carries a specific module.
function syncCourseChips() {
  const value = String(courseSelectField.value);
  courseChipsEl.querySelectorAll(".course-chip").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.courseId === value);
  });
}

function selectCourse(course, chip) {
  selectedCourse = course;
  courseSelectField.value = course.id;
  courseChipsEl.querySelectorAll(".course-chip").forEach((el) => {
    el.classList.toggle("is-selected", el === chip);
  });
  renderSessionChips(course);
}

function renderSessionChips(course) {
  selectedSession = null;
  setScheduledBox();
  sessionStepEl.hidden = false;
  // A new entry can only come from a scheduled session (step 2), so the
  // details card stays closed until one is picked. While editing an entry
  // the card keeps its form open so notes can still be changed.
  attendanceCardEl.hidden = !entryIdField.value;

  const sessions = upcomingSessions(course);

  if (sessions.length === 0) {
    sessionChipsEl.innerHTML = `<p class="empty-state">No scheduled sessions for this module yet — check back once the timetable is set.</p>`;
    return;
  }

  sessionChipsEl.innerHTML = "";
  sessions.forEach((session) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "session-chip";
    chip.innerHTML = `
      <span class="session-chip__date">${CALENDAR_ICON}<span class="session-chip__day"></span></span>
      <span class="session-chip__time"></span>
    `;
    chip.querySelector(".session-chip__day").textContent = formatDate(
      session.date,
    );
    chip.querySelector(".session-chip__time").textContent =
      `${sliceTime(session.start)}–${sliceTime(session.end)}${session.venue ? ` · ${session.venue}` : ""}`;
    chip.addEventListener("click", () => selectSession(session, chip));
    sessionChipsEl.appendChild(chip);
  });
}

// Picking a session prefills the form so the tutor just confirms the times.
function selectSession(session, chip) {
  selectedSession = session;
  sessionChipsEl.querySelectorAll(".session-chip").forEach((el) => {
    el.classList.toggle("is-selected", el === chip);
  });

  dateField.value = toDateStr(session.date);
  startTimeField.value = sliceTime(session.start);
  endTimeField.value = sliceTime(session.end);
  computeHoursFromTimes();

  setScheduledBox(...sessionBoxValues(session));
  notesField.value = "";
  formError.hidden = true;

  attendanceCardEl.hidden = false;
  attendanceCardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearSessionSelection() {
  selectedSession = null;
  sessionChipsEl
    .querySelectorAll(".session-chip.is-selected")
    .forEach((el) => el.classList.remove("is-selected"));
  setScheduledBox();
  // Leave a clean form behind so the next entry starts from scratch — and
  // close the details card until a session is picked again.
  startTimeField.value = "";
  endTimeField.value = "";
  hoursField.value = "";
  hoursDisplay.textContent = "—";
  attendanceCardEl.hidden = true;
}

// Keep the chips in step when the module is picked from the select instead.
courseSelectField.addEventListener("change", () => {
  const course = myCourses.find(
    (c) => String(c.id) === courseSelectField.value,
  );
  if (!course) {
    selectedCourse = null;
    sessionStepEl.hidden = true;
    sessionChipsEl.innerHTML = "";
    clearSessionSelection();
    attendanceCardEl.hidden = true;
    return;
  }
  selectedCourse = course;
  syncCourseChips();
  renderSessionChips(course);
});

function populateCourseSelect() {
  courseSelectField.innerHTML = '<option value="">Select a module</option>';
  myCourses.forEach((course) => {
    const option = document.createElement("option");
    option.value = course.id;
    option.textContent = `${course.course_code} — ${course.course_name}`;
    courseSelectField.appendChild(option);
  });
}

// Older entries may reference a module the tutor isn't currently approved
// for (the approval was revoked, or it came from another organiser), and
// without its option the form can't be saved. Pull the full course list so
// editing still works.
async function ensureCourseOption(courseId) {
  const value = String(courseId ?? "");
  if (!value) return;
  const exists = Array.from(courseSelectField.options).some(
    (o) => o.value === value,
  );
  if (exists) return;

  try {
    const res = await fetch("/api/courses");
    const courses = await res.json();
    if (!res.ok) throw new Error(courses.error);
    const course = courses.find((c) => String(c.id) === value);
    if (!course) return;
    const option = document.createElement("option");
    option.value = course.id;
    option.textContent = `${course.course_code} — ${course.course_name}`;
    courseSelectField.appendChild(option);
    if (!myCourses.some((c) => String(c.id) === value)) {
      myCourses.push({ ...course, id: course.id });
    }
  } catch {
    // Without the extra option the select just shows its placeholder.
  }
}

// ---------- toast ----------

function showToast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- confirm dialog ----------

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

// ---------- week table ----------

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
  hoursField.value = "";
  hoursDisplay.textContent = "—";
  formTitle.textContent = "Log your hours";
  submitBtn.textContent = "Add entry";
  cancelEditBtn.hidden = true;
  formError.hidden = true;

  // form.reset() wipes the wizard's prefill — put the selected module and
  // session back so the card stays consistent with the chips above it.
  if (selectedCourse) courseSelectField.value = selectedCourse.id;
  syncCourseChips();
  if (selectedSession) {
    dateField.value = toDateStr(selectedSession.date);
    startTimeField.value = sliceTime(selectedSession.start);
    endTimeField.value = sliceTime(selectedSession.end);
    computeHoursFromTimes();
    setScheduledBox(...sessionBoxValues(selectedSession));
  } else {
    setScheduledBox();
  }
  attendanceCardEl.hidden = !selectedSession;
}

async function enterEditMode(entry) {
  entryIdField.value = entry.id;
  dateField.value = entry.date;
  hoursField.value = entry.hours;
  hoursDisplay.textContent = `${entry.hours}h`;
  startTimeField.value = entry.startTime ? sliceTime(entry.startTime) : "";
  endTimeField.value = entry.endTime ? sliceTime(entry.endTime) : "";
  taskTypeField.value = entry.taskType || "Tutoring";
  await ensureCourseOption(entry.courseId);
  courseSelectField.value = entry.courseId ?? "";
  selectedCourse =
    myCourses.find((c) => String(c.id) === String(entry.courseId ?? "")) ??
    selectedCourse;
  syncCourseChips();
  notesField.value = entry.notes || "";
  formTitle.textContent = "Edit entry";
  submitBtn.textContent = "Save changes";
  cancelEditBtn.hidden = false;
  formError.hidden = true;
  attendanceCardEl.hidden = false;
  setScheduledBox(
    `${formatEntryDate(entry.date)}${
      entry.startTime
        ? ` · ${sliceTime(entry.startTime)}–${sliceTime(entry.endTime)}`
        : ""
    }`,
    "",
  );
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
      formatEntryDate(entry.date),
      `${entry.hours}h`,
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
    deleteBtn.className = "btn-link btn-link--danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!(await showConfirm("Delete this entry?", "Delete"))) return;
      await deleteEntry(entry.id);
      if (entryIdField.value === entry.id) exitEditMode();
      await render();
      showToast("Entry deleted.");
    });

    actionsTd.append(editBtn, deleteBtn);
    row.appendChild(actionsTd);
    entriesBody.appendChild(row);
  }
}

// ---------- submit ----------

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  // New entries can only come from a scheduled session — the read-only
  // date and time fields above are filled by picking one of the chips in
  // step 2, so there is nothing to submit without that choice.
  if (!entryIdField.value && !selectedSession) {
    formError.textContent = "Pick one of the scheduled sessions first.";
    formError.hidden = false;
    return;
  }

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
    courseId: Number(courseSelectField.value),
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
  // A fresh entry leaves the module selected but clears the session, ready
  // for the next pick; an edited one keeps whatever session was showing.
  if (!isEdit) clearSessionSelection();
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

// ---------- init: load the tutor's approved modules ----------

(async () => {
  let rows = null;
  try {
    const res = await fetch(
      `/api/tutor-applications?tutorId=${encodeURIComponent(currentUser.id)}`,
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    rows = body;
  } catch {
    rows = null;
  }

  if (!rows) {
    courseChipsEl.innerHTML = `<p class="empty-state">Couldn't load your modules right now — try again later.</p>`;
    return;
  }

  // Modules I'm approved to tutor — each approved application's joined
  // course, deduplicated by course id.
  const byCourse = new Map();
  rows
    .filter(
      (app) => (app.status || "").toLowerCase() === "approved" && app.courses,
    )
    .forEach((app) => {
      const course = {
        ...app.courses,
        id: app.course_id ?? app.courses.id,
      };
      if (!byCourse.has(course.id)) byCourse.set(course.id, course);
    });
  myCourses = [...byCourse.values()];

  populateCourseSelect();
  renderCourseChips(myCourses);
})();
