import { highlightActiveTab } from "./nav.js";
import {
  getCurrentUser,
  getEntries,
  getProfile,
  saveProfile,
  todayStr,
  getMonthStart,
  getMonthTotal,
  requireRole,
} from "./storage.js";
import { consumeQueryParam, scrollAndHighlight } from "./highlightTarget.js";

// This page (timesheets.html) is tutor-only — a payroll claim for hours
// tutored. Without this, any signed-in user could land here directly.
const currentUser = requireRole("tutor");
if (!currentUser) {
  throw new Error("Not authorized");
}

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

// The Profile page (profile.html) is the source of truth for the claim
// form's identity fields. When it has a value for one of them, that value
// wins over any locally saved copy and the field locks here — the only way
// to change it is on the Profile page. The remaining fields (year of
// study, payroll number, hourly rate, head of school) exist only on this
// page and stay editable.
let accountProfile = null;

const PROFILE_SYNCED_FIELDS = [
  ["name", fullNameField],
  ["studentNumber", studentNumberField],
  ["email", emailField],
  ["cellPhone", cellPhoneField],
];

// The details the claim renders from: the locally saved profile, with any
// Profile-page values layered over it.
function profileDetails() {
  const local = getProfile() || {};
  const account = accountProfile || {};
  return {
    ...local,
    fullName: account.name || local.fullName || "",
    studentNumber: account.studentNumber || local.studentNumber || "",
    email: account.email || local.email || "",
    cellPhone: account.cellPhone || local.cellPhone || "",
  };
}

async function loadAccountProfile() {
  try {
    const res = await fetch(
      `/api/profile/${encodeURIComponent(currentUser.id)}`,
    );
    if (!res.ok) return; // no profile on record — local-only details stand
    accountProfile = await res.json();
  } catch {
    // Offline or erroring API — the locally saved details still work.
  }
}

// Locks each synced field the Profile page has a value for, and surfaces
// the hint explaining where to change them.
function applyProfileLocks() {
  let locked = 0;
  for (const [key, field] of PROFILE_SYNCED_FIELDS) {
    const value = accountProfile?.[key];
    if (typeof value === "string" && value.trim() !== "") {
      field.readOnly = true;
      field.title = "From your Profile page — change it there.";
      locked += 1;
    } else {
      field.readOnly = false;
      field.removeAttribute("title");
    }
  }
  document.getElementById("details-sync-hint").hidden = locked === 0;
}

const rangeFromField = document.getElementById("rangeFrom");
const rangeToField = document.getElementById("rangeTo");
const printBtn = document.getElementById("printBtn");
const submitMonthField = document.getElementById("submitMonth");
const submitTimesheetBtn = document.getElementById("submitTimesheetBtn");
const submitMonthHint = document.getElementById("submitMonthHint");
const timesheetHint = document.getElementById("timesheet-hint");
const claimWrapper = document.getElementById("claimWrapper");
const claimRowsEl = document.getElementById("claimRows");
const submissionsListEl = document.getElementById("submissionsList");
const submissionsEmptyEl = document.getElementById("submissionsEmpty");

const disputeModal = document.getElementById("disputeModal");
const disputeForm = document.getElementById("disputeForm");
const disputeFormError = document.getElementById("disputeFormError");
const disputeModalContext = document.getElementById("disputeModalContext");
const disputeMessageInput = document.getElementById("disputeMessageInput");
const disputeSubmitBtn = document.getElementById("disputeSubmitBtn");

// This tutor's most recent dispute per submitted month, keyed by weekStart
// (the stored period key, "YYYY-MM-01") — only need the latest one to know
// whether "Dispute" or a status badge shows.
let latestDisputeByWeek = new Map();
let pendingDispute = null; // { weekStart } for whichever row opened the modal

