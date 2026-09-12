const ACADEMIC_LEVEL_LABELS = {
  third_year: "3rd year",
  honours: "Honours",
  masters: "Masters",
  phd: "PhD",
};

// Default hourly rates (ZAR) per academic level — used as seed values for
// the settings card when no tutors exist yet. Once tutors are in the
// database, their actual hourly_rate is the source of truth.
const DEFAULT_RATES = {
  third_year: 120,
  honours: 150,
  masters: 170,
  phd: 200,
};

// Build a { level: rate } map from the tutors currently loaded from the DB.
// Falls back to DEFAULT_RATES for levels with no tutors yet.
function extractRatesFromTutors(tutors) {
  const rates = { ...DEFAULT_RATES };
  tutors.forEach((t) => {
    if (t.academic_level && t.hourly_rate != null) {
      rates[t.academic_level] = t.hourly_rate;
    }
  });
  return rates;
}

// ── Form validation ──────────────────────────────────────────
const VALID_LEVELS = Object.keys(ACADEMIC_LEVEL_LABELS);
const WITS_EMAIL_RE = /@(wits\.ac\.za|students\.wits\.ac\.za)$/i;
const STUDENT_NUM_RE = /^\d{5,10}$/;

function validateForm({ name, student_number, email, academic_level }) {
  const errors = [];

  if (!name) errors.push("Name is required.");
  else if (name.length < 2) errors.push("Name must be at least 2 characters.");

  if (!student_number) errors.push("Student number is required.");
  else if (!STUDENT_NUM_RE.test(student_number))
    errors.push("Student number must be 5–10 digits.");

  if (!email) errors.push("Email is required to create a tutor account.");
  else if (!WITS_EMAIL_RE.test(email))
    errors.push("Email must end with @wits.ac.za or @students.wits.ac.za.");

  if (!academic_level) errors.push("Please select an academic level.");
  else if (!VALID_LEVELS.includes(academic_level))
    errors.push("Invalid academic level.");

  return errors;
}

const GLOBAL_CAP_KEY = "tms_global_weekly_cap";
const DEFAULT_CAP = 6;

function getGlobalCap() {
  const stored = localStorage.getItem(GLOBAL_CAP_KEY);
  return stored != null ? Number(stored) : DEFAULT_CAP;
}

function setGlobalCap(value) {
  localStorage.setItem(GLOBAL_CAP_KEY, String(value));
}

// DOM refs
const form = document.getElementById("tutorForm");
const tutorIdEl = document.getElementById("tutorId");
const nameEl = document.getElementById("name");
const studentNumberEl = document.getElementById("studentNumber");
const emailEl = document.getElementById("email");
const academicLevelEl = document.getElementById("academicLevel");
const submitBtn = document.getElementById("submitBtn");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const tableBody = document.getElementById("tutorsTableBody");
const emptyCopyEl = document.getElementById("emptyCopy");
const workloadListEl = document.getElementById("workloadList");
const workloadEmptyEl = document.getElementById("workloadEmpty");
const globalWeeklyCapEl = document.getElementById("globalWeeklyCap");
const applyCapBtn = document.getElementById("applyCapBtn");

async function loadTutors() {
  const res = await fetch("/api/tutors");
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || "Failed to load tutors");
    return;
  }
  window.__tutorsCache = data;
  renderTutors(data);
  initRateFields(data);
}

