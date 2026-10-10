const submissionListEl = document.getElementById("submissionList");
const submissionsEmptyEl = document.getElementById("submissionsEmpty");
const statusFilterEl = document.getElementById("statusFilter");
const exportPayrollBtn = document.getElementById("exportPayrollBtn");
const statusChipsEl = document.getElementById("statusChips");
const reviewPendingBtn = document.getElementById("reviewPendingBtn");
const viewDisputesBtn = document.getElementById("viewDisputesBtn");
const verifyPendingMetaEl = document.getElementById("verifyPendingMeta");
const verifyDecidedMetaEl = document.getElementById("verifyDecidedMeta");
const verifyDisputeMetaEl = document.getElementById("verifyDisputeMeta");
const verifyRejectedMetaEl = document.getElementById("verifyRejectedMeta");

// Disputes for the currently-loaded submissions, keyed by "userId_weekStart".
// Only unresolved ones are fetched — once resolved, a submission's row goes
// back to showing just its ordinary status.
let openDisputesByKey = new Map();

// Flat list of every open dispute, for the summary card's "Review disputes"
// action (the map above is keyed for per-row lookups only).
let openDisputeList = [];

function submissionKey(userId, weekStart) {
  return `${userId}_${weekStart}`;
}

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function toDisplayDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