let toastTimer = null;
function showToast(message, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.remove("toast--success", "toast--danger");
  el.classList.add(`toast--${type}`, "show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function toDisplayDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

// "September 2026" — the calendar month one submission covers.
function formatMonthLabel(monthStart) {
  const date = new Date(`${monthStart}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
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
  const profile = profileDetails();
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
  showToast("Profile details saved.");
});

function defaultRange() {
  const today = todayStr();
  const [y, m] = today.split("-");
  return { from: `${y}-${m}-01`, to: today };
}

async function renderClaim() {
  const profile = profileDetails();
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

async function loadDisputes(userId) {
  try {
    const res = await fetch(
      `/api/timesheet-disputes?raisedBy=${encodeURIComponent(userId)}`,
    );
    const disputes = await res.json();
    if (!res.ok) throw new Error(disputes.error);

    // The API orders newest-first, so the first one seen per month is the latest.
    latestDisputeByWeek = new Map();
    disputes.forEach((d) => {
      if (!latestDisputeByWeek.has(d.timesheet_week_start)) {
        latestDisputeByWeek.set(d.timesheet_week_start, d);
      }
    });
  } catch {
    latestDisputeByWeek = new Map();
  }
}

function renderDisputeCell(sub) {
  if (sub.status === "pending") return "";

  const dispute = latestDisputeByWeek.get(sub.week_start);
  if (dispute && !dispute.resolved) {
    return `<span class="status-pill disputed">Disputed</span>`;
  }

  const label = dispute ? "Dispute again" : "Dispute";
  return `<button type="button" class="btn-link" data-action="dispute" data-week="${sub.week_start}">${label}</button>`;
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
  } catch {
    return;
  }

  await loadDisputes(user.id);

  submissionsListEl.innerHTML = "";
  submissionsEmptyEl.hidden = rows.length > 0;

  rows.forEach((sub) => {
    const status = (sub.status || "pending").toLowerCase();
    const dispute = latestDisputeByWeek.get(sub.week_start);
    const disputed = dispute && !dispute.resolved;
    const note = disputed
      ? "Disputed — please review and resubmit."
      : sub.reviewer_note || "";

    const row = document.createElement("div");
    row.className = "ts-row";
    row.dataset.weekStart = sub.week_start;
    row.innerHTML = `
      <div>
        <p class="ts-row__week">${formatMonthLabel(sub.week_start)}</p>
        ${note ? `<p class="ts-row__dispute">${note}</p>` : ""}
      </div>
      <span class="status-pill ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
      <div class="ts-row__right">
        <p class="ts-row__hours">${Number(sub.total_hours)}h</p>
        <p class="ts-row__date">${sub.submitted_at.slice(0, 10)}</p>
      </div>
      <div class="ts-row__action">${renderDisputeCell(sub)}</div>
    `;
    submissionsListEl.appendChild(row);
  });
}

async function updateSubmitMonthHint() {
  const monthValue = submitMonthField.value; // "YYYY-MM"
  if (!monthValue) {
    submitMonthHint.textContent = "";
    return;
  }
  const monthStart = getMonthStart(monthValue);
  const total = await getMonthTotal(monthStart);
  submitMonthHint.textContent = `${total} hrs logged for ${formatMonthLabel(monthStart)}.`;
}

submitMonthField.addEventListener("change", updateSubmitMonthHint);

submitTimesheetBtn.addEventListener("click", async () => {
  const user = getCurrentUser();
  if (!user) {
    showToast("You need to be signed in to submit a timesheet.", "danger");
    return;
  }
  if (!submitMonthField.value) {
    showToast("Pick a month to submit.", "danger");
    return;
  }

  submitTimesheetBtn.disabled = true;
  try {
    const res = await fetch("/api/timesheets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tutorId: user.id,
        // The picker gives "YYYY-MM"; the server wants a date in the month.
        weekStart: getMonthStart(submitMonthField.value),
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't submit that timesheet.", "danger");
      return;
    }
    showToast("Timesheet submitted for approval.");
    await loadSubmissions();
  } catch {
    showToast("Network error — couldn't reach the server.", "danger");
  } finally {
    submitTimesheetBtn.disabled = false;
  }
});

function openDisputeModal(weekStart) {
  pendingDispute = { weekStart };
  disputeForm.reset();
  disputeFormError.hidden = true;
  disputeModalContext.textContent = `Raising a dispute about ${formatMonthLabel(weekStart)}.`;
  disputeModal.showModal();
  disputeMessageInput.focus();
}

function closeDisputeModal() {
  disputeModal.close();
  pendingDispute = null;
}

document
  .getElementById("disputeModalCloseBtn")
  .addEventListener("click", closeDisputeModal);
document
  .getElementById("disputeCancelBtn")
  .addEventListener("click", closeDisputeModal);
disputeModal.addEventListener("click", (e) => {
  if (e.target === disputeModal) closeDisputeModal();
});

submissionsListEl.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="dispute"]');
  if (btn) openDisputeModal(btn.dataset.week);
});

disputeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  disputeFormError.hidden = true;
  if (!pendingDispute) return;

  const user = getCurrentUser();
  const message = disputeMessageInput.value.trim();

  disputeSubmitBtn.disabled = true;
  try {
    const res = await fetch("/api/timesheet-disputes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timesheetUserId: user.id,
        timesheetWeekStart: pendingDispute.weekStart,
        raisedBy: user.id,
        message,
      }),
    });
    const body = await res.json();

    if (!res.ok) {
      disputeFormError.textContent =
        body.error || "Couldn't submit that dispute.";
      disputeFormError.hidden = false;
      return;
    }

    closeDisputeModal();
    showToast("Dispute submitted.");
    await loadSubmissions();
  } catch {
    disputeFormError.textContent = "Network error — couldn't reach the server.";
    disputeFormError.hidden = false;
  } finally {
    disputeSubmitBtn.disabled = false;
  }
});

printBtn.addEventListener("click", () => window.print());
rangeFromField.addEventListener("change", safeRenderClaim);
rangeToField.addEventListener("change", safeRenderClaim);

// The head's "New timesheet" button points at the submit tool below.
document.getElementById("new-timesheet-btn").addEventListener("click", () => {
  submitMonthField.focus({ preventScroll: true });
  submitMonthField.scrollIntoView({ behavior: "smooth", block: "center" });
});

const { from, to } = defaultRange();
rangeFromField.value = from;
rangeToField.value = to;

// Pre-select the current calendar month.
submitMonthField.value = todayStr().slice(0, 7);
updateSubmitMonthHint();

(async () => {
  // Profile-page values land before the first render so the claim never
  // briefly shows stale locally saved identity fields.
  await loadAccountProfile();
  loadProfileIntoForm();
  applyProfileLocks();
  safeRenderClaim();

  await loadSubmissions();

  // Arriving from a "timesheet reviewed" or "timesheet due" notification —
  // scroll to and flash the month it was about.
  const highlightWeek = consumeQueryParam("highlightWeek");
  if (highlightWeek) {
    scrollAndHighlight(
      submissionsListEl.querySelector(
        `[data-week-start="${CSS.escape(highlightWeek)}"]`,
      ),
    );
  }
})();
