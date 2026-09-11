const submissionListEl = document.getElementById("submissionList");
const submissionsEmptyEl = document.getElementById("submissionsEmpty");
const statusFilterEl = document.getElementById("statusFilter");

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

function makeActionBtn(label, variant, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small" + (variant ? ` ${variant}` : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
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

  if (rows.length === 0) {
    submissionsEmptyEl.hidden = false;
    return;
  }

  rows.forEach((sub) => renderSubmission(sub));
}

function renderSubmission(sub) {
  const user = sub.users;
  const name = user?.name || "Unknown tutor";
  const status = (sub.status || "pending").toLowerCase();

  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tutor-row";
  row.innerHTML = `
    <span class="avatar">${initials(name)}</span>
    <span class="name-block">
      <span class="name">${name}</span>
      <span class="role">${user?.email || ""}</span>
    </span>
    <span class="stamp-row">
      <span class="stamp">Week of ${toDisplayDate(sub.week_start)}</span>
      <span class="stamp">${sub.total_hours} hrs</span>
    </span>
    <span class="status-pill ${status}">${status}</span>
    <span class="applicant-actions"></span>
  `;

  const actionsEl = row.querySelector(".applicant-actions");
  actionsEl.appendChild(
    makeActionBtn("Details", "btn-small-neutral", () => toggleDetail(li, sub)),
  );

  if (status === "pending") {
    actionsEl.appendChild(
      makeActionBtn("Approve", "approve", () =>
        setSubmissionStatus(sub, "approved", name),
      ),
    );
    actionsEl.appendChild(
      makeActionBtn("Reject", "", () =>
        setSubmissionStatus(sub, "rejected", name),
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
  submissionListEl.appendChild(li);
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
        <tr><th>Date</th><th>Hours</th><th>Task</th><th>Subject</th><th>Notes</th></tr>
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

async function setSubmissionStatus(sub, status, name) {
  try {
    const res = await fetch(
      `/api/timesheets/${sub.user_id}/${sub.week_start}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      },
    );
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that timesheet.");
      return;
    }
    const messages = {
      approved: `${name}'s timesheet approved`,
      rejected: `${name}'s timesheet rejected`,
      pending: `${name}'s timesheet moved back to pending`,
    };
    showToast(messages[status] || "Timesheet updated.");
    await loadSubmissions();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

statusFilterEl.addEventListener("change", loadSubmissions);

loadSubmissions();
