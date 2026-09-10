import { highlightActiveTab } from "./nav.js";
import {
  getCurrentUser,
  getEntriesForDate,
  getScheduleForDate,
  addScheduleClasses,
  getCancelledOccurrencesForDate,
  cancelScheduleOccurrence,
  modifyScheduleOccurrence,
  clearScheduleException,
  todayStr,
  clearSchedule,
} from "./storage.js";

const currentUser = getCurrentUser();
if (!currentUser) {
  window.location.href = "login.html";
  throw new Error("Not logged in");
}

highlightActiveTab();

// Timetable import, manual class entry, and clearing the schedule are all
// tutor-only features - not relevant for volunteers.
const isTutor = currentUser.role === "tutor";
const importTimetableCard = document.getElementById("import-timetable-card");
const clearClassesRow = document.getElementById("clear-classes-row");
if (!isTutor) {
  if (importTimetableCard) importTimetableCard.hidden = true;
  if (clearClassesRow) clearClassesRow.hidden = true;
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

if (isTutor) {
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

async function render() {
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

    if (isTutor) {
      cell.classList.add("calendar-day-clickable");
      cell.title = "Click to add a class on this day";
      cell.addEventListener("click", () => openAddClassForm(cellDateStr));
    }

    const dayNumber = document.createElement("span");
    dayNumber.className = "calendar-day-number";
    dayNumber.textContent = cellDay;
    cell.appendChild(dayNumber);

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
      if (isTutor) {
        pill.classList.add("calendar-class-pill--editable");
        pill.addEventListener("click", () =>
          openOccurrenceModal(cls, cellDateStr, false),
        );
      }
      cell.appendChild(pill);
    }

    if (isTutor) {
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

// Popup for managing a single occurrence of a recurring class, without
// touching every other week it repeats on.
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
  });

  const box = document.createElement("div");
  box.className = "card occurrence-modal";
  Object.assign(box.style, {
    background: "#fff",
    maxWidth: "360px",
    width: "90%",
  });

  const heading = document.createElement("h2");
  heading.textContent = cls.title;
  box.appendChild(heading);

  const dateLine = document.createElement("p");
  dateLine.className = "card-hint";
  dateLine.textContent = new Date(`${dateStr}T00:00:00`).toLocaleDateString(
    undefined,
    {
      weekday: "long",
      month: "long",
      day: "numeric",
    },
  );
  box.appendChild(dateLine);

  function closeModal() {
    overlay.remove();
  }

  if (isCancelled) {
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
    const grid = document.createElement("div");
    grid.className = "form-grid";

    const startField = document.createElement("div");
    startField.className = "form-field";
    const startLabel = document.createElement("label");
    startLabel.textContent = "Start time";
    const startInput = document.createElement("input");
    startInput.type = "time";
    startInput.value = cls.startTime || "";
    startField.append(startLabel, startInput);

    const endField = document.createElement("div");
    endField.className = "form-field";
    const endLabel = document.createElement("label");
    endLabel.textContent = "End time";
    const endInput = document.createElement("input");
    endInput.type = "time";
    endInput.value = cls.endTime || "";
    endField.append(endLabel, endInput);

    const venueField = document.createElement("div");
    venueField.className = "form-field full-width";
    const venueLabel = document.createElement("label");
    venueLabel.textContent = "Venue";
    const venueInput = document.createElement("input");
    venueInput.type = "text";
    venueInput.value = cls.venue || "";
    venueField.append(venueLabel, venueInput);

    grid.append(startField, endField, venueField);
    box.appendChild(grid);

    const helpText = document.createElement("p");
    helpText.className = "card-hint";
    helpText.textContent =
      "Changes here only apply to this one day — every other week keeps the usual time and venue.";
    box.appendChild(helpText);

    const actions = document.createElement("div");
    actions.className = "form-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "Save changes for this day";
    saveBtn.addEventListener("click", () => {
      modifyScheduleOccurrence(cls.id, dateStr, {
        startTime: startInput.value || cls.startTime,
        endTime: endInput.value || cls.endTime,
        venue: venueInput.value,
      });
      closeModal();
      render();
    });
    actions.appendChild(saveBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-danger";
    cancelBtn.textContent = "Cancel class for this day";
    cancelBtn.addEventListener("click", () => {
      cancelScheduleOccurrence(cls.id, dateStr);
      closeModal();
      render();
    });
    actions.appendChild(cancelBtn);

    if (cls.isModifiedOccurrence) {
      const revertBtn = document.createElement("button");
      revertBtn.type = "button";
      revertBtn.className = "btn-secondary";
      revertBtn.textContent = "Revert to default";
      revertBtn.addEventListener("click", () => {
        clearScheduleException(cls.id, dateStr);
        closeModal();
        render();
      });
      actions.appendChild(revertBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-secondary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeModal);
    actions.appendChild(closeBtn);

    box.appendChild(actions);
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

clearClassesBtn.addEventListener("click", () => {
  if (!confirm("Remove all imported class times from the calendar?")) return;
  clearSchedule();
  render();
});

window.renderCalendar = render;

window.jumpToCalendarDate = (dateStr) => {
  const [y, m] = dateStr.split("-").map(Number);
  viewYear = y;
  viewMonth = m - 1;
  render();
};

render();
