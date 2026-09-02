import { highlightActiveTab } from "./nav.js";
import {
  getCurrentUser,
  getEntries,
  getProfile,
  saveProfile,
  todayStr,
  getWeekStart,
  getWeekTotal,
} from "./storage.js";

highlightActiveTab();

const YEAR_OF_STUDY_LABELS = {
  third_year: "3rd Year",
  honours: "Honours",
  masters: "Masters",
  phd: "PhD",
};

const profileForm = document.getElementById("profile-form");
const fullNameField = document.getElementById("fullName");
const studentNumberField = document.getElementById("studentNumber");
const emailField = document.getElementById("email");
const cellPhoneField = document.getElementById("cellPhone");
const yearOfStudyField = document.getElementById("yearOfStudy");
const payrollNumberField = document.getElementById("payrollNumber");
const hourlyRateField = document.getElementById("hourlyRate");
const headOfSchoolField = document.getElementById("headOfSchool");

const rangeFromField = document.getElementById("rangeFrom");
const rangeToField = document.getElementById("rangeTo");
const printBtn = document.getElementById("printBtn");
const submitWeekStartField = document.getElementById("submitWeekStart");
const submitTimesheetBtn = document.getElementById("submitTimesheetBtn");
const submitWeekHint = document.getElementById("submitWeekHint");
const timesheetHint = document.getElementById("timesheet-hint");
const claimWrapper = document.getElementById("claimWrapper");
const claimRowsEl = document.getElementById("claimRows");
const submissionsTableBody = document.getElementById("submissionsTableBody");
const submissionsEmptyEl = document.getElementById("submissionsEmpty");

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function toDisplayDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function formatDuration(hours) {
  const n = Number(hours);
  return `${n}${n === 1 ? "hr" : "hrs"}`;
}

function formatCurrency(amount) {
  const rounded = Math.round(amount * 100) / 100;
  return `R${rounded % 1 === 0 ? rounded : rounded.toFixed(2)}`;
}

function loadProfileIntoForm() {
  const profile = getProfile();
  if (!profile) return;
  fullNameField.value = profile.fullName || "";
  studentNumberField.value = profile.studentNumber || "";
  emailField.value = profile.email || "";
  cellPhoneField.value = profile.cellPhone || "";
  yearOfStudyField.value = profile.yearOfStudy || "third_year";
  payrollNumberField.value = profile.payrollNumber || "";
  hourlyRateField.value = profile.hourlyRate != null ? profile.hourlyRate : "";
  headOfSchoolField.value = profile.headOfSchool || "";
}

function safeRenderClaim() {
  renderClaim().catch((err) => console.error("Failed to render claim:", err));
}

profileForm.addEventListener("submit", (event) => {
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
  safeRenderClaim();
});

function defaultRange() {
  const today = todayStr();
  const [y, m] = today.split("-");
  return { from: `${y}-${m}-01`, to: today };
}

async function renderClaim() {
  const profile = getProfile();
  const hasProfile = !!(
    profile &&
    profile.fullName &&
    profile.studentNumber &&
    profile.email
  );

  timesheetHint.hidden = hasProfile;
  claimWrapper.hidden = !hasProfile;
  if (!hasProfile) return;

  document.getElementById("cYear").textContent = new Date().getFullYear();
  document.getElementById("cFullName").textContent = profile.fullName;
  document.getElementById("cStudentNo").textContent = profile.studentNumber;
  document.getElementById("cPayrollNo").textContent =
    profile.payrollNumber || "";
  document.getElementById("cEmail").textContent = profile.email;
  document.getElementById("cYearOfStudy").textContent =
    YEAR_OF_STUDY_LABELS[profile.yearOfStudy] || "";
  document.getElementById("cCellPhone").textContent = profile.cellPhone || "";
  document.getElementById("cHeadOfSchool").textContent =
    profile.headOfSchool || "";

  const from = rangeFromField.value;
  const to = rangeToField.value;
  const allEntries = await getEntries();
  const entries = allEntries.filter(
    (e) => (!from || e.date >= from) && (!to || e.date <= to),
  );

  claimRowsEl.innerHTML = "";
  let totalHours = 0;

  for (const entry of entries) {
    totalHours += Number(entry.hours);

    const tr = document.createElement("tr");
    const times =
      entry.startTime && entry.endTime
        ? `${entry.startTime}-${entry.endTime}`
        : "";
    const description = [entry.taskType, entry.subject]
      .filter(Boolean)
      .join(" – ");

    [
      toDisplayDate(entry.date),
      times,
      formatDuration(entry.hours),
      description,
      entry.supervisorName || "",
      "",
    ].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });

    claimRowsEl.appendChild(tr);
  }

  document.getElementById("cSignDate").textContent = toDisplayDate(
    to || todayStr(),
  );
  document.getElementById("cTotalHours").textContent = totalHours;
  document.getElementById("cTotalAmount").textContent = profile.hourlyRate
    ? formatCurrency(totalHours * profile.hourlyRate)
    : "";
}

async function loadSubmissions() {
  const user = getCurrentUser();
  if (!user) return;

  let rows = [];
  try {
    const res = await fetch(
      `/api/timesheets?tutorId=${encodeURIComponent(user.id)}`,
    );
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load timesheets");
  } catch (err) {
    return;
  }

  submissionsTableBody.innerHTML = "";
  submissionsEmptyEl.hidden = rows.length > 0;

  rows.forEach((sub) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${toDisplayDate(sub.week_start)}</td>
      <td>${sub.total_hours}</td>
      <td><span class="status-pill ${sub.status}">${sub.status}</span></td>
      <td>${toDisplayDate(sub.submitted_at.slice(0, 10))}</td>
    `;
    submissionsTableBody.appendChild(tr);
  });
}

async function updateSubmitWeekHint() {
  const weekStart = submitWeekStartField.value;
  if (!weekStart) {
    submitWeekHint.textContent = "";
    return;
  }
  const total = await getWeekTotal(weekStart);
  submitWeekHint.textContent = `${total} hrs logged for the week of ${toDisplayDate(weekStart)}.`;
}

submitWeekStartField.addEventListener("change", () => {
  // Snap whatever date is picked to that week's Monday.
  submitWeekStartField.value = getWeekStart(submitWeekStartField.value);
  updateSubmitWeekHint();
});

submitTimesheetBtn.addEventListener("click", async () => {
  const user = getCurrentUser();
  if (!user) {
    showToast("You need to be signed in to submit a timesheet.");
    return;
  }

  submitTimesheetBtn.disabled = true;
  try {
    const res = await fetch("/api/timesheets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tutorId: user.id,
        weekStart: submitWeekStartField.value,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't submit that timesheet.");
      return;
    }
    showToast("Timesheet submitted for approval.");
    await loadSubmissions();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  } finally {
    submitTimesheetBtn.disabled = false;
  }
});

printBtn.addEventListener("click", () => window.print());
rangeFromField.addEventListener("change", safeRenderClaim);
rangeToField.addEventListener("change", safeRenderClaim);

const { from, to } = defaultRange();
rangeFromField.value = from;
rangeToField.value = to;

submitWeekStartField.value = getWeekStart(todayStr());
updateSubmitWeekHint();

loadProfileIntoForm();
safeRenderClaim();
loadSubmissions();
