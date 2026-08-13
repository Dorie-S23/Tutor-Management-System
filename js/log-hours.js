import { highlightActiveTab } from './nav.js';
import {
  addEntry,
  updateEntry,
  deleteEntry,
  findDuplicateEntry,
  getWeekStart,
  addDays,
  getEntriesForWeek,
  getWeekTotal,
  todayStr,
} from './storage.js';

highlightActiveTab();

const form = document.getElementById('entry-form');
const entryIdField = document.getElementById('entry-id');
const dateField = document.getElementById('date');
const hoursField = document.getElementById('hours');
const startTimeField = document.getElementById('startTime');
const endTimeField = document.getElementById('endTime');
const taskTypeField = document.getElementById('taskType');
const subjectField = document.getElementById('subject');
const supervisorField = document.getElementById('supervisorName');
const notesField = document.getElementById('notes');
const formTitle = document.getElementById('form-title');
const submitBtn = document.getElementById('submit-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');
const prevWeekBtn = document.getElementById('prev-week-btn');
const nextWeekBtn = document.getElementById('next-week-btn');
const weekLabel = document.getElementById('week-label');
const weekTotalEl = document.getElementById('week-total');
const entriesBody = document.getElementById('entries-body');
const emptyState = document.getElementById('empty-state');
const formError = document.getElementById('form-error');

let currentWeekStart = getWeekStart(todayStr());

dateField.value = todayStr();

function formatWeekLabel(weekStart) {
  const start = new Date(weekStart);
  const end = new Date(addDays(weekStart, 6));
  const opts = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} - ${endStr}`;
}

function exitEditMode() {
  entryIdField.value = '';
  form.reset();
  dateField.value = todayStr();
  formTitle.textContent = 'Log hours';
  submitBtn.textContent = 'Add entry';
  cancelEditBtn.hidden = true;
  formError.hidden = true;
}

function enterEditMode(entry) {
  entryIdField.value = entry.id;
  dateField.value = entry.date;
  hoursField.value = entry.hours;
  startTimeField.value = entry.startTime || '';
  endTimeField.value = entry.endTime || '';
  taskTypeField.value = entry.taskType || 'Tutoring';
  subjectField.value = entry.subject;
  supervisorField.value = entry.supervisorName || '';
  notesField.value = entry.notes;
  formTitle.textContent = 'Edit entry';
  submitBtn.textContent = 'Save changes';
  cancelEditBtn.hidden = false;
  formError.hidden = true;
}

function render() {
  weekLabel.textContent = formatWeekLabel(currentWeekStart);
  weekTotalEl.textContent = getWeekTotal(currentWeekStart);

  const entries = getEntriesForWeek(currentWeekStart);
  entriesBody.innerHTML = '';
  emptyState.hidden = entries.length > 0;

  for (const entry of entries) {
    const row = document.createElement('tr');

    const cells = [entry.date, entry.hours, entry.taskType, entry.subject, entry.notes];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value || '';
      row.appendChild(td);
    }

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-link';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => enterEditMode(entry));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!confirm('Delete this entry?')) return;
      deleteEntry(entry.id);
      if (entryIdField.value === entry.id) exitEditMode();
      render();
    });

    actionsTd.append(editBtn, deleteBtn);
    row.appendChild(actionsTd);
    entriesBody.appendChild(row);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const payload = {
    date: dateField.value,
    hours: Number(hoursField.value),
    startTime: startTimeField.value,
    endTime: endTimeField.value,
    taskType: taskTypeField.value,
    subject: subjectField.value.trim(),
    supervisorName: supervisorField.value.trim(),
    notes: notesField.value.trim(),
  };

  const duplicate = findDuplicateEntry(payload, entryIdField.value || null);
  if (duplicate) {
    formError.textContent = 'An identical entry (same date, hours, task type and course code) is already logged.';
    formError.hidden = false;
    return;
  }
  formError.hidden = true;

  if (entryIdField.value) {
    updateEntry(entryIdField.value, payload);
  } else {
    addEntry(payload);
  }

  currentWeekStart = getWeekStart(payload.date);
  exitEditMode();
  render();
});

cancelEditBtn.addEventListener('click', exitEditMode);

prevWeekBtn.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  render();
});

nextWeekBtn.addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  render();
});

render();
