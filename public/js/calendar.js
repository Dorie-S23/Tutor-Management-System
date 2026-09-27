import { highlightActiveTab } from "./nav.js";
import {
  requireRole,
  getEntriesForDate,
  getScheduleForDate,
  addScheduleClasses,
  getCancelledOccurrencesForDate,
  cancelScheduleOccurrence,
  modifyScheduleOccurrence,
  clearScheduleException,
  updateScheduleClass,
  deleteScheduleClass,
  todayStr,
  clearSchedule,
} from "./storage.js";

// This script is shared by two pages: calendar.html (tutor) and
// student_calender.html (student volunteer) — each declares which role it's
// for via data-page-role, so a user of the *other* role gets sent back to
// their own dashboard instead of landing on a page built for someone else.
const pageRole = document.body.dataset.pageRole || "tutor";
const currentUser = requireRole(pageRole);
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

// Both roles see the weekly Tutorial/Lab sessions of the courses they're
// approved on — a tutor via their tutor applications, a student via the
// courses they volunteer on. On top of that a tutor sees which sessions
// they've excused themselves from, and a student sees the sessions they're
// covering for an excused tutor. Adding/editing/cancelling a class on the
// calendar is a plain scheduling tool either role can use.
const isTutor = currentUser.role === "tutor";
const canManageSchedule = true;

// ---------- tutorial/lab sessions from the modules this tutor tutors ----------

// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday, matching Date#getDay().
const DAY_NAME_TO_INDEX = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

// Same light palette used on the tutor dashboard's "Upcoming sessions" list,
// so a course renders in the same colour everywhere it shows up.
const COURSE_COLORS = [
  { bg: "#e6eeef", text: "#26424b", border: "#26424b" }, // navy
  { bg: "#e3eee6", text: "#2f6b4f", border: "#b9d2c1" }, // green
  { bg: "#f5ead5", text: "#a66a17", border: "#e3cb9a" }, // amber
  { bg: "#ece6f5", text: "#5b3a91", border: "#c9b8e0" }, // purple
  { bg: "#dff0ef", text: "#1f7a72", border: "#a9d9d4" }, // teal
  { bg: "#f6e3ea", text: "#a13d67", border: "#e3b9cc" }, // rose
  { bg: "#e1ecf7", text: "#2560a3", border: "#b7d3ee" }, // blue
  { bg: "#eef0d8", text: "#6b7a1f", border: "#d6dba0" }, // olive
  { bg: "#f3e2d8", text: "#a85332", border: "#e6c2ac" }, // terracotta
];

function courseColor(courseId) {
  return COURSE_COLORS[Number(courseId) % COURSE_COLORS.length];
}

// Weekly-recurring Tutorial/Lab sessions for every module this tutor is
// approved to tutor — flattened from courses (day/start/end/venue set
// straight on the course row, no separate "sessions" table). Courses carry
// no semester start/end date, so these repeat on every matching weekday
// shown on the calendar, same as the organiser's timetable grid does.
let courseSessions = [];

// The tutor's own session excusals, keyed so render() can look up whether a
// given course session on a given date is excused:
// "<courseId>|<date>|<tutorial|lab>". Excusals recorded before session_type
// existed have none, and are keyed "<courseId>|<date>|*" (any session that day).
let excusalsByKey = new Map();

function excusalKey(courseId, dateStr, sessionType) {
  return `${courseId}|${dateStr}|${sessionType || "*"}`;
}

function findExcusal(session, dateStr) {
  return (
    excusalsByKey.get(
      excusalKey(session.courseId, dateStr, session.type.toLowerCase()),
    ) || excusalsByKey.get(excusalKey(session.courseId, dateStr, null))
  );
}