// "September 2026" — the calendar month a submission covers (week_start
// stores the month's first day).
function formatMonthLabel(monthStart) {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function makeActionBtn(label, variant, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small" + (variant ? ` ${variant}` : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function loadOpenDisputes() {
  try {
    const res = await fetch("/api/timesheet-disputes?resolved=false");
    const disputes = await res.json();
    if (!res.ok) throw new Error(disputes.error);

    openDisputesByKey = new Map();
    openDisputeList = disputes;
    disputes.forEach((dispute) => {
      const key = submissionKey(
        dispute.timesheet_user_id,
        dispute.timesheet_week_start,
      );
      const list = openDisputesByKey.get(key) || [];
      list.push(dispute);
      openDisputesByKey.set(key, list);
    });
  } catch (err) {
    // Disputes are a secondary signal on top of the review queue — don't
    // block the page over them, just show submissions without dispute pills.
    openDisputesByKey = new Map();
    openDisputeList = [];
  }
  updateDisputeCard();
}

async function loadSubmissions() {
  submissionListEl.innerHTML = "";
  submissionsEmptyEl.hidden = true;

  let rows = [];
  try {
    const status = statusFilterEl.value;
    const res = await fetch(
      `/api/timesheets${status ? `?status=${status}` : ""}`,
    );
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load timesheets");
  } catch (err) {
    showToast("Couldn't load timesheets.");
    return;
  }

  await loadOpenDisputes();

  if (rows.length === 0) {
    submissionsEmptyEl.hidden = false;
    return;
  }

  rows.forEach((sub) => renderSubmission(sub));

  applyHighlight();
}

function applyHighlight() {
  const highlightKey = new URLSearchParams(window.location.search).get(
    "highlight",
  );
  if (!highlightKey) return;
  const row = submissionListEl.querySelector(`li[data-key="${highlightKey}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("search-highlight");
  setTimeout(() => row.classList.remove("search-highlight"), 2000);
}

function renderSubmission(sub) {
  const user = sub.users;
  const name = user?.name || "Unknown tutor";
  const status = (sub.status || "pending").toLowerCase();
  const key = submissionKey(sub.user_id, sub.week_start);
  const disputes = openDisputesByKey.get(key) || [];

  const li = document.createElement("li");
  li.dataset.key = key;
  const row = document.createElement("div");
  row.className = "review-row";
  row.innerHTML = `
    <span class="avatar">${initials(name)}</span>
    <span class="name-block">
      <span class="name">${name}</span>
      <span class="role">${user?.email || ""}</span>
    </span>
    <span class="stamp-row">
      <span class="stamp">${formatMonthLabel(sub.week_start)}</span>
      <span class="stamp">${sub.total_hours} hrs</span>
    </span>
    <span class="status-pill ${status}">${status}</span>
    ${disputes.length > 0 ? `<span class="status-pill disputed">disputed</span>` : ""}
    <span class="applicant-actions"></span>
  `;

  const actionsEl = row.querySelector(".applicant-actions");
  actionsEl.appendChild(
    makeActionBtn("Details", "btn-small-neutral", () => toggleDetail(li, sub)),
  );

  if (disputes.length > 0) {
    actionsEl.appendChild(
      makeActionBtn("View dispute", "btn-small-neutral", () =>
        openDisputeModal(disputes, name),
      ),
    );
  }

  if (status === "pending") {
    actionsEl.appendChild(
      makeActionBtn("Approve", "approve", () =>
        openReasonModal({
          title: "Approve timesheet",
          fieldLabel: "Note (optional)",
          placeholder: "Optional note for the tutor",
          required: false,
          confirmLabel: "Approve",
          onConfirm: (note) => setSubmissionStatus(sub, "approved", name, note),
        }),
      ),
    );
    actionsEl.appendChild(
      makeActionBtn("Reject", "reject", () =>
        openReasonModal({
          title: "Reject timesheet",
          fieldLabel: "Reason for rejection",
          placeholder: "e.g. Wednesday's hours don't match the logged times",
          required: true,
          confirmLabel: "Reject",
          onConfirm: (note) => setSubmissionStatus(sub, "rejected", name, note),
        }),
      ),
    );
  } else {
    actionsEl.appendChild(
      makeActionBtn("Reconsider", "", () =>
        setSubmissionStatus(sub, "pending", name),
      ),
    );
  }

  li.appendChild(row);
  if (status !== "pending" && sub.reviewer_note) {
    const noteEl = document.createElement("p");
    noteEl.className = "review-note";
    noteEl.textContent = `Note: ${sub.reviewer_note}`;
    li.appendChild(noteEl);
  }
  submissionListEl.appendChild(li);
}

// Each snapshot entry carries the attendance-verification call made on that
// session (see server/routes/attendanceVerification.js) — whoever weighs a
// timesheet should see which sessions were confirmed. Snapshots taken
// before verification existed read as Pending.
function verificationPill(status) {
  const info = {
    verified: { className: "approved", label: "Verified" },
    flagged: { className: "rejected", label: "Flagged" },
  }[status] || { className: "pending", label: "Pending" };
  return `<span class="status-pill ${info.className}">${info.label}</span>`;
}

function toggleDetail(li, sub) {
  const existing = li.querySelector(".submission-detail");
  if (existing) {
    existing.remove();
    return;
  }

  const detail = document.createElement("div");
  detail.className = "submission-detail";
  const entries = sub.entries_snapshot || [];
  detail.innerHTML = `
    <table class="tutors-table">
      <thead>
        <tr><th>Date</th><th>Hours</th><th>Task</th><th>Subject</th><th>Status</th><th>Notes</th></tr>
      </thead>
      <tbody>
        ${entries
          .map(
            (e) => `
          <tr>
            <td>${toDisplayDate(e.date)}</td>
            <td>${e.hours}</td>
            <td>${e.task_type || ""}</td>
            <td>${e.subject || ""}</td>
            <td>${verificationPill(e.verification_status)}</td>
            <td>${e.notes || ""}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  `;
  li.appendChild(detail);
}

async function setSubmissionStatus(sub, status, name, reviewerNote) {
  try {
    const res = await fetch(
      `/api/timesheets/${sub.user_id}/${sub.week_start}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reviewerNote }),
      },
    );
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that timesheet.");
      return false;
    }
    const messages = {
      approved: `${name}'s timesheet approved`,
      rejected: `${name}'s timesheet rejected`,
      pending: `${name}'s timesheet moved back to pending`,
    };
    showToast(messages[status] || "Timesheet updated.");
    await loadSubmissions();
    return true;
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    return false;
  }
}

// ---------- reason modal (approve-with-note / reject-with-reason) ----------

const reasonModal = document.getElementById("reasonModal");
const reasonForm = document.getElementById("reasonForm");
const reasonFormError = document.getElementById("reasonFormError");
const reasonModalHeading = document.getElementById("reasonModalHeading");
const reasonFieldLabel = document.getElementById("reasonFieldLabel");
const reasonInput = document.getElementById("reasonInput");
const reasonSubmitBtn = document.getElementById("reasonSubmitBtn");

let pendingReason = null; // { required, confirmLabel, onConfirm }

function openReasonModal({
  title,
  fieldLabel,
  placeholder,
  required,
  confirmLabel,
  onConfirm,
}) {
  pendingReason = { required, confirmLabel, onConfirm };
  reasonForm.reset();
  reasonFormError.hidden = true;
  reasonModalHeading.textContent = title;
  reasonFieldLabel.textContent = fieldLabel;
  reasonInput.placeholder = placeholder || "";
  reasonSubmitBtn.textContent = confirmLabel;
  reasonModal.showModal();
  reasonInput.focus();
}

function closeReasonModal() {
  reasonModal.close();
  pendingReason = null;
}

document
  .getElementById("reasonModalCloseBtn")
  .addEventListener("click", closeReasonModal);
document
  .getElementById("reasonCancelBtn")
  .addEventListener("click", closeReasonModal);
reasonModal.addEventListener("click", (e) => {
  if (e.target === reasonModal) closeReasonModal();
});

reasonForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  reasonFormError.hidden = true;
  if (!pendingReason) return;

  const note = reasonInput.value.trim();
  if (pendingReason.required && !note) {
    reasonFormError.textContent = "A reason is required.";
    reasonFormError.hidden = false;
    return;
  }

  reasonSubmitBtn.disabled = true;
  const ok = await pendingReason.onConfirm(note);
  reasonSubmitBtn.disabled = false;

  if (ok) closeReasonModal();
});

// ---------- dispute modal ----------

const disputeModal = document.getElementById("disputeModal");
const disputeModalHeading = document.getElementById("disputeModalHeading");
const disputeModalBody = document.getElementById("disputeModalBody");
const disputeResolveBtn = document.getElementById("disputeResolveBtn");

let pendingDisputes = []; // every open dispute currently shown in the modal

function openDisputeModal(disputes, fallbackName) {
  disputeModalHeading.textContent =
    disputes.length > 1 ? "Open disputes" : "Dispute";
  disputeModalBody.innerHTML = disputes
    .map(
      (d) => `
      <p class="hint">
        <strong>${d.users?.name || fallbackName}</strong> —
        ${new Date(d.created_at).toLocaleString()}
      </p>
      <p>${d.message}</p>
    `,
    )
    .join("<hr />");
  pendingDisputes = disputes;
  disputeModal.showModal();
}

function closeDisputeModal() {
  disputeModal.close();
  pendingDisputes = [];
}

document
  .getElementById("disputeModalCloseBtn")
  .addEventListener("click", closeDisputeModal);
document
  .getElementById("disputeCloseBtn")
  .addEventListener("click", closeDisputeModal);
disputeModal.addEventListener("click", (e) => {
  if (e.target === disputeModal) closeDisputeModal();
});

disputeResolveBtn.addEventListener("click", async () => {
  if (pendingDisputes.length === 0) return;

  disputeResolveBtn.disabled = true;
  try {
    const results = await Promise.all(
      pendingDisputes.map((d) =>
        fetch(`/api/timesheet-disputes/${d.id}/resolve`, { method: "PATCH" }),
      ),
    );
    if (results.some((res) => !res.ok)) {
      showToast("Couldn't resolve one or more disputes.");
      return;
    }
    showToast("Dispute marked resolved.");
    closeDisputeModal();
    await loadSubmissions();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  } finally {
    disputeResolveBtn.disabled = false;
  }
});

// ---------- review summary (verify cards + filter chips) ----------

function syncStatusChips() {
  if (!statusChipsEl) return;
  statusChipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle(
      "is-active",
      chip.dataset.status === statusFilterEl.value,
    );
  });
}

