// Volunteer timesheets: hour entries grouped by week + module, the way the
// Figma prototype lays them out — "COMS1018 / 11–15 Aug 2025 / Peer support
// sessions / 4h / status".
//
// The backend's hour_entries have no approval workflow, so entries are shown
// with a single honest "Logged" state rather than inventing mock
// Submitted/Approved/Draft statuses. The pill styling matches the
// prototype's "Submitted" pill.

import { getEntries, getWeekStart, requireRole } from "./storage.js";
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

// "11–15 Aug 2025" within one month, "29 Aug – 4 Sep 2025" across two.
function formatWeekRange(weekStart) {
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);

  const startMonth = start.toLocaleDateString(undefined, { month: "short" });
  const endMonth = end.toLocaleDateString(undefined, { month: "short" });
  const startDay = start.getDate();
  const endDay = end.getDate();
  const year = end.getFullYear();

  return startMonth === endMonth
    ? `${startDay}–${endDay} ${endMonth} ${year}`
    : `${startDay} ${startMonth} – ${endDay} ${endMonth} ${year}`;
}

function renderRows(entries) {
  listEl.innerHTML = "";

  if (entries.length === 0) {
    listEl.innerHTML = `<p class="empty-state" style="margin: 18px 0">No hours logged yet — log your first session and it will show up here.</p>`;
    return;
  }

  // One row per (week, module): the sum of that week's entries for a course.
  const groups = new Map();
  entries.forEach((entry) => {
    const weekStart = getWeekStart(entry.date);
    const key = `${weekStart}::${entry.subject || "—"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        weekStart,
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
      a.weekStart.localeCompare(b.weekStart) ||
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
    article.querySelector(".timesheet-week").textContent = formatWeekRange(
      row.weekStart,
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
