// Volunteer completed sessions: hour entries grouped by month + module, the
// way the Figma prototype lays them out — "COMS1018 / August 2025 / Peer
// support sessions / 4h / status".
//
// The backend's hour_entries have no approval workflow, so entries are shown
// with a single honest "Logged" state rather than inventing mock
// Submitted/Approved/Draft statuses. The pill styling matches the
// prototype's "Submitted" pill.

import { getEntries, getMonthStart, requireRole } from "./storage.js";
import { highlightActiveTab } from "./nav.js";

const currentUser = requireRole("volunteer");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

const listEl = document.getElementById("timesheetList");

function formatHours(hours) {
  return `${Number(hours.toFixed(1))}h`;
}

// "August 2025" — the calendar month a group of entries rolls up to.
function formatMonthLabel(monthStart) {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function renderRows(entries) {
  listEl.innerHTML = "";

  if (entries.length === 0) {
    listEl.innerHTML = `<p class="empty-state" style="margin: 18px 0">No completed sessions yet — sessions you log will show up here.</p>`;
    return;
  }

  // One row per (month, module): the sum of that month's entries for a course.
  const groups = new Map();
  entries.forEach((entry) => {
    const monthStart = getMonthStart(entry.date);
    const key = `${monthStart}::${entry.subject || "—"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        monthStart,
        subject: entry.subject || "—",
        taskType: entry.taskType || "Tutoring",
        hours: 0,
      });
    }
    const group = groups.get(key);
    group.hours += Number(entry.hours);
  });

  const rows = [...groups.values()].sort(
    (a, b) =>
      a.monthStart.localeCompare(b.monthStart) ||
      a.subject.localeCompare(b.subject),
  );

  rows.forEach((row) => {
    const article = document.createElement("article");
    article.className = "timesheet-row";
    article.innerHTML = `
      <div>
        <p class="timesheet-course"></p>
        <p class="timesheet-week"></p>
      </div>
      <p class="timesheet-desc"></p>
      <p class="timesheet-hours"></p>
      <span class="status-pill logged">Logged</span>
    `;
    article.querySelector(".timesheet-course").textContent = row.subject;
    article.querySelector(".timesheet-week").textContent = formatMonthLabel(
      row.monthStart,
    );
    article.querySelector(".timesheet-desc").textContent = row.taskType;
    article.querySelector(".timesheet-hours").textContent = formatHours(
      row.hours,
    );
    listEl.appendChild(article);
  });
}

(async () => {
  try {
    renderRows(await getEntries());
  } catch {
    listEl.innerHTML = `<p class="empty-state" style="margin: 18px 0">Couldn't load your hours right now — try again later.</p>`;
  }
})();
