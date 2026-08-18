import { addScheduleClasses } from './storage.js';
import { parseTimetablePdf, parseTimetableJson } from './timetable-parser.js';

const fileInput = document.getElementById('timetable-file');
const semesterEndInput = document.getElementById('semester-end');
const parseBtn = document.getElementById('parse-timetable-btn');
const jsonInput = document.getElementById('timetable-json');
const parseJsonBtn = document.getElementById('parse-json-btn');
const statusEl = document.getElementById('timetable-status');
const reviewSection = document.getElementById('timetable-review');
const reviewBody = document.getElementById('timetable-review-body');
const saveBtn = document.getElementById('save-timetable-btn');
const cancelBtn = document.getElementById('cancel-timetable-btn');
const debugSection = document.getElementById('timetable-debug');
const debugText = document.getElementById('timetable-debug-text');

let parsedClasses = [];

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.hidden = !message;
  statusEl.classList.toggle('form-error', isError);
}

function renderReview() {
  reviewBody.innerHTML = '';
  parsedClasses.forEach((cls, index) => {
    const tr = document.createElement('tr');

    const checkTd = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    checkTd.appendChild(checkbox);
    tr.appendChild(checkTd);

    const dayTd = document.createElement('td');
    dayTd.textContent = `${cls.dayName} (from ${cls.firstDate})`;
    tr.appendChild(dayTd);

    const timeTd = document.createElement('td');
    timeTd.textContent = `${cls.startTime}-${cls.endTime}`;
    tr.appendChild(timeTd);

    const titleTd = document.createElement('td');
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = cls.title;
    titleInput.addEventListener('input', () => { cls.title = titleInput.value; });
    titleTd.appendChild(titleInput);
    tr.appendChild(titleTd);

    const venueTd = document.createElement('td');
    const venueInput = document.createElement('input');
    venueInput.type = 'text';
    venueInput.value = cls.venue;
    venueInput.addEventListener('input', () => { cls.venue = venueInput.value; });
    venueTd.appendChild(venueInput);
    tr.appendChild(venueTd);

    reviewBody.appendChild(tr);
  });
  reviewSection.hidden = false;
}

parseBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) {
    setStatus('Choose a PDF file first.', true);
    return;
  }

  reviewSection.hidden = true;
  debugSection.hidden = true;
  setStatus('Reading PDF…');

  try {
    parsedClasses = await parseTimetablePdf(file);
    if (parsedClasses.length === 0) {
      setStatus('No classes could be recognised in this PDF — you may need to add them manually.', true);
      return;
    }
    renderReview();
    setStatus(`Found ${parsedClasses.length} class${parsedClasses.length === 1 ? '' : 'es'} — check them below before adding.`);
  } catch (err) {
    setStatus(err.message || 'Could not read that PDF.', true);
    if (err.debugItems) {
      debugText.value = err.debugItems.map((it) => `[${Math.round(it.x)}, ${Math.round(it.y)}] ${it.str}`).join('\n');
      debugSection.hidden = false;
    }
  }
});

parseJsonBtn.addEventListener('click', () => {
  reviewSection.hidden = true;
  debugSection.hidden = true;

  if (!jsonInput.value.trim()) {
    setStatus('Paste some timetable JSON first.', true);
    return;
  }

  try {
    parsedClasses = parseTimetableJson(jsonInput.value);
    if (parsedClasses.length === 0) {
      setStatus('That JSON array was empty.', true);
      return;
    }
    renderReview();
    setStatus(`Loaded ${parsedClasses.length} class${parsedClasses.length === 1 ? '' : 'es'} — check them below before adding.`);
  } catch (err) {
    setStatus(err.message || 'Could not read that JSON.', true);
  }
});

saveBtn.addEventListener('click', () => {
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
    setStatus('Select at least one class to add.', true);
    return;
  }

  addScheduleClasses(
    selected.map((cls) => ({
      title: cls.title,
      dayOfWeek: cls.dayOfWeek,
      firstDate: cls.firstDate,
      endDate,
      startTime: cls.startTime,
      endTime: cls.endTime,
      venue: cls.venue,
    }))
  );

  setStatus(`Added ${selected.length} class${selected.length === 1 ? '' : 'es'} to your calendar.`);
  reviewSection.hidden = true;

  const earliestDate = selected.map((cls) => cls.firstDate).sort()[0];
  if (earliestDate) {
    window.jumpToCalendarDate?.(earliestDate);
  } else {
    window.renderCalendar?.();
  }
});

cancelBtn.addEventListener('click', () => {
  reviewSection.hidden = true;
  parsedClasses = [];
});