async function fetchExcusals() {
  try {
    const res = await fetch(
      `/api/session-excusals?tutorId=${encodeURIComponent(currentUser.id)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load excusals");
    excusalsByKey = new Map(
      rows.map((e) => [
        excusalKey(e.course_id, e.session_date, e.session_type),
        e,
      ]),
    );
  } catch {
    excusalsByKey = new Map();
  }
}

// For a student volunteer: the tutors' sessions they've been assigned to
// cover, keyed by date, so render() can drop a "Cover" pill onto that day.
let coversByDate = new Map();

async function fetchCovers() {
  try {
    const res = await fetch(
      `/api/session-excusals?coverUserId=${encodeURIComponent(currentUser.id)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load covers");
    coversByDate = new Map();
    for (const excusal of rows) {
      const course = excusal.courses || {};
      const isLab = excusal.session_type === "lab";
      const start = isLab ? course.lab_start_time : course.tutor_start_time;
      const end = isLab ? course.lab_end_time : course.tutor_end_time;
      const cover = {
        courseId: excusal.course_id,
        courseCode: course.course_code || "Session",
        type: isLab ? "Lab" : "Tutorial",
        start: start ? start.slice(0, 5) : "",
        end: end ? end.slice(0, 5) : "",
        venue: (isLab ? course.lab_venues : course.venues) || "",
        tutorName: excusal.tutors?.name || "a tutor",
      };
      const list = coversByDate.get(excusal.session_date) || [];
      list.push(cover);
      coversByDate.set(excusal.session_date, list);
    }
  } catch {
    coversByDate = new Map();
  }
}

async function fetchCourseSessions() {
  if (isTutor) {
    await fetchExcusals();
  } else {
    await fetchCovers();
  }
  try {
    const res = await fetch(
      isTutor
        ? `/api/tutor-applications?tutorId=${encodeURIComponent(currentUser.id)}`
        : `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
    );
    const rows = await res.json();
    if (!res.ok)
      throw new Error(rows.error || "Failed to load course sessions");

    const sessions = [];
    rows
      .filter((app) => (app.status || "").toLowerCase() === "approved")
      .forEach((app) => {
        const course = app.courses;
        if (!course) return;

        if (
          course.Day_of_tut &&
          course.tutor_start_time &&
          course.tutor_end_time &&
          DAY_NAME_TO_INDEX[course.Day_of_tut] !== undefined
        ) {
          sessions.push({
            courseId: app.course_id,
            courseCode: course.course_code,
            type: "Tutorial",
            dayIndex: DAY_NAME_TO_INDEX[course.Day_of_tut],
            start: course.tutor_start_time.slice(0, 5),
            end: course.tutor_end_time.slice(0, 5),
            venue: course.venues || "",
          });
        }

        if (
          course.Day_of_lab &&
          course.lab_start_time &&
          course.lab_end_time &&
          DAY_NAME_TO_INDEX[course.Day_of_lab] !== undefined
        ) {
          sessions.push({
            courseId: app.course_id,
            courseCode: course.course_code,
            type: "Lab",
            dayIndex: DAY_NAME_TO_INDEX[course.Day_of_lab],
            start: course.lab_start_time.slice(0, 5),
            end: course.lab_end_time.slice(0, 5),
            venue: course.lab_venues || "",
          });
        }
      });
    courseSessions = sessions;
  } catch {
    courseSessions = [];
  }
  renderCourseColorKey();
}

// One chip per course actually appearing on the calendar (tutorial/lab
// pills use a different colour per course, cycling through COURSE_COLORS —
// this just explains which is which), rather than every course the tutor
// could possibly be assigned regardless of whether it shows up here.
const courseColorKeyEl = document.getElementById("course-color-key");

function renderCourseColorKey() {
  if (!courseColorKeyEl) return;

  const courses = new Map();
  for (const s of courseSessions) {
    if (!courses.has(s.courseId)) courses.set(s.courseId, s.courseCode);
  }
  for (const covers of coversByDate.values()) {
    for (const c of covers) {
      if (!courses.has(c.courseId)) courses.set(c.courseId, c.courseCode);
    }
  }

  courseColorKeyEl.innerHTML = "";
  if (courses.size === 0) {
    courseColorKeyEl.hidden = true;
    return;
  }

  for (const [courseId, courseCode] of courses) {
    const palette = courseColor(courseId);
    const chip = document.createElement("span");
    chip.className = "course-color-chip";
    chip.style.background = palette.bg;
    chip.style.borderColor = palette.border;
    chip.style.color = palette.text;
    chip.textContent = courseCode;
    courseColorKeyEl.appendChild(chip);
  }

  if (excusalsByKey.size > 0) {
    const excusedChip = document.createElement("span");
    excusedChip.className = "course-color-chip";
    excusedChip.innerHTML =
      '<span class="calendar-excused-tag">Excused</span><span class="calendar-excused-label">struck through</span> = you&rsquo;ve excused yourself';
    courseColorKeyEl.appendChild(excusedChip);
  }

  if (coversByDate.size > 0) {
    const coverChip = document.createElement("span");
    coverChip.className = "course-color-chip";
    coverChip.innerHTML =
      '<span class="calendar-cover-tag">Cover</span> = you&rsquo;re covering for a tutor';
    courseColorKeyEl.appendChild(coverChip);
  }
  courseColorKeyEl.hidden = false;
}

const monthLabelEl = document.getElementById("calendar-month-label");
const gridEl = document.getElementById("calendar-grid");
const prevMonthBtn = document.getElementById("prev-month-btn");
const nextMonthBtn = document.getElementById("next-month-btn");
const clearClassesBtn = document.getElementById("clear-classes-btn");

const addClassBtn = document.getElementById("add-class-btn");
const addClassCard = document.getElementById("add-class-card");
const addClassForm = document.getElementById("add-class-form");
const addClassDateInput = document.getElementById("add-class-date");
const addClassSubjectInput = document.getElementById("add-class-subject");
const addClassStartInput = document.getElementById("add-class-start");
const addClassEndInput = document.getElementById("add-class-end");
const addClassVenueInput = document.getElementById("add-class-venue");
const cancelAddClassBtn = document.getElementById("cancel-add-class-btn");

// ---------- toast ----------

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

function openAddClassForm(dateStr) {
  addClassDateInput.value = dateStr || todayStr();
  addClassCard.hidden = false;
  addClassCard.scrollIntoView({ behavior: "smooth", block: "center" });
  addClassSubjectInput.focus();
}

function closeAddClassForm() {
  addClassCard.hidden = true;
  addClassForm.reset();
}

if (canManageSchedule) {
  addClassBtn.addEventListener("click", () => openAddClassForm(todayStr()));
  cancelAddClassBtn.addEventListener("click", closeAddClassForm);

  addClassForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const date = addClassDateInput.value;
    const [y, m, d] = date.split("-").map(Number);
    const dayOfWeek = new Date(y, m - 1, d).getDay();

    addScheduleClasses([
      {
        title: addClassSubjectInput.value.trim(),
        dayOfWeek,
        firstDate: date,
        endDate: date,
        startTime: addClassStartInput.value,
        endTime: addClassEndInput.value,
        venue: addClassVenueInput.value.trim(),
      },
    ]);

    closeAddClassForm();
    viewYear = y;
    viewMonth = m - 1;
    render();
    showToast("Class added.");
  });
}

const today = new Date();
let viewYear = today.getFullYear();
let viewMonth = today.getMonth(); // 0-11

function toDateStr(year, month, day) {
  const y = year;
  const m = String(month + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// render() awaits a real fetch per day cell (getEntriesForDate), and it's
// called twice in quick succession at load (once directly, once after
// fetchCourseSessions resolves) plus again from prev/next/import handlers.
// Without this guard, an older in-flight call resumes after a newer one has
// already finished and keeps appending its own cells on top — doubling the
// whole grid. Each call claims a token; any call that finds itself stale
// after an await bails out instead of touching the DOM.
let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const monthStart = new Date(viewYear, viewMonth, 1);
  monthLabelEl.textContent = monthStart.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstWeekday = monthStart.getDay(); // 0 = Sunday
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const current = todayStr();

  gridEl.innerHTML = "";

  for (let i = 0; i < totalCells; i++) {
    const dayOffset = i - firstWeekday + 1;
    const cell = document.createElement("div");
    cell.className = "calendar-day";

    let cellYear = viewYear;
    let cellMonth = viewMonth;
    let cellDay = dayOffset;

    if (dayOffset < 1) {
      cellMonth = viewMonth - 1;
      cellYear = cellMonth < 0 ? viewYear - 1 : viewYear;
      cellMonth = (cellMonth + 12) % 12;
      cellDay = daysInPrevMonth + dayOffset;
      cell.classList.add("other-month");
    } else if (dayOffset > daysInMonth) {
      cellDay = dayOffset - daysInMonth;
      cellMonth = viewMonth + 1;
      cellYear = cellMonth > 11 ? viewYear + 1 : viewYear;
      cellMonth = cellMonth % 12;
      cell.classList.add("other-month");
    }

    const cellDateStr = toDateStr(cellYear, cellMonth, cellDay);
    if (cellDateStr === current) cell.classList.add("today");

    if (canManageSchedule) {
      cell.classList.add("calendar-day-clickable");
      cell.title = "Click to add a class on this day";
      cell.addEventListener("click", () => openAddClassForm(cellDateStr));
    }

    const dayNumber = document.createElement("span");
    dayNumber.className = "calendar-day-number";
    dayNumber.textContent = cellDay;
    cell.appendChild(dayNumber);

    {
      const cellWeekday = new Date(cellYear, cellMonth, cellDay).getDay();
      const coversToday = coversByDate.get(cellDateStr) || [];
      for (const s of courseSessions) {
        if (s.dayIndex !== cellWeekday) continue;
        // A student covering one of their own regular sessions gets just
        // the Cover pill below, not the same session twice.
        if (
          coversToday.some(
            (c) =>
              String(c.courseId) === String(s.courseId) && c.type === s.type,
          )
        ) {
          continue;
        }
        const palette = courseColor(s.courseId);
        const excusal = findExcusal(s, cellDateStr);
        const pill = document.createElement("div");
        pill.className = "calendar-course-pill";
        pill.style.background = palette.bg;
        pill.style.borderColor = palette.border;
        pill.style.color = palette.text;
        const label = `${s.start} ${s.courseCode} · ${s.type === "Lab" ? "Lab" : "Tut"}`;
        const details = `${s.courseCode} ${s.type} · ${s.start}–${s.end}${s.venue ? ` · ${s.venue}` : ""}`;
        if (excusal) {
          pill.classList.add("calendar-course-pill--excused");
          const tag = document.createElement("span");
          tag.className = "calendar-excused-tag";
          tag.textContent = "Excused";
          const text = document.createElement("span");
          text.className = "calendar-excused-label";
          text.textContent = label;
          pill.append(tag, text);
          const coverText = excusal.cover?.name
            ? ` · ${excusal.cover.name} is covering`
            : " · no volunteer cover yet";
          pill.title = `You're excused from this session — ${details}${coverText}${excusal.reason ? ` · Reason: ${excusal.reason}` : ""}`;
        } else {
          pill.textContent = label;
          pill.title = details;
        }
        cell.appendChild(pill);
      }
    }

    if (!isTutor) {
      for (const c of coversByDate.get(cellDateStr) || []) {
        const palette = courseColor(c.courseId);
        const pill = document.createElement("div");
        pill.className = "calendar-course-pill calendar-course-pill--cover";
        pill.style.background = palette.bg;
        pill.style.borderColor = palette.border;
        pill.style.color = palette.text;
        const tag = document.createElement("span");
        tag.className = "calendar-cover-tag";
        tag.textContent = "Cover";
        pill.append(
          tag,
          `${c.start} ${c.courseCode} · ${c.type === "Lab" ? "Lab" : "Tut"}`,
        );
        pill.title = `You're covering ${c.courseCode} ${c.type} for ${c.tutorName} · ${c.start}–${c.end}${c.venue ? ` · ${c.venue}` : ""}`;
        cell.appendChild(pill);
      }
    }

    const classes = getScheduleForDate(cellDateStr);
    for (const cls of classes) {
      const pill = document.createElement("div");
      pill.className = "calendar-class-pill";
      // Day cells are narrow, so show just the course code — full title is in the tooltip.
      const courseCode = (cls.title.match(/^[A-Z]{2,6}\s?\d{3,4}[A-Z]?/) || [
        cls.title,
      ])[0];
      const modifiedMark = cls.isModifiedOccurrence ? " \u270E" : "";
      pill.textContent = `${cls.startTime} ${courseCode}${modifiedMark}`;
      pill.title = cls.isModifiedOccurrence
        ? `${cls.title} · ${cls.startTime}-${cls.endTime} · ${cls.venue} · edited for this day`
        : `${cls.title} · ${cls.startTime}-${cls.endTime} · ${cls.venue}`;
      if (canManageSchedule) {
        pill.classList.add("calendar-class-pill--editable");
        pill.addEventListener("click", () =>
          openOccurrenceModal(cls, cellDateStr, false),
        );
      }
      cell.appendChild(pill);
    }

    if (canManageSchedule) {
      const cancelled = getCancelledOccurrencesForDate(cellDateStr);
      for (const cls of cancelled) {
        const pill = document.createElement("div");
        pill.className = "calendar-class-pill calendar-class-pill--cancelled";
        const courseCode = (cls.title.match(/^[A-Z]{2,6}\s?\d{3,4}[A-Z]?/) || [
          cls.title,
        ])[0];
        pill.textContent = `\u2715 ${courseCode}`;
        pill.title = `${cls.title} cancelled for this day · click to restore`;
        pill.addEventListener("click", () =>
          openOccurrenceModal(cls, cellDateStr, true),
        );
        cell.appendChild(pill);
      }
    }

    const entries = await getEntriesForDate(cellDateStr);
    if (token !== renderToken) return; // superseded by a newer render() call

    for (const entry of entries) {
      const pill = document.createElement("div");
      pill.className = "calendar-session-pill";
      const label = [`${entry.hours}h`, entry.subject]
        .filter(Boolean)
        .join(" · ");
      pill.textContent = label;
      cell.appendChild(pill);
    }

    gridEl.appendChild(cell);
  }
}

