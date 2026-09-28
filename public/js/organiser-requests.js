// Super-organiser approvals queue — organiser sign-ups land here pending, and
// approving one is what grants that organiser access to their chosen course
// (the login gate that reads this back lives in routes/auth.js and
// google-callback.html). Page access is guarded by the inline
// requireRole("super_organiser") module script in organiser-requests.html.

const requestListEl = document.getElementById("requestList");
const requestsEmptyEl = document.getElementById("requestsEmpty");
const statusFilterEl = document.getElementById("statusFilter");
const statusChipsEl = document.getElementById("statusChips");

const currentUser = JSON.parse(sessionStorage.getItem("user") || "null");

let allRequests = [];

// ---------------- helpers ----------------

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// Timestamps arrive as a date ("2026-09-28") or an ISO string — show the day
// only, in the same dd/mm/yyyy form the rest of the organiser pages use.
function toDisplayDate(value) {
  if (!value) return "";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

// "COS132 — Imperative Programming", falling back to the id if the course
// row couldn't be stitched on (a request outlives its course row if the
// course was deleted after the organiser applied).
function courseLabel(row) {
  const course = row.course;
  if (!course) return `Course #${row.course_id}`;
  return `${course.course_code} — ${course.course_name}`;
}

function courseCode(row) {
  return row.course?.course_code || "their course";
}

function makeActionBtn(label, variant, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small" + (variant ? ` ${variant}` : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------------- rendering ----------------

function renderRequest(row) {
  const name = row.user?.name || "Unknown user";
  const status = (row.status || "pending").toLowerCase();
  // There's no .status-pill.denied style — "denied" reuses the rejected
  // look from timesheet review so the two queues stay visually consistent.
  const pillClass = status === "denied" ? "rejected" : status;

  const li = document.createElement("li");
  li.dataset.requestId = row.id;
  const rowEl = document.createElement("div");
  rowEl.className = "review-row";
  rowEl.innerHTML = `
    <span class="avatar">${initials(name)}</span>
    <span class="name-block">
      <span class="name">${name}</span>
      <span class="role">${row.user?.email || ""}</span>
    </span>
    <span class="stamp-row">
      <span class="stamp">${courseLabel(row)}</span>
      <span class="stamp">Requested ${toDisplayDate(row.created_at)}</span>
      ${
        status !== "pending"
          ? `<span class="stamp">Reviewed ${toDisplayDate(row.reviewed_at)}</span>`
          : ""
      }
    </span>
    <span class="status-pill ${pillClass}">${status}</span>
    <span class="applicant-actions"></span>
  `;

  const actionsEl = rowEl.querySelector(".applicant-actions");
  if (status === "pending") {
    actionsEl.appendChild(
      makeActionBtn("Approve", "approve", () =>
        reviewRequest(row, "approve", name),
      ),
    );
    actionsEl.appendChild(
      makeActionBtn("Deny", "reject", () => reviewRequest(row, "deny", name)),
    );
  }

  li.appendChild(rowEl);
  requestListEl.appendChild(li);
}

function renderFiltered() {
  requestListEl.innerHTML = "";
  const status = statusFilterEl.value;
  const visible = allRequests.filter(
    (row) => !status || (row.status || "pending").toLowerCase() === status,
  );
  requestsEmptyEl.hidden = visible.length > 0;
  visible.forEach(renderRequest);
}

// ---------------- data loading ----------------

async function loadRequests() {
  requestListEl.innerHTML = "";
  requestsEmptyEl.hidden = true;

  try {
    const reviewerId = currentUser?.id || "";
    const res = await fetch(
      `/api/organiser-requests?reviewerId=${encodeURIComponent(reviewerId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load requests");
    // The list is fetched whole and filtered client-side so the chip counts
    // always reflect every status, not just the visible filter.
    allRequests = rows;
    updateChipCounts();
    renderFiltered();
  } catch (err) {
    showToast("Couldn't load organiser requests.");
  }
}

async function reviewRequest(row, action, name) {
  try {
    const res = await fetch(`/api/organiser-requests/${row.id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewerId: currentUser?.id }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that request.");
      return;
    }
    showToast(
      action === "approve"
        ? `${name} now has access to ${courseCode(row)}`
        : `${name}'s organiser request was denied`,
    );
    await loadRequests();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

// ---------------- summary + filter chips ----------------

function syncStatusChips() {
  if (!statusChipsEl) return;
  statusChipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle(
      "is-active",
      chip.dataset.status === statusFilterEl.value,
    );
  });
}

function updateChipCounts() {
  if (!statusChipsEl) return;
  const counts = { pending: 0, approved: 0, denied: 0 };
  allRequests.forEach((row) => {
    const status = (row.status || "pending").toLowerCase();
    if (counts[status] != null) counts[status] += 1;
  });
  const labels = {
    pending: "Pending",
    approved: "Approved",
    denied: "Denied",
    "": "All",
  };
  const total = counts.pending + counts.approved + counts.denied;
  statusChipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    const status = chip.dataset.status;
    const count = status === "" ? total : counts[status] || 0;
    chip.textContent = `${labels[status]} (${count})`;
  });
}

statusChipsEl?.addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  statusFilterEl.value = chip.dataset.status;
  syncStatusChips();
  renderFiltered();
});

statusFilterEl.addEventListener("change", () => {
  syncStatusChips();
  renderFiltered();
});

// ---------------- toast ----------------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

syncStatusChips();
loadRequests();