function applyHighlight() {
  const highlightId = new URLSearchParams(window.location.search).get(
    "highlight",
  );
  if (!highlightId) return;
  const row = tableBody.querySelector(`tr[data-tutor-id="${highlightId}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("search-highlight");
  setTimeout(() => row.classList.remove("search-highlight"), 2000);
}

function renderTutors(tutors) {
  tableBody.innerHTML = "";
  emptyCopyEl.hidden = tutors.length > 0;

  tutors.forEach((tutor) => {
    const level = ACADEMIC_LEVEL_LABELS[tutor.academic_level] || "";
    const rate = tutor.hourly_rate;
    const rateLabel = rate != null ? `R${rate}/h` : "";
    const tr = document.createElement("tr");
    tr.dataset.tutorId = tutor.id;
    tr.innerHTML = `
      <td>${tutor.name || ""}</td>
      <td>${tutor.student_number || ""}</td>
      <td>${tutor.email || ""}</td>
      <td>${level}${rateLabel ? ` <span class="tutor-rate-badge">${rateLabel}</span>` : ""}</td>
      <td class="row-actions">
        <button type="button" class="btn-small btn-small-neutral" data-action="edit">Edit</button>
        <button type="button" class="btn-small" data-action="delete">Delete</button>
      </td>
    `;
    tr.querySelector('[data-action="edit"]').addEventListener("click", () =>
      startEdit(tutor),
    );
    tr.querySelector('[data-action="delete"]').addEventListener("click", () =>
      deleteTutor(tutor),
    );
    tableBody.appendChild(tr);
  });

  applyHighlight();
}

async function loadWorkload() {
  try {
    const res = await fetch("/api/tutors/workload");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load workload");
    renderWorkload(data);
  } catch (err) {
    showToast("Couldn't load the workload spread.");
  }
}

function renderWorkload(tutors) {
  workloadListEl.innerHTML = "";
  workloadEmptyEl.hidden = tutors.length > 0;

  const cap = getGlobalCap();

  // Busiest tutor first, so overloaded people surface at the top.
  const sorted = [...tutors].sort((a, b) => b.assignedHours - a.assignedHours);

  sorted.forEach((tutor) => {
    const row = document.createElement("div");
    row.className = "workload-row";

    const ratio = cap > 0 ? tutor.assignedHours / cap : 0;
    const percent = Math.min(100, ratio * 100);
    let fillClass = "";
    if (ratio > 1) fillClass = "blocked";
    else if (ratio >= 0.8) fillClass = "warn";
    const pctText = `${Math.round(ratio * 100)}%`;
    const hoursLabel = `${tutor.assignedHours} / ${cap} hrs`;

    row.innerHTML = `
      <span class="workload-name">${tutor.name || "Unnamed tutor"}</span>
      <span class="workload-bar-track">
        <span class="workload-bar-fill ${fillClass}" style="width: ${percent}%"></span>
      </span>
      <span class="workload-hours"><strong>${pctText}</strong> ${hoursLabel}</span>
    `;
    row.title = tutor.courses.length
      ? tutor.courses
          .map((c) => `${c.course_code} (${c.hours_per_week}h)`)
          .join(", ")
      : "No approved courses";
    workloadListEl.appendChild(row);
  });
}

function startEdit(tutor) {
  tutorIdEl.value = tutor.id;
  nameEl.value = tutor.name || "";
  studentNumberEl.value = tutor.student_number || "";
  emailEl.value = tutor.email || "";
  academicLevelEl.value = tutor.academic_level || "";
  submitBtn.textContent = "Save changes";
  cancelEditBtn.hidden = false;
  nameEl.focus();
}

function resetForm() {
  form.reset();
  tutorIdEl.value = "";
  submitBtn.textContent = "Add tutor";
  cancelEditBtn.hidden = true;
}

async function deleteTutor(tutor) {
  if (!confirm(`Delete ${tutor.name || "this tutor"}?`)) return;
  const res = await fetch(`/api/tutors/${tutor.id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    showToast(data.error || "Failed to delete tutor");
    return;
  }
  showToast(`Removed ${tutor.name || "tutor"}`);
  loadTutors();
  loadWorkload();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const nameVal = nameEl.value.trim();
  const studentNumVal = studentNumberEl.value.trim();
  const emailVal = emailEl.value.trim();
  const level = academicLevelEl.value || null;

  // Run client-side validation (skip when editing — email/auth already exists)
  const isEditing = !!tutorIdEl.value;
  if (!isEditing) {
    const errors = validateForm({
      name: nameVal,
      student_number: studentNumVal,
      email: emailVal,
      academic_level: level,
    });
    if (errors.length) {
      errors.forEach((e) => showToast(e));
      return;
    }
  }

  const rates = extractRatesFromTutors(window.__tutorsCache || []);
  const payload = {
    name: nameVal,
    student_number: studentNumVal,
    email: emailVal || null,
    academic_level: level,
    weekly_hour_cap: getGlobalCap(),
    hourly_rate: level ? (rates[level] ?? null) : null,
  };

  const id = tutorIdEl.value;
  const url = id ? `/api/tutors/${id}` : "/api/tutors";
  const method = id ? "PUT" : "POST";

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  if (!res.ok) {
    showToast(data.error || "Failed to save tutor");
    return;
  }

  showToast(id ? `Updated ${data.name}` : `Added ${data.name}`);
  resetForm();
  loadTutors();
  loadWorkload();
});

cancelEditBtn.addEventListener("click", resetForm);

// ── Global weekly cap ──────────────────────────────────────────────────
function initCapField() {
  globalWeeklyCapEl.value = getGlobalCap();
}

applyCapBtn.addEventListener("click", async () => {
  const value = Number(globalWeeklyCapEl.value);
  if (!Number.isFinite(value) || value < 0) {
    showToast("Enter a valid number of hours.");
    return;
  }
  if (value > 6) {
    showToast("Weekly cap cannot exceed 6 hours.");
    globalWeeklyCapEl.value = 6;
    return;
  }
  setGlobalCap(value);
  applyCapBtn.disabled = true;
  applyCapBtn.textContent = "Saving...";
  try {
    const res = await fetch("/api/tutors/bulk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekly_hour_cap: value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Bulk update failed");
    showToast(`Updated weekly cap to ${value} hrs for ${data.updated} tutors.`);
    loadTutors();
    loadWorkload();
  } catch (err) {
    showToast(err.message || "Failed to apply cap.");
  } finally {
    applyCapBtn.disabled = false;
    applyCapBtn.textContent = "Apply to all";
  }
});

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ── Role rates (editable) ────────────────────────────────────────────
function initRateFields(tutors) {
  const rates = tutors ? extractRatesFromTutors(tutors) : { ...DEFAULT_RATES };
  document.querySelectorAll(".rate-input").forEach((input) => {
    const level = input.dataset.level;
    if (rates[level] != null) input.value = rates[level];
  });
}

document.getElementById("saveRatesBtn").addEventListener("click", async () => {
  const rates = {};
  document.querySelectorAll(".rate-input").forEach((input) => {
    const level = input.dataset.level;
    const val = Number(input.value);
    rates[level] = Number.isFinite(val) && val >= 0 ? val : 0;
  });

  const btn = document.getElementById("saveRatesBtn");
  btn.disabled = true;
  btn.textContent = "Saving\u2026";
  try {
    const res = await fetch("/api/tutors/bulk-rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rates }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save rates");
    showToast(
      `Rates saved — updated ${data.updated} tutor${data.updated !== 1 ? "s" : ""}.`,
    );
    loadTutors();
  } catch (err) {
    showToast(err.message || "Failed to save rates.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save rates";
  }
});

// Boot
initCapField();
initRateFields();
loadTutors();
loadWorkload();
