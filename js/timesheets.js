import { highlightActiveTab } from './nav.js';
import { getEntries, getProfile, saveProfile, todayStr } from './storage.js';

highlightActiveTab();

const YEAR_OF_STUDY_LABELS = {
  third_year: '3rd Year',
  honours: 'Honours',
  masters: 'Masters',
  phd: 'PhD',
};

const profileForm = document.getElementById('profile-form');
const fullNameField = document.getElementById('fullName');
const studentNumberField = document.getElementById('studentNumber');
const emailField = document.getElementById('email');
const cellPhoneField = document.getElementById('cellPhone');
const yearOfStudyField = document.getElementById('yearOfStudy');
const payrollNumberField = document.getElementById('payrollNumber');
const hourlyRateField = document.getElementById('hourlyRate');
const headOfSchoolField = document.getElementById('headOfSchool');

const rangeFromField = document.getElementById('rangeFrom');
const rangeToField = document.getElementById('rangeTo');
const printBtn = document.getElementById('printBtn');
const timesheetHint = document.getElementById('timesheet-hint');
const claimWrapper = document.getElementById('claimWrapper');
const claimRowsEl = document.getElementById('claimRows');

function toDisplayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function formatDuration(hours) {
  const n = Number(hours);
  return `${n}${n === 1 ? 'hr' : 'hrs'}`;
}

function formatCurrency(amount) {
  const rounded = Math.round(amount * 100) / 100;
  return `R${rounded % 1 === 0 ? rounded : rounded.toFixed(2)}`;
}

function loadProfileIntoForm() {
  const profile = getProfile();
  if (!profile) return;
  fullNameField.value = profile.fullName || '';
  studentNumberField.value = profile.studentNumber || '';
  emailField.value = profile.email || '';
  cellPhoneField.value = profile.cellPhone || '';
  yearOfStudyField.value = profile.yearOfStudy || 'third_year';
  payrollNumberField.value = profile.payrollNumber || '';
  hourlyRateField.value = profile.hourlyRate != null ? profile.hourlyRate : '';
  headOfSchoolField.value = profile.headOfSchool || '';
}

profileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveProfile({
    fullName: fullNameField.value.trim(),
    studentNumber: studentNumberField.value.trim(),
    email: emailField.value.trim(),
    cellPhone: cellPhoneField.value.trim(),
    yearOfStudy: yearOfStudyField.value,
    payrollNumber: payrollNumberField.value.trim(),
    hourlyRate: hourlyRateField.value ? Number(hourlyRateField.value) : null,
    headOfSchool: headOfSchoolField.value.trim(),
  });
  renderClaim();
});

function defaultRange() {
  const today = todayStr();
  const [y, m] = today.split('-');
  return { from: `${y}-${m}-01`, to: today };
}

function renderClaim() {
  const profile = getProfile();
  const hasProfile = !!(profile && profile.fullName && profile.studentNumber && profile.email);

  timesheetHint.hidden = hasProfile;
  claimWrapper.hidden = !hasProfile;
  if (!hasProfile) return;

  document.getElementById('cYear').textContent = new Date().getFullYear();
  document.getElementById('cFullName').textContent = profile.fullName;
  document.getElementById('cStudentNo').textContent = profile.studentNumber;
  document.getElementById('cPayrollNo').textContent = profile.payrollNumber || '';
  document.getElementById('cEmail').textContent = profile.email;
  document.getElementById('cYearOfStudy').textContent = YEAR_OF_STUDY_LABELS[profile.yearOfStudy] || '';
  document.getElementById('cCellPhone').textContent = profile.cellPhone || '';
  document.getElementById('cHeadOfSchool').textContent = profile.headOfSchool || '';

  const from = rangeFromField.value;
  const to = rangeToField.value;
  const entries = getEntries().filter((e) => (!from || e.date >= from) && (!to || e.date <= to));

  claimRowsEl.innerHTML = '';
  let totalHours = 0;

  for (const entry of entries) {
    totalHours += Number(entry.hours);

    const tr = document.createElement('tr');
    const times = entry.startTime && entry.endTime ? `${entry.startTime}-${entry.endTime}` : '';
    const description = [entry.taskType, entry.subject].filter(Boolean).join(' – ');

    [toDisplayDate(entry.date), times, formatDuration(entry.hours), description, entry.supervisorName || '', ''].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    });

    claimRowsEl.appendChild(tr);
  }

  document.getElementById('cSignDate').textContent = toDisplayDate(to || todayStr());
  document.getElementById('cTotalHours').textContent = totalHours;
  document.getElementById('cTotalAmount').textContent = profile.hourlyRate
    ? formatCurrency(totalHours * profile.hourlyRate)
    : '';
}

printBtn.addEventListener('click', () => window.print());
rangeFromField.addEventListener('change', renderClaim);
rangeToField.addEventListener('change', renderClaim);

const { from, to } = defaultRange();
rangeFromField.value = from;
rangeToField.value = to;

loadProfileIntoForm();
renderClaim();
