import { highlightActiveTab } from "./nav.js";
import { requireRole } from "./storage.js";

// This page (modules.html) is tutor-only — applying to tutor a module isn't
// a concept that applies to other roles.
const currentUser = requireRole("tutor");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

// ---------- apply to tutor a module ----------

const applyBtn = document.getElementById("apply-to-tutor-btn");
const applyModal = document.getElementById("apply-modal");
const applyForm = document.getElementById("apply-form");
const applyError = document.getElementById("apply-form-error");
const applySubmitBtn = document.getElementById("apply-submit-btn");
const courseSelect = document.getElementById("apply-course-select");
const courseMeta = document.getElementById("apply-course-meta");
const yearSelect = document.getElementById("apply-year-select");
const markInput = document.getElementById("apply-mark-input");
const availabilitySelect = document.getElementById("apply-availability-select");
const availabilityLabel = document.getElementById("apply-availability-label");
const applicationsListEl = document.getElementById("applications-list");
const applicationsItemsEl = document.getElementById("applications-items");
const toastEl = document.getElementById("toast");

let COURSES = [];
let myApplications = [];
let myAcademicLevel = null;

function showToast(message, type = "success") {
  toastEl.textContent = message;
  toastEl.classList.remove("toast--success", "toast--danger");
  toastEl.classList.add(`toast--${type}`, "show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

// Replaces the browser's native confirm() with an in-app dialog matching the
// rest of the UI, since the native one can't be styled at all. Resolves true
// on "Confirm", false on "Cancel" or Escape/backdrop dismissal.
const confirmModal = document.getElementById("confirm-modal");
const confirmModalMessage = document.getElementById("confirm-modal-message");
const confirmModalConfirmBtn = document.getElementById(
  "confirm-modal-confirm-btn",
);
const confirmModalCancelBtn = document.getElementById(
  "confirm-modal-cancel-btn",
);

function showConfirm(message, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    confirmModalMessage.textContent = message;
    confirmModalConfirmBtn.textContent = confirmLabel;
    confirmModal.showModal();

    function settle(result) {
      confirmModal.close();
      confirmModalConfirmBtn.removeEventListener("click", onConfirm);
      confirmModalCancelBtn.removeEventListener("click", onCancel);
      confirmModal.removeEventListener("cancel", onCancel);
      resolve(result);
    }
    function onConfirm() {
      settle(true);
    }
    function onCancel() {
      settle(false);
    }

    confirmModalConfirmBtn.addEventListener("click", onConfirm);
    confirmModalCancelBtn.addEventListener("click", onCancel);
    confirmModal.addEventListener("cancel", onCancel); // Escape key
  });
}

function formatSession(course) {
  if (!course.Day_of_tut || !course.tutor_start_time || !course.tutor_end_time)
    return null;
  return `${course.Day_of_tut} · ${course.tutor_start_time.slice(0, 5)}–${course.tutor_end_time.slice(0, 5)}`;
}

async function fetchCourses() {
  try {
    const res = await fetch("/api/courses");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load modules");
    COURSES = rows;
  } catch {
    showToast("Couldn't load modules from the database.", "danger");
    COURSES = [];
  }
}

async function fetchMyAcademicLevel(tutorId) {
  try {
    const res = await fetch(`/api/tutors/${encodeURIComponent(tutorId)}`);
    const row = await res.json();
    if (!res.ok) throw new Error(row.error || "Failed to load tutor record");
    myAcademicLevel = row.academic_level || null;
  } catch {
    myAcademicLevel = null;
  }
}

