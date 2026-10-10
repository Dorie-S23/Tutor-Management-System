// The organiser side of attendance verification. Every session a tutor or
// volunteer logs arrives in this queue as "pending" (see
// server/routes/attendanceVerification.js); an organiser for the entry's
// course confirms the logger actually attended ("verified") or disputes the
// entry with a note ("flagged"). The tutor/volunteer sees the state on their
// own pages and gets a notification when it changes. Structure mirrors
// timesheet-review.js: summary cards, filter chips, a review list and a
// shared reason modal.

const sessionListEl = document.getElementById("sessionList");
const sessionsEmptyEl = document.getElementById("sessionsEmpty");
const statusFilterEl = document.getElementById("statusFilter");
const statusChipsEl = document.getElementById("statusChips");
const reviewPendingBtn = document.getElementById("reviewPendingBtn");
const showFlaggedBtn = document.getElementById("showFlaggedBtn");
const verifyPendingMetaEl = document.getElementById("verifyPendingMeta");
const verifyDecidedMetaEl = document.getElementById("verifyDecidedMeta");
const verifyFlaggedMetaEl = document.getElementById("verifyFlaggedMeta");
const verifyVerifiedMetaEl = document.getElementById("verifyVerifiedMeta");

const currentUser = (() => {
  try {
    return JSON.parse(sessionStorage.getItem("user") || "null");
  } catch {
    return null;
  }
})();

// The API's statuses against the shared pill classes: "verified" is the good
// state (green, like an approved timesheet), "flagged" the bad one (red,
// like a rejected one). The pill text stays the verification word, though.
const PILLS = {
  pending: { className: "pending", label: "Pending" },
  verified: { className: "approved", label: "Verified" },
  flagged: { className: "rejected", label: "Flagged" },
};

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function sliceTime(value) {
  return value == null ? "" : String(value).slice(0, 5);
}

function timeRange(entry) {
  return `${sliceTime(entry.start_time)}–${sliceTime(entry.end_time)}`;
}

// "Mon 6 Oct" — short and unambiguous for a session row.
function formatShortDay(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function toDisplayDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function roleLabel(user) {
  const role = user?.role || "";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function makeActionBtn(label, variant, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small" + (variant ? ` ${variant}` : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function loadQueue() {
  sessionListEl.innerHTML = "";
  sessionsEmptyEl.hidden = true;

  let rows = [];
  try {
    const status = statusFilterEl.value;
    const scope = currentUser?.id
      ? `organiserId=${encodeURIComponent(currentUser.id)}`
      : "";
    const res = await fetch(
      `/api/attendance-verification?${scope}${status ? `&status=${status}` : ""}`,
    );
    rows = await res.json();
    if (!res.ok)
      throw new Error(rows.error || "Failed to load logged sessions");
  } catch (err) {
    showToast("Couldn't load logged sessions.");
    return;
  }

  if (rows.length === 0) {
    sessionsEmptyEl.hidden = false;
    return;
  }

  rows.forEach((entry) => renderRow(entry));

  applyHighlight();
}

// A notification deep-link lands here via ?highlightEntry=<id>; the row it
// points at may not be "pending", so the startup code below defaults the
// filter to All when the param is present.
function applyHighlight() {
  const highlightId = new URLSearchParams(window.location.search).get(
    "highlightEntry",
  );
  if (!highlightId) return;
  const row = [...sessionListEl.querySelectorAll("li[data-entry-id]")].find(
    (li) => li.dataset.entryId === highlightId,
  );
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("highlight-flash");
  setTimeout(() => row.classList.remove("highlight-flash"), 2500);
}

function renderRow(entry) {
  const user = entry.user;
  const name = user?.name || "Unknown";
  const status = entry.verification_status || "pending";
  const pill = PILLS[status] || PILLS.pending;
  const courseCode = entry.course?.course_code || entry.subject || "—";

  const li = document.createElement("li");
  li.dataset.entryId = String(entry.id);
  const row = document.createElement("div");
  row.className = "review-row";
  row.innerHTML = `
    <span class="avatar">${initials(name)}</span>
    <span class="name-block">
      <span class="name">${name}</span>
      <span class="role">${roleLabel(user)} · ${user?.email || ""}</span>
    </span>
    <span class="stamp-row">
      <span class="stamp">${courseCode}</span>
      ${entry.session_type ? `<span class="stamp">${entry.session_type}</span>` : ""}
      <span class="stamp">${formatShortDay(entry.date)} · ${timeRange(entry)}</span>
      <span class="stamp">${Number(entry.hours)} hrs</span>
    </span>
    <span class="status-pill ${pill.className}">${pill.label}</span>
    <span class="applicant-actions"></span>
  `;

  const actionsEl = row.querySelector(".applicant-actions");
  actionsEl.appendChild(
    makeActionBtn("Details", "btn-small-neutral", () =>
      toggleDetail(li, entry),
    ),
  );

  const verifyBtn = () =>
    makeActionBtn("Verify", "approve", () =>
      openReasonModal({
        title: "Verify session",
        fieldLabel: "Note (optional)",
        placeholder: "Optional note about the session",
        required: false,
        confirmLabel: "Verify",
        onConfirm: (note) => setStatus(entry, "verified", name, note),
      }),
    );
  const flagBtn = () =>
    makeActionBtn("Flag", "reject", () =>
      openReasonModal({
        title: "Flag session",
        fieldLabel: "Reason for flagging",
        placeholder: "e.g. the tutor didn't attend this tutorial",
        required: true,
        confirmLabel: "Flag",
        onConfirm: (note) => setStatus(entry, "flagged", name, note),
      }),
    );

  if (status === "pending") {
    actionsEl.appendChild(verifyBtn());
    actionsEl.appendChild(flagBtn());
  } else {
    actionsEl.appendChild(
      makeActionBtn("Reconsider", "", () => setStatus(entry, "pending", name)),
    );
    // The other call stays available so a change of mind is two clicks.
    actionsEl.appendChild(status === "verified" ? flagBtn() : verifyBtn());
  }

  li.appendChild(row);
  if (status !== "pending" && entry.verification_note) {
    const noteEl = document.createElement("p");
    noteEl.className = "review-note";
    noteEl.textContent = `Note: ${entry.verification_note}`;
    li.appendChild(noteEl);
  }
  sessionListEl.appendChild(li);
}

function toggleDetail(li, entry) {
  const existing = li.querySelector(".submission-detail");
  if (existing) {
    existing.remove();
    return;
  }

  const detail = document.createElement("div");
  detail.className = "submission-detail";
  detail.innerHTML = `
    <table class="tutors-table">
      <thead>
        <tr><th>Date</th><th>Time</th><th>Hours</th><th>Session</th><th>Venue</th><th>Task</th><th>Notes</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${toDisplayDate(entry.date)}</td>
          <td>${timeRange(entry)}</td>
          <td>${Number(entry.hours)}</td>
          <td>${entry.session_type || "—"}</td>
          <td>${entry.venue || "—"}</td>
          <td>${entry.task_type || "—"}</td>
          <td>${entry.notes || "—"}</td>
        </tr>
      </tbody>
    </table>
  `;
  li.appendChild(detail);
}

async function setStatus(entry, status, name, note) {
  try {
    const res = await fetch(`/api/attendance-verification/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note, reviewerId: currentUser?.id }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that session.");
      return false;
    }
    const messages = {
      verified: `${name}'s session verified`,
      flagged: `${name}'s session flagged`,
      pending: `${name}'s session moved back for verification`,
    };
    showToast(messages[status] || "Session updated.");
    await loadQueue();
    loadSummary();
    return true;
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    return false;
  }
}

// ---------- reason modal (verify-with-note / flag-with-reason) ----------

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

// ---------- summary (verify cards + filter chips) ----------

function syncStatusChips() {
  statusChipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle(
      "is-active",
      chip.dataset.status === statusFilterEl.value,
    );
  });
}

