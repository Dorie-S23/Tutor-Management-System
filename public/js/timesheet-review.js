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

// What the queue currently shows (filter + rows + disputes) — the background
// poll skips its DOM rebuild when a fetch lands on an unchanged snapshot.
let lastQueueSnapshot = null;

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

// Opens the PDF the tutor submitted for this month. Months filed before the
// capture feature existed simply have none stored — the server answers 404
// and the toast points at Details, which can still show and print the claim
// rebuilt from the frozen snapshot.
async function openSubmissionPdf(sub, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(
      `/api/timesheets/${encodeURIComponent(sub.user_id)}/${sub.week_start}/pdf-url`,
    );
    if (res.status === 404) {
      showToast(
        "No PDF on file for that month — use Details to view or print the claim.",
      );
      return;
    }
    const body = await res.json();
    if (!res.ok) {
      showToast("Couldn't open the PDF — try again.");
      return;
    }
    window.open(body.url, "_blank");
  } catch {
    showToast("Network error — couldn't reach the server.");
  } finally {
    btn.disabled = false;
  }
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

// `quiet` marks the background sync's calls: a failing tick runs every few
// seconds and must not toast, while a user-initiated load still reports.
// Returns false when the fetch failed, so the poller can skip its "synced"
// stamp for a refresh that never landed.
async function loadSubmissions({ quiet = false } = {}) {
  let rows = [];
  try {
    const status = statusFilterEl.value;
    const res = await fetch(
      `/api/timesheets${status ? `?status=${status}` : ""}`,
    );
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load timesheets");
  } catch (err) {
    if (!quiet) showToast("Couldn't load timesheets.");
    return false;
  }

  await loadOpenDisputes();

  // Everything this list's output depends on — when a poll tick lands on
  // unchanged data, skip the rebuild entirely so the queue doesn't flash
  // (or collapse an open Details) every few seconds; a real change — a new
  // submission, another organiser's decision — still re-renders at once.
  const snapshot = JSON.stringify({
    status: statusFilterEl.value,
    rows,
    disputes: openDisputeList,
  });
  if (snapshot === lastQueueSnapshot) return true;
  lastQueueSnapshot = snapshot;

  submissionListEl.innerHTML = "";
  submissionsEmptyEl.hidden = true;

  if (rows.length === 0) {
    submissionsEmptyEl.hidden = false;
    return true;
  }

  rows.forEach((sub) => renderSubmission(sub));

  applyHighlight();
  return true;
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
  // The document the tutor submitted from, straight from storage — opened
  // in a new tab via a short-lived signed URL.
  const pdfBtn = makeActionBtn("PDF", "btn-small-neutral", () =>
    openSubmissionPdf(sub, pdfBtn),
  );
  actionsEl.appendChild(pdfBtn);

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

// ---------- the tutor's claim form (Details view) ----------

// The paper "Tutor Claim Form" the tutor prints from their own timesheets
// page (timesheets.html / timesheets.js), rebuilt here from the submission's
// frozen entries_snapshot so the organiser sees the document itself. The
// markup keeps the tutor page's structure and class names, so the sheet
// styles in app.css apply unchanged — but the tutor page's element ids
// (cFullName, ...) become data-claim hooks: several details can be open at
// once, and ids must stay unique.
const CLAIM_MIN_ROWS = 15;

const YEAR_OF_STUDY_LABELS = {
  third_year: "3rd Year",
  honours: "Honours",
  masters: "Masters",
  phd: "PhD",
};

function formatDuration(hours) {
  const n = Number(hours);
  return `${n}${n === 1 ? "hr" : "hrs"}`;
}

function claimDocumentHtml() {
  return `
    <div class="claim-doc-toolbar no-print">
      <button type="button" class="btn-small btn-small-neutral claim-print-btn">
        Print / Save as PDF
      </button>
    </div>
    <div class="claim-form">
      <table class="claim-title-table">
        <tr>
          <td class="claim-title-text">
            <div>School of Computer Sciences &amp; Applied Mathematics</div>
            <div>Tutor Claim Form</div>
            <div data-claim="year"></div>
          </td>
          <td class="claim-title-crest">
            <span
              class="claim-crest"
              role="img"
              aria-label="Wits University crest"
            ></span>
          </td>
        </tr>
      </table>

      <table class="claim-info-table">
        <colgroup>
          <col class="claim-col-label" />
          <col span="4" />
          <col class="claim-col-label2" />
          <col class="claim-col-value2" />
        </colgroup>
        <tr>
          <th>FULL<br />Name of Tutor:</th>
          <td colspan="6" data-claim="fullName"></td>
        </tr>
        <tr>
          <th>Student No.:</th>
          <td colspan="4" data-claim="studentNo"></td>
          <th class="claim-th-strong">Payroll No:</th>
          <td data-claim="payrollNo"></td>
        </tr>
        <tr>
          <th>Email Address:</th>
          <td colspan="6" data-claim="email"></td>
        </tr>
        <tr>
          <th>
            Year of Study:
            <span class="visually-hidden" data-claim="yearOfStudy"></span>
          </th>
          <td class="claim-year-option" data-year="third_year">
            3<sup>rd</sup> Year
          </td>
          <td class="claim-year-option" data-year="honours">Honours</td>
          <td class="claim-year-option" data-year="masters">Masters</td>
          <td class="claim-year-option" data-year="phd">PhD</td>
          <th>Cell phone No:</th>
          <td data-claim="cellPhone"></td>
        </tr>
      </table>

      <table class="claim-tasks-table">
        <colgroup>
          <col class="claim-col-date" />
          <col class="claim-col-times" />
          <col class="claim-col-duration" />
          <col class="claim-col-description" />
          <col class="claim-col-supervisor" />
          <col class="claim-col-signature" />
        </colgroup>
        <thead>
          <tr>
            <th>Date of Task</th>
            <th>Times of Task</th>
            <th>Duration of Task</th>
            <th>
              Description of Task<br />(tutoring, marking, invigilation,
              admin)
            </th>
            <th>Name of Supervisor</th>
            <th>Signature of Supervisor</th>
          </tr>
        </thead>
        <tbody data-claim="rows"></tbody>
      </table>

      <table class="claim-footer-table">
        <tr>
          <th>Student Signature</th>
          <td></td>
          <th>Date:</th>
          <td class="claim-footer-value" data-claim="signDate"></td>
        </tr>
      </table>

      <table class="claim-footer-table">
        <tr>
          <th>Total Number of Hours:</th>
          <td class="claim-footer-value" data-claim="totalHours"></td>
          <th>Total Amount:</th>
          <td class="claim-footer-value" data-claim="totalAmount"></td>
        </tr>
      </table>

      <table class="claim-hos-table">
        <colgroup>
          <col class="claim-col-hos-label" />
          <col class="claim-col-hos-name" />
          <col class="claim-col-hos-signature" />
          <col />
        </colgroup>
        <tr>
          <th rowspan="2">Head of School:</th>
          <td class="claim-hos-name">Prof R Klein</td>
          <td></td>
          <td></td>
        </tr>
        <tr>
          <th>Name</th>
          <th>Signature</th>
          <th>Date</th>
        </tr>
      </table>
    </div>
  `;
}

// One snapshot entry as a claim task row, formatted exactly like the tutor's
// own claim (renderClaim in public/js/timesheets.js): dd/mm/yyyy date,
// "HH:MM-HH:MM" times, "2.5hrs" duration, "TaskType – Subject"
// description, and blank supervisor columns (a snapshot carries no
// supervisor). Returns the month's total hours for the totals table.
function renderClaimRows(tbody, entries) {
  tbody.innerHTML = "";
  const sorted = [...entries].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
  let totalHours = 0;

  for (const entry of sorted) {
    totalHours += Number(entry.hours);

    const times =
      entry.start_time && entry.end_time
        ? `${entry.start_time.slice(0, 5)}-${entry.end_time.slice(0, 5)}`
        : "";
    const description = [entry.task_type, entry.subject]
      .filter(Boolean)
      .join(" – ");

    const tr = document.createElement("tr");
    [
      toDisplayDate(entry.date),
      times,
      formatDuration(entry.hours),
      description,
      "",
      "",
    ].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  // The printed Wits form always has room for 15 tasks; blank rows keep the
  // same shape when fewer were logged.
  for (let i = sorted.length; i < CLAIM_MIN_ROWS; i++) {
    const tr = document.createElement("tr");
    tr.className = "claim-blank-row";
    for (let col = 0; col < 6; col++) {
      tr.appendChild(document.createElement("td"));
    }
    tbody.appendChild(tr);
  }

  return totalHours;
}

// The identity block mirrors the tutor's own claim: Profile-page values
// (name, student number, e-mail, cell phone) and the locked year of study
// from the tutor record. The payroll number only ever exists in the tutor's
// browser, so it stays blank here — like the paper form until payroll
// completes it. A failed fetch leaves the blanks; the document still renders
// everything the submission itself carries.
async function fillClaimIdentity(claim, userId) {
  if (!userId) return;

  let profile;
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(userId)}`);
    if (!res.ok) return;
    profile = await res.json();
  } catch {
    return;
  }

  const setField = (field, value) => {
    if (!value) return;
    claim.querySelector(`[data-claim="${field}"]`).textContent = value;
  };
  setField("fullName", profile.name);
  setField("studentNo", profile.studentNumber);
  setField("email", profile.email);
  setField("cellPhone", profile.cellPhone);

  // Only the four levels the form lists can mark an option; anything else
  // (or nothing on record) leaves them all unmarked, like the tutor page.
  const level = Object.hasOwn(YEAR_OF_STUDY_LABELS, profile.yearOfStudy ?? "")
    ? profile.yearOfStudy
    : "";
  setField("yearOfStudy", YEAR_OF_STUDY_LABELS[level] || "");
  claim.querySelectorAll(".claim-year-option").forEach((cell) => {
    cell.classList.toggle(
      "is-selected",
      level !== "" && cell.dataset.year === level,
    );
  });
}

// Printing straight from the page would include all its chrome; narrowing
// the paper copy to the open submission's claim sheet keeps Print / Save as
// PDF to the one document (body.claim-printing rules in app.css).
function printClaim(claim) {
  document.body.classList.add("claim-printing");
  claim.classList.add("claim-print-target");
  const cleanup = () => {
    document.body.classList.remove("claim-printing");
    claim.classList.remove("claim-print-target");
  };

  // window.print() blocks until the dialog closes in most browsers; Safari
  // prints asynchronously, so afterprint covers the cleanup there too.
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
  cleanup();
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
    ${claimDocumentHtml()}
  `;

  // What the row already carries goes in first; the profile fetch below
  // fills in the rest of the identity block a beat later.
  const claim = detail.querySelector(".claim-form");
  claim.querySelector('[data-claim="fullName"]').textContent =
    sub.users?.name || "";
  claim.querySelector('[data-claim="email"]').textContent =
    sub.users?.email || "";

  // The claim's header year and signature date freeze at the day the
  // timesheet was submitted, just as entries_snapshot freezes the hours.
  const submittedAt = sub.submitted_at || new Date().toISOString();
  claim.querySelector('[data-claim="year"]').textContent = submittedAt.slice(
    0,
    4,
  );
  claim.querySelector('[data-claim="signDate"]').textContent =
    toDisplayDate(submittedAt);

  const totalHours = renderClaimRows(
    claim.querySelector('[data-claim="rows"]'),
    entries,
  );
  claim.querySelector('[data-claim="totalHours"]').textContent = totalHours;

  detail
    .querySelector(".claim-print-btn")
    .addEventListener("click", () => printClaim(claim));

  li.appendChild(detail);
  fillClaimIdentity(claim, sub.user_id);
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

statusFilterEl.addEventListener("change", () => loadSubmissions());
exportPayrollBtn.addEventListener("click", exportPayroll);

// A search deep-link's target row might not be "pending" — default to
// showing all statuses so it isn't hidden by the default filter.
if (new URLSearchParams(window.location.search).get("highlight")) {
  statusFilterEl.value = "";
}

// ---------- background sync (mirrors board.html's polling) ----------

const syncStatusEl = document.getElementById("syncStatus");

function syncSecondsSince(date) {
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
}

// The stamp only surfaces in the icon's hover text (title/aria-label), so
// it steps up through units instead of counting raw seconds forever:
// seconds while fresh, then minutes, hours, days.
function formatSyncStatus(date) {
  const seconds = syncSecondsSince(date);
  if (seconds < 3) return "Synced just now";
  if (seconds < 60) return `Synced ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.floor(hours / 24)}d ago`;
}

let lastSyncedAt = null;

function tickSyncStatusLabel() {
  if (syncStatusEl && lastSyncedAt) {
    const label = formatSyncStatus(lastSyncedAt);
    syncStatusEl.title = label;
    syncStatusEl.setAttribute("aria-label", label);
  }
}

// The icon stays transparent-ish in the header and only comes forward for
// a moment each time a sync lands — a quiet "just refreshed" pulse.
let syncFlashTimer = null;

function flashSyncIcon() {
  if (!syncStatusEl) return;
  syncStatusEl.classList.add("is-flashing");
  clearTimeout(syncFlashTimer);
  // Another sync inside the window just extends the flash, not stack timers.
  syncFlashTimer = setTimeout(() => {
    syncStatusEl.classList.remove("is-flashing");
  }, 1500);
}

let refreshInFlight = false;

// Re-fetches everything this page shows. The snapshot check inside
// loadSubmissions keeps an unchanged queue pixel-identical, and an open
// modal or an in-flight refresh pauses the tick entirely so it can't yank
// the page out from under a decision in progress.
async function refreshReviewQueue() {
  if (refreshInFlight || reasonModal.open || disputeModal.open) return;

  refreshInFlight = true;
  try {
    const ok = await loadSubmissions({ quiet: true });
    await loadReviewSummary();
    if (ok) {
      lastSyncedAt = new Date();
      tickSyncStatusLabel();
      flashSyncIcon();
    }
  } finally {
    refreshInFlight = false;
  }
}

const POLL_INTERVAL_MS = 8000;

function startPollingSync() {
  setInterval(() => {
    if (!document.hidden) refreshReviewQueue();
  }, POLL_INTERVAL_MS);

  setInterval(tickSyncStatusLabel, 1000); // keeps the hover label + fade state current

  // Catch up immediately when the tab regains focus.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshReviewQueue();
  });
}

syncStatusChips();

// Initial load, then the same background sync board.html runs: poll every
// 8s (skipped while the tab is hidden) and catch up on refocus, so the
// queue reflects other organisers' decisions and new submissions without a
// manual refresh.
(async function init() {
  await Promise.all([loadSubmissions(), loadReviewSummary()]);
  lastSyncedAt = new Date();
  tickSyncStatusLabel();
  startPollingSync();
})();