async function fetchMyApplications(tutorId) {
  try {
    const res = await fetch(
      `/api/tutor-applications?tutorId=${encodeURIComponent(tutorId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load applications");
    myApplications = rows;
  } catch {
    myApplications = [];
  }
  renderApplicationsList();
}

function renderApplicationsList() {
  if (myApplications.length === 0) {
    applicationsListEl.hidden = true;
    return;
  }
  applicationsListEl.hidden = false;
  applicationsItemsEl.innerHTML = "";

  myApplications.forEach((app) => {
    const li = document.createElement("li");
    li.className = "application-row";
    const course = app.courses;
    const status = (app.status || "pending").toLowerCase();
    const label = course
      ? `${course.course_code} — ${course.course_name}`
      : "Module application";
    li.innerHTML = `
      <span>${label}</span>
      <span class="status-pill ${status}">${status}</span>
      ${
        status === "rejected" && app.rejection_reason
          ? `<p class="hint">Reason: ${app.rejection_reason}</p>`
          : ""
      }
      ${
        status === "approved" && app.approval_reason
          ? `<p class="hint">Note: ${app.approval_reason}</p>`
          : ""
      }
    `;

    if (status === "rejected") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn-link";
      removeBtn.textContent = "Remove & apply again";
      removeBtn.addEventListener("click", async () => {
        if (
          !confirm(
            `Remove this application for ${label}? You'll be able to apply again.`,
          )
        )
          return;

        removeBtn.disabled = true;
        try {
          const res = await fetch(`/api/tutor-applications/${app.id}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast(body.error || "Couldn't remove that application.");
            removeBtn.disabled = false;
            return;
          }
          showToast("Application removed.");
          await fetchMyApplications(currentUser.id);
        } catch {
          showToast("Network error — couldn't reach the server.");
          removeBtn.disabled = false;
        }
      });
      li.appendChild(removeBtn);
      applicationsItemsEl.appendChild(li);
      return;
    }

    if (status !== "pending") {
      applicationsItemsEl.appendChild(li);
      return;
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-danger";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      if (
        !(await showConfirm(
          `Cancel your application for ${label}?`,
          "Cancel application",
        ))
      )
        return;

      cancelBtn.disabled = true;
      try {
        const res = await fetch(`/api/tutor-applications/${app.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showToast(
            body.error || "Couldn't cancel that application.",
            "danger",
          );
          cancelBtn.disabled = false;
          return;
        }
        showToast("Application cancelled.", "danger");
        await fetchMyApplications(currentUser.id);
      } catch {
        showToast("Network error — couldn't reach the server.", "danger");
        cancelBtn.disabled = false;
      }
    });

    li.appendChild(cancelBtn);
    applicationsItemsEl.appendChild(li);
  });
}

function populateCourseSelect() {
  const appliedCourseIds = new Set(myApplications.map((a) => a.course_id));

  courseSelect.innerHTML =
    '<option value="" disabled selected>Choose a module&hellip;</option>';
  COURSES.forEach((course) => {
    const option = document.createElement("option");
    option.value = course.id;
    option.textContent = `${course.course_code} — ${course.course_name}`;
    if (appliedCourseIds.has(course.id)) {
      option.textContent += " (already applied)";
      option.disabled = true;
    }
    courseSelect.appendChild(option);
  });
}

function updateCourseMeta() {
  const course = COURSES.find((c) => String(c.id) === courseSelect.value);
  if (!course) {
    courseMeta.hidden = true;
    availabilityLabel.textContent = "Are you free at the tutorial time?";
    return;
  }

  const session = formatSession(course);
  courseMeta.hidden = false;
  courseMeta.textContent = session
    ? `Requires a mark of ${course.min_mark}+ · tutorial is ${session}`
    : `Requires a mark of ${course.min_mark}+ · tutorial day/time not yet set`;

  availabilityLabel.textContent = session
    ? `Are you free on ${session}?`
    : "Are you free at the tutorial time?";
}

function openApplyModal() {
  applyForm.reset();
  applyError.hidden = true;
  populateCourseSelect();
  updateCourseMeta();
  if (myAcademicLevel) yearSelect.value = myAcademicLevel;
  applyModal.showModal();
}

function closeApplyModal() {
  applyModal.close();
}

applyBtn?.addEventListener("click", openApplyModal);
document
  .getElementById("apply-modal-close-btn")
  ?.addEventListener("click", closeApplyModal);
document
  .getElementById("apply-cancel-btn")
  ?.addEventListener("click", closeApplyModal);
applyModal?.addEventListener("click", (e) => {
  if (e.target === applyModal) closeApplyModal();
});
courseSelect?.addEventListener("change", updateCourseMeta);

applyForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  applyError.hidden = true;

  const payload = {
    tutorId: currentUser.id,
    courseId: Number(courseSelect.value),
    academicLevel: yearSelect.value,
    mark: Number(markInput.value),
    availability: availabilitySelect.value === "true",
  };

  applySubmitBtn.disabled = true;
  applySubmitBtn.textContent = "Submitting…";

  try {
    const res = await fetch("/api/tutor-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    if (!res.ok) {
      applyError.textContent =
        body.error || "Couldn't submit that application.";
      applyError.hidden = false;
      return;
    }

    closeApplyModal();
    showToast("Application submitted!");
    myAcademicLevel = payload.academicLevel;
    await fetchMyApplications(currentUser.id);
  } catch {
    applyError.textContent = "Network error — couldn't reach the server.";
    applyError.hidden = false;
  } finally {
    applySubmitBtn.disabled = false;
    applySubmitBtn.textContent = "Submit application";
  }
});

(async function init() {
  await fetchCourses();
  await fetchMyAcademicLevel(currentUser.id);
  await fetchMyApplications(currentUser.id);
})();
