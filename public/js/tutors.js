const ACADEMIC_LEVEL_LABELS = {
  third_year: "3rd year",
  honours: "Honours",
  masters: "Masters",
  phd: "PhD",
};

const form = document.getElementById("tutorForm");
const tutorIdEl = document.getElementById("tutorId");
const nameEl = document.getElementById("name");
const studentNumberEl = document.getElementById("studentNumber");
const emailEl = document.getElementById("email");
const academicLevelEl = document.getElementById("academicLevel");
const hourlyRateEl = document.getElementById("hourlyRate");
const weeklyHourCapEl = document.getElementById("weeklyHourCap");
const submitBtn = document.getElementById("submitBtn");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const tableBody = document.getElementById("tutorsTableBody");
const emptyCopyEl = document.getElementById("emptyCopy");

async function loadTutors() {
  const res = await fetch("/api/tutors");
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || "Failed to load tutors");
    return;
  }
  renderTutors(data);
}

function renderTutors(tutors) {
  tableBody.innerHTML = "";
  emptyCopyEl.hidden = tutors.length > 0;

  tutors.forEach((tutor) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${tutor.name || ""}</td>
      <td>${tutor.student_number || ""}</td>
      <td>${tutor.email || ""}</td>
      <td>${ACADEMIC_LEVEL_LABELS[tutor.academic_level] || ""}</td>
      <td>${tutor.hourly_rate != null ? tutor.hourly_rate : ""}</td>
      <td>${tutor.weekly_hour_cap != null ? `${tutor.weekly_hour_cap} hrs` : ""}</td>
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
}

function startEdit(tutor) {
  tutorIdEl.value = tutor.id;
  nameEl.value = tutor.name || "";
  studentNumberEl.value = tutor.student_number || "";
  emailEl.value = tutor.email || "";
  academicLevelEl.value = tutor.academic_level || "";
  hourlyRateEl.value = tutor.hourly_rate != null ? tutor.hourly_rate : "";
  weeklyHourCapEl.value =
    tutor.weekly_hour_cap != null ? tutor.weekly_hour_cap : "";
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
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    name: nameEl.value.trim(),
    student_number: studentNumberEl.value.trim(),
    email: emailEl.value.trim() || null,
    academic_level: academicLevelEl.value || null,
    hourly_rate: hourlyRateEl.value ? Number(hourlyRateEl.value) : null,
    weekly_hour_cap: weeklyHourCapEl.value
      ? Number(weeklyHourCapEl.value)
      : null,
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
});

cancelEditBtn.addEventListener("click", resetForm);

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

loadTutors();
