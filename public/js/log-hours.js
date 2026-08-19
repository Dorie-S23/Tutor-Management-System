import { highlightActiveTab } from './nav.js';
import {
  getCurrentUser,
  addEntry,
  updateEntry,
  deleteEntry,
  findDuplicateEntry,
  getWeekStart,
  addDays,
  getEntriesForWeek,
  getWeekTotal,
  todayStr,
  getTimesheet,
  submitTimesheet,
  reviewTimesheet,
  getPendingTimesheets,
  isWeekLocked,
} from './storage.js';

const currentUser = getCurrentUser();
if (!currentUser) {
  window.location.href = 'login.html';
  throw new Error('Not logged in');
}

highlightActiveTab();

const form = document.getElementById('entry-form');
const entryIdField = document.getElementById('entry-id');
const dateField = document.getElementById('date');
const hoursField = document.getElementById('hours');
const startTimeField = document.getElementById('startTime');
const endTimeField = document.getElementById('endTime');
const taskTypeField = document.getElementById('taskType');
const subjectField = document.getElementById('subject');
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
const submitWeekBtn = document.getElementById('submit-week-btn');
const weekStatusEl = document.getElementById('week-status');
const weekReviewerNoteEl = document.getElementById('week-reviewer-note');
const reviewerPanelEl = document.getElementById('reviewer-panel');
const reviewerListEl = document.getElementById('reviewer-list');
const reviewerEmptyEl = document.getElementById('reviewer-empty');
const logoutLink = document.getElementById('logout-link');

const STATUS_LABELS = {
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

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
  notesField.value = entry.notes;
  formTitle.textContent = 'Edit entry';
  submitBtn.textContent = 'Save changes';
  cancelEditBtn.hidden = false;
  formError.hidden = true;
}

async function renderWeekStatus(entries) {
  const timesheet = await getTimesheet(currentWeekStart);
  const locked = await isWeekLocked(currentWeekStart);

  if (!timesheet || timesheet.status === 'rejected') {
    weekStatusEl.hidden = true;
  } else {
    weekStatusEl.hidden = false;
    weekStatusEl.textContent = STATUS_LABELS[timesheet.status];
    weekStatusEl.className = `status-pill ${timesheet.status}`;
  }

  if (timesheet && timesheet.status === 'rejected' && timesheet.reviewerNote) {
    weekReviewerNoteEl.textContent = `Rejected: ${timesheet.reviewerNote}`;
    weekReviewerNoteEl.hidden = false;
  } else {
    weekReviewerNoteEl.hidden = true;
  }

  submitWeekBtn.hidden = locked;
  submitWeekBtn.disabled = entries.length === 0;
}

async function render() {
  weekLabel.textContent = formatWeekLabel(currentWeekStart);

  const entries = await getEntriesForWeek(currentWeekStart);
  const locked = await isWeekLocked(currentWeekStart);
  weekTotalEl.textContent = entries.reduce((sum, e) => sum + Number(e.hours), 0);
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

    if (!locked) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-link';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => enterEditMode(entry));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete this entry?')) return;
        await deleteEntry(entry.id);
        if (entryIdField.value === entry.id) exitEditMode();
        await render();
      });

      actionsTd.append(editBtn, deleteBtn);
    }

    row.appendChild(actionsTd);
    entriesBody.appendChild(row);
  }

  await renderWeekStatus(entries);
  await renderReviewerPanel();
}

async function renderReviewerPanel() {
  if (currentUser.role !== 'organiser') {
    reviewerPanelEl.hidden = true;
    return;
  }
  reviewerPanelEl.hidden = false;

  const pending = await getPendingTimesheets();
  reviewerListEl.innerHTML = '';
  reviewerEmptyEl.hidden = pending.length > 0;

  for (const timesheet of pending) {
    const row = document.createElement('div');
    row.className = 'reviewer-row';

    const label = document.createElement('span');
    const total = await getWeekTotal(timesheet.weekStart);
    label.textContent = `${timesheet.userName || timesheet.userId} — week of ${formatWeekLabel(timesheet.weekStart)} — ${total} hours`;

    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'btn-primary';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', async () => {
      await reviewTimesheet(timesheet.userId, timesheet.weekStart, 'approved');
      await render();
    });

    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'btn-danger';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', async () => {
      const note = prompt('Reason for rejecting this timesheet?') || '';
      await reviewTimesheet(timesheet.userId, timesheet.weekStart, 'rejected', note);
      await render();
    });

    row.append(label, approveBtn, rejectBtn);
    reviewerListEl.appendChild(row);
  }
}

submitWeekBtn.addEventListener('click', async () => {
  await submitTimesheet(currentWeekStart);
  await render();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const payload = {
    date: dateField.value,
    hours: Number(hoursField.value),
    startTime: startTimeField.value,
    endTime: endTimeField.value,
    taskType: taskTypeField.value,
    subject: subjectField.value.trim(),
    notes: notesField.value.trim(),
  };

  if (await isWeekLocked(getWeekStart(payload.date))) {
    formError.textContent = 'That week has already been submitted and can\'t be edited until it\'s reviewed.';
    formError.hidden = false;
    return;
  }

  const duplicate = await findDuplicateEntry(payload, entryIdField.value || null);
  if (duplicate) {
    formError.textContent = 'An identical entry (same date, hours, task type and course code) is already logged.';
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

cancelEditBtn.addEventListener('click', exitEditMode);

prevWeekBtn.addEventListener('click', async () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  await render();
});

nextWeekBtn.addEventListener('click', async () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  await render();
});

if (logoutLink) {
  logoutLink.addEventListener('click', (event) => {
    event.preventDefault();
    sessionStorage.removeItem('user');
    sessionStorage.removeItem('access_token');
    window.location.href = 'login.html';
  });
}

await render();