prevMonthBtn.addEventListener("click", () => {
  viewMonth -= 1;
  if (viewMonth < 0) {
    viewMonth = 11;
    viewYear -= 1;
  }
  render();
});

nextMonthBtn.addEventListener("click", () => {
  viewMonth += 1;
  if (viewMonth > 11) {
    viewMonth = 0;
    viewYear += 1;
  }
  render();
});

// Popup for managing a class — edit this occurrence, the recurring series,
// cancel/restore, or delete entirely.
const DAY_INDEX_TO_NAME = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function openOccurrenceModal(cls, dateStr, isCancelled) {
  const overlay = document.createElement("div");
  overlay.className = "occurrence-modal-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "1000",
    overflowY: "auto",
    padding: "24px 0",
  });

  const box = document.createElement("div");
  box.className = "card occurrence-modal";
  Object.assign(box.style, {
    background: "#fff",
    maxWidth: "440px",
    width: "92%",
    maxHeight: "90vh",
    overflowY: "auto",
  });

  function closeModal() {
    overlay.remove();
  }

  // ---- Header ----
  const heading = document.createElement("h2");
  heading.textContent = isCancelled ? "Cancelled class" : "Edit class";
  box.appendChild(heading);

  const dateLine = document.createElement("p");
  dateLine.className = "card-hint";
  dateLine.textContent = new Date(dateStr + "T00:00:00").toLocaleDateString(
    undefined,
    { weekday: "long", month: "long", day: "numeric" },
  );
  box.appendChild(dateLine);

  if (isCancelled) {
    // ---- Cancelled state: restore or close ----
    const note = document.createElement("p");
    note.textContent = "This class is cancelled on this day.";
    box.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "form-actions";

    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "btn-primary";
    restoreBtn.textContent = "Restore this class";
    restoreBtn.addEventListener("click", () => {
      clearScheduleException(cls.id, dateStr);
      closeModal();
      render();
      showToast("Class restored.");
    });
    actions.appendChild(restoreBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-secondary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeModal);
    actions.appendChild(closeBtn);

    box.appendChild(actions);
  } else {
    // ---- Editable form (review-table style) ----
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["Field", "Value"].forEach((t) => {
      const th = document.createElement("th");
      th.textContent = t;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    // Subject row
    const subjectRow = document.createElement("tr");
    const subjectLabel = document.createElement("td");
    subjectLabel.textContent = "Subject";
    const subjectCell = document.createElement("td");
    const subjectInput = document.createElement("input");
    subjectInput.type = "text";
    subjectInput.value = cls.title || "";
    subjectInput.style.width = "100%";
    subjectCell.appendChild(subjectInput);
    subjectRow.append(subjectLabel, subjectCell);
    tbody.appendChild(subjectRow);

    // Day row (read-only for context)
    const dayRow = document.createElement("tr");
    const dayLabel = document.createElement("td");
    dayLabel.textContent = "Day";
    const dayCell = document.createElement("td");
    dayCell.textContent = DAY_INDEX_TO_NAME[cls.dayOfWeek] || "";
    dayRow.append(dayLabel, dayCell);
    tbody.appendChild(dayRow);

    // Start time row
    const startRow = document.createElement("tr");
    const startLabel = document.createElement("td");
    startLabel.textContent = "Start time";
    const startCell = document.createElement("td");
    const startInput = document.createElement("input");
    startInput.type = "time";
    startInput.value = cls.startTime || "";
    startCell.appendChild(startInput);
    startRow.append(startLabel, startCell);
    tbody.appendChild(startRow);

    // End time row
    const endRow = document.createElement("tr");
    const endLabel = document.createElement("td");
    endLabel.textContent = "End time";
    const endCell = document.createElement("td");
    const endInput = document.createElement("input");
    endInput.type = "time";
    endInput.value = cls.endTime || "";
    endCell.appendChild(endInput);
    endRow.append(endLabel, endCell);
    tbody.appendChild(endRow);

    // Venue row
    const venueRow = document.createElement("tr");
    const venueLabel = document.createElement("td");
    venueLabel.textContent = "Venue";
    const venueCell = document.createElement("td");
    const venueInput = document.createElement("input");
    venueInput.type = "text";
    venueInput.value = cls.venue || "";
    venueInput.style.width = "100%";
    venueCell.appendChild(venueInput);
    venueRow.append(venueLabel, venueCell);
    tbody.appendChild(venueRow);

    table.appendChild(tbody);
    box.appendChild(table);

    // ---- Per-occurrence actions ----
    const occurrenceSection = document.createElement("div");
    occurrenceSection.style.marginTop = "12px";

    const occHint = document.createElement("p");
    occHint.className = "card-hint";
    occHint.textContent =
      "Changes below apply only to this one day — every other week keeps the usual details.";
    occurrenceSection.appendChild(occHint);

    const occActions = document.createElement("div");
    occActions.className = "form-actions";

    const saveOccBtn = document.createElement("button");
    saveOccBtn.type = "button";
    saveOccBtn.className = "btn-primary";
    saveOccBtn.textContent = "Save for this day only";
    saveOccBtn.addEventListener("click", () => {
      modifyScheduleOccurrence(cls.id, dateStr, {
        title: subjectInput.value.trim() || cls.title,
        startTime: startInput.value || cls.startTime,
        endTime: endInput.value || cls.endTime,
        venue: venueInput.value,
      });
      closeModal();
      render();
      showToast("Saved for this day.");
    });
    occActions.appendChild(saveOccBtn);

    const cancelOccBtn = document.createElement("button");
    cancelOccBtn.type = "button";
    cancelOccBtn.className = "btn-danger";
    cancelOccBtn.textContent = "Cancel class for this day";
    cancelOccBtn.addEventListener("click", () => {
      cancelScheduleOccurrence(cls.id, dateStr);
      closeModal();
      render();
      showToast("Class cancelled for this day.", "danger");
    });
    occActions.appendChild(cancelOccBtn);

    if (cls.isModifiedOccurrence) {
      const revertBtn = document.createElement("button");
      revertBtn.type = "button";
      revertBtn.className = "btn-secondary";
      revertBtn.textContent = "Revert to default";
      revertBtn.addEventListener("click", () => {
        clearScheduleException(cls.id, dateStr);
        closeModal();
        render();
        showToast("Reverted to the recurring default.");
      });
      occActions.appendChild(revertBtn);
    }

    occurrenceSection.appendChild(occActions);
    box.appendChild(occurrenceSection);

    // ---- Recurring series actions ----
    const seriesSection = document.createElement("div");
    seriesSection.style.marginTop = "16px";
    seriesSection.style.borderTop = "1px solid #e0e0e0";
    seriesSection.style.paddingTop = "12px";

    const seriesHint = document.createElement("p");
    seriesHint.className = "card-hint";
    seriesHint.textContent =
      "Changes below update the recurring class itself — this and all future weeks will reflect the new details.";
    seriesSection.appendChild(seriesHint);

    const seriesActions = document.createElement("div");
    seriesActions.className = "form-actions";

    const saveSeriesBtn = document.createElement("button");
    saveSeriesBtn.type = "button";
    saveSeriesBtn.className = "btn-primary";
    saveSeriesBtn.textContent = "Update all future classes";
    saveSeriesBtn.addEventListener("click", () => {
      updateScheduleClass(cls.id, {
        title: subjectInput.value.trim() || cls.title,
        startTime: startInput.value || cls.startTime,
        endTime: endInput.value || cls.endTime,
        venue: venueInput.value,
      });
      closeModal();
      render();
      showToast("Recurring class updated.");
    });
    seriesActions.appendChild(saveSeriesBtn);

    const deleteSeriesBtn = document.createElement("button");
    deleteSeriesBtn.type = "button";
    deleteSeriesBtn.className = "btn-danger";
    deleteSeriesBtn.textContent = "Delete all future classes";
    deleteSeriesBtn.addEventListener("click", async () => {
      if (
        await showConfirm(
          "Remove this recurring class and all its future occurrences?",
          "Delete",
        )
      ) {
        deleteScheduleClass(cls.id);
        closeModal();
        render();
        showToast("Recurring class deleted.", "danger");
      }
    });
    seriesActions.appendChild(deleteSeriesBtn);

    seriesSection.appendChild(seriesActions);
    box.appendChild(seriesSection);

    // ---- Close ----
    const closeRow = document.createElement("div");
    closeRow.className = "form-actions";
    closeRow.style.marginTop = "12px";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-secondary";
    closeBtn.textContent = "Close without saving";
    closeBtn.addEventListener("click", closeModal);
    closeRow.appendChild(closeBtn);
    box.appendChild(closeRow);
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", onKey);
    }
  });

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

clearClassesBtn.addEventListener("click", async () => {
  if (
    !(await showConfirm(
      "Remove all imported class times from the calendar?",
      "Clear",
    ))
  )
    return;
  clearSchedule();
  render();
  showToast("All class times cleared.", "danger");
});

window.renderCalendar = render;

window.jumpToCalendarDate = (dateStr) => {
  const [y, m] = dateStr.split("-").map(Number);
  viewYear = y;
  viewMonth = m - 1;
  render();
};

render();
fetchCourseSessions().then(render);