function updateChipCounts(counts) {
  if (!statusChipsEl) return;
  const labels = {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    "": "All",
  };
  const total = counts.pending + counts.approved + counts.rejected;
  statusChipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    const status = chip.dataset.status;
    const count = status === "" ? total : counts[status] || 0;
    chip.textContent = `${labels[status]} (${count})`;
  });
}

function updateDisputeCard() {
  const count = openDisputeList.length;
  if (verifyDisputeMetaEl) {
    verifyDisputeMetaEl.textContent = count
      ? `${count} open dispute${count === 1 ? "" : "s"}`
      : "No open disputes";
  }
  if (viewDisputesBtn) viewDisputesBtn.disabled = count === 0;
}

// The queue loads one status at a time, so the summary's counts come from a
// separate all-status fetch — they don't need refetching on every filter
// change, just once per page load.
async function loadReviewSummary() {
  try {
    const res = await fetch("/api/timesheets");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load timesheets");
    const counts = { pending: 0, approved: 0, rejected: 0 };
    rows.forEach((row) => {
      const status = (row.status || "pending").toLowerCase();
      if (counts[status] != null) counts[status] += 1;
    });
    updateChipCounts(counts);
    if (verifyPendingMetaEl)
      verifyPendingMetaEl.textContent = `${counts.pending} pending`;
    if (verifyDecidedMetaEl)
      verifyDecidedMetaEl.textContent = `${counts.approved + counts.rejected} decided`;
    if (verifyRejectedMetaEl)
      verifyRejectedMetaEl.textContent = `${counts.rejected} rejected`;
  } catch (err) {
    // The counts are a nicety — the queue below still loads without them.
  }
}

statusChipsEl?.addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  statusFilterEl.value = chip.dataset.status;
  syncStatusChips();
  loadSubmissions();
});

reviewPendingBtn?.addEventListener("click", () => {
  statusFilterEl.value = "pending";
  syncStatusChips();
  loadSubmissions();
});

viewDisputesBtn?.addEventListener("click", () => {
  if (openDisputeList.length === 0) return;
  openDisputeModal(openDisputeList, "Tutor");
});

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

async function exportPayroll() {
  try {
    const res = await fetch("/api/timesheets/payroll-export");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Couldn't export payroll.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

statusFilterEl.addEventListener("change", loadSubmissions);
exportPayrollBtn.addEventListener("click", exportPayroll);

// A search deep-link's target row might not be "pending" — default to
// showing all statuses so it isn't hidden by the default filter.
if (new URLSearchParams(window.location.search).get("highlight")) {
  statusFilterEl.value = "";
}

syncStatusChips();
loadReviewSummary();
loadSubmissions();
