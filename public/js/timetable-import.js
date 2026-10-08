import { addScheduleClasses, getCurrentUser } from "./storage.js";
import {
  parseTimetablePdf,
  firstOccurrenceOnOrAfter,
} from "./timetable-parser.js";

const fileInput = document.getElementById("timetable-file");
const semesterStartInput = document.getElementById("semester-start");
const semesterEndInput = document.getElementById("semester-end");
const parseBtn = document.getElementById("parse-timetable-btn");
const statusEl = document.getElementById("timetable-status");
const reviewSection = document.getElementById("timetable-review");
const reviewBody = document.getElementById("timetable-review-body");
const saveBtn = document.getElementById("save-timetable-btn");
const cancelBtn = document.getElementById("cancel-timetable-btn");
const fileNameEl = document.getElementById("timetable-file-name");
const profileNoteEl = document.getElementById("timetable-profile-note");

// The timetable PDF saved on the user's profile page (see
// profile-timetable.js), if any. When there is one, Parse PDF uses it
// without the user picking the file again; choosing a PDF here overrides it.
let profileTimetable = null;

function profileTimetableUrl() {
  const user = getCurrentUser();
  return user?.id
    ? `/api/profile/${encodeURIComponent(user.id)}/timetable`
    : null;
}

function describeProfileUpload(updatedAt) {
  const date = updatedAt ? new Date(updatedAt) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return ` (uploaded ${date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })})`;
}

function renderProfileNote() {
  if (!profileNoteEl) return;
  const show = Boolean(profileTimetable) && !fileInput.files[0];
  profileNoteEl.hidden = !show;
  profileNoteEl.textContent = show
    ? `Using the timetable saved on your profile${describeProfileUpload(profileTimetable.updatedAt)} — pick your dates and press Parse PDF, or choose a different PDF above.`
    : "";
}

async function loadProfileTimetable() {
  const url = profileTimetableUrl();
  if (!url) return;
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    profileTimetable = res.ok && body.uploaded ? body : null;
  } catch {
    // No profile copy to offer — the file picker still works as before.
    profileTimetable = null;
  }
  renderProfileNote();
}

async function fetchProfileTimetableFile() {
  const res = await fetch(`${profileTimetableUrl()}/file`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body.error ||
        "Couldn't load the timetable saved on your profile — choose the PDF instead.",
    );
  }
  const blob = await res.blob();
  return new File([blob], "timetable.pdf", { type: "application/pdf" });
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileNameEl.hidden = !file;
  fileNameEl.textContent = file ? `Selected: ${file.name}` : "";
  renderProfileNote();
});

loadProfileTimetable();

let parsedClasses = [];

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

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.hidden = !message;
  statusEl.classList.toggle("form-error", isError);
}

function renderReview() {
  reviewBody.innerHTML = "";
  parsedClasses.forEach((cls, index) => {
    const tr = document.createElement("tr");

    const checkTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    checkTd.appendChild(checkbox);
    tr.appendChild(checkTd);

    const dayTd = document.createElement("td");
    dayTd.textContent = `${cls.dayName} (from ${cls.firstDate})`;
    tr.appendChild(dayTd);

    const timeTd = document.createElement("td");
    timeTd.textContent = `${cls.startTime}-${cls.endTime}`;
    tr.appendChild(timeTd);

    const titleTd = document.createElement("td");
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = cls.title;
    titleInput.addEventListener("input", () => {
      cls.title = titleInput.value;
    });
    titleTd.appendChild(titleInput);
    tr.appendChild(titleTd);

    const venueTd = document.createElement("td");
    const venueInput = document.createElement("input");
    venueInput.type = "text";
    venueInput.value = cls.venue;
    venueInput.addEventListener("input", () => {
      cls.venue = venueInput.value;
    });
    venueTd.appendChild(venueInput);
    tr.appendChild(venueTd);

    reviewBody.appendChild(tr);
  });
  reviewSection.hidden = false;
}

parseBtn.addEventListener("click", async () => {
  const chosenFile = fileInput.files[0];
  if (!chosenFile && !profileTimetable) {
    setStatus("Choose a PDF file first.", true);
    return;
  }
  if (!semesterStartInput.value) {
    setStatus(
      'Pick a "classes start on" date first — the PDF has no calendar dates of its own.',
      true,
    );
    return;
  }

  reviewSection.hidden = true;
  parseBtn.disabled = true;
  parseBtn.classList.add("is-loading");
  parseBtn.setAttribute("aria-busy", "true");
  parseBtn.textContent = "Parsing…";
  setStatus(
    chosenFile ? "Reading PDF…" : "Loading the timetable from your profile…",
  );

  try {
    const file = chosenFile || (await fetchProfileTimetableFile());
    const classes = await parseTimetablePdf(file, (message) =>
      setStatus(message),
    );
    parsedClasses = classes.map((cls) => ({
      ...cls,
      firstDate: firstOccurrenceOnOrAfter(
        semesterStartInput.value,
        cls.dayOfWeek,
      ),
    }));
    if (parsedClasses.length === 0) {
      setStatus(
        "No classes could be recognised in this PDF — you may need to add them manually.",
        true,
      );
      return;
    }
    renderReview();
    setStatus(
      `Found ${parsedClasses.length} class${parsedClasses.length === 1 ? "" : "es"} — check them below before adding.`,
    );
  } catch (err) {
    setStatus(err.message || "Could not read that PDF.", true);
  } finally {
    parseBtn.disabled = false;
    parseBtn.classList.remove("is-loading");
    parseBtn.removeAttribute("aria-busy");
    parseBtn.textContent = "Parse PDF";
  }
});

saveBtn.addEventListener("click", async () => {
  const endDate = semesterEndInput.value;
  if (!endDate) {
    setStatus('Pick a "repeat weekly until" date first.', true);
    return;
  }

  const selected = [];
  reviewBody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) selected.push(parsedClasses[Number(cb.dataset.index)]);
  });

  if (selected.length === 0) {
    setStatus("Select at least one class to add.", true);
    return;
  }

  saveBtn.disabled = true;
  try {
    await addScheduleClasses(
      selected.map((cls) => ({
        title: cls.title,
        dayOfWeek: cls.dayOfWeek,
        firstDate: cls.firstDate,
        endDate,
        startTime: cls.startTime,
        endTime: cls.endTime,
        venue: cls.venue,
      })),
    );
  } catch (err) {
    setStatus(err.message || "Couldn't add those classes.", true);
    return;
  } finally {
    saveBtn.disabled = false;
  }

  setStatus(
    `Added ${selected.length} class${selected.length === 1 ? "" : "es"} to your calendar.`,
  );
  showToast(
    `Added ${selected.length} class${selected.length === 1 ? "" : "es"} to your calendar.`,
  );
  reviewSection.hidden = true;

  const earliestDate = selected.map((cls) => cls.firstDate).sort()[0];
  if (earliestDate) {
    window.jumpToCalendarDate?.(earliestDate);
  } else {
    window.renderCalendar?.();
  }
});

cancelBtn.addEventListener("click", () => {
  reviewSection.hidden = true;
  parsedClasses = [];
});