function updateChipCounts(counts) {
  const labels = {
    pending: "Pending",
    verified: "Verified",
    flagged: "Flagged",
    "": "All",
  };
  const total = counts.pending + counts.verified + counts.flagged;
  statusChipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    const status = chip.dataset.status;
    const count = status === "" ? total : counts[status] || 0;
    chip.textContent = `${labels[status]} (${count})`;
  });
}

// The queue loads one status at a time, so the card/chip counts come from a
// separate all-status fetch. Re-run after every decision so the cards keep
// up with the queue.
async function loadSummary() {
  try {
    const scope = currentUser?.id
      ? `organiserId=${encodeURIComponent(currentUser.id)}`
      : "";
    const res = await fetch(`/api/attendance-verification?${scope}`);
    const rows = await res.json();
    if (!res.ok) {
      throw new Error(rows.error || "Failed to load logged sessions");
    }
    const counts = { pending: 0, verified: 0, flagged: 0 };
    rows.forEach((row) => {
      const status = (row.verification_status || "pending").toLowerCase();
      if (counts[status] != null) counts[status] += 1;
    });
    updateChipCounts(counts);
    verifyPendingMetaEl.textContent = `${counts.pending} pending`;
    verifyDecidedMetaEl.textContent = `${counts.verified + counts.flagged} decided`;
    verifyFlaggedMetaEl.textContent = `${counts.flagged} flagged`;
    verifyVerifiedMetaEl.textContent = `${counts.verified} verified`;
    showFlaggedBtn.disabled = counts.flagged === 0;
  } catch (err) {
    // The counts are a nicety — the queue below still loads without them.
  }
}

statusChipsEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  statusFilterEl.value = chip.dataset.status;
  syncStatusChips();
  loadQueue();
});

reviewPendingBtn.addEventListener("click", () => {
  statusFilterEl.value = "pending";
  syncStatusChips();
  loadQueue();
});

showFlaggedBtn.addEventListener("click", () => {
  statusFilterEl.value = "flagged";
  syncStatusChips();
  loadQueue();
});

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

statusFilterEl.addEventListener("change", loadQueue);

// A notification deep-link's target row might not be "pending" — default to
// showing all statuses so it isn't hidden by the default filter.
if (new URLSearchParams(window.location.search).get("highlightEntry")) {
  statusFilterEl.value = "";
}

syncStatusChips();
loadSummary();
loadQueue();
