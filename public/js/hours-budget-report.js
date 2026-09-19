const fromDateEl = document.getElementById("fromDate");
const toDateEl = document.getElementById("toDate");
const applyFilterBtn = document.getElementById("applyFilterBtn");
const clearFilterBtn = document.getElementById("clearFilterBtn");
const reportSectionsEl = document.getElementById("reportSections");
const emptyCopyEl = document.getElementById("emptyCopy");
const unlinkedWarningEl = document.getElementById("unlinkedWarning");

function formatMoney(value) {
  if (value == null) return "—";
  return `R${Number(value).toFixed(2)}`;
}

function formatHours(value) {
  return `${Number(value).toFixed(1)} hrs`;
}

async function loadReport() {
  reportSectionsEl.innerHTML = `<p class="hint">Loading…</p>`;
  emptyCopyEl.hidden = true;
  unlinkedWarningEl.hidden = true;

  const params = new URLSearchParams();
  if (fromDateEl.value) params.set("from", fromDateEl.value);
  if (toDateEl.value) params.set("to", toDateEl.value);

  let body;
  try {
    const res = await fetch(`/api/hour-entries/report?${params.toString()}`);
    body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to load report");
  } catch (err) {
    reportSectionsEl.innerHTML = "";
    showToast(err.message || "Couldn't load the report right now.");
    return;
  }

  const { rows, unlinkedHours, unlinkedEntryCount } = body;

  if (unlinkedEntryCount > 0) {
    unlinkedWarningEl.hidden = false;
    unlinkedWarningEl.textContent = `${formatHours(unlinkedHours)} across ${unlinkedEntryCount} ${unlinkedEntryCount === 1 ? "entry" : "entries"} logged as Tutoring aren't linked to a course, and are excluded from the totals below.`;
  }

  renderReport(rows);
}

function renderReport(rows) {
  reportSectionsEl.innerHTML = "";

  if (rows.length === 0) {
    emptyCopyEl.hidden = false;
    return;
  }
  emptyCopyEl.hidden = true;

  const byCourse = new Map();
  for (const row of rows) {
    if (!byCourse.has(row.courseId)) {
      byCourse.set(row.courseId, {
        courseCode: row.courseCode,
        courseName: row.courseName,
        budget: row.budget,
        tutorRows: [],
      });
    }
    byCourse.get(row.courseId).tutorRows.push(row);
  }

  const courses = [...byCourse.values()].sort((a, b) =>
    a.courseCode.localeCompare(b.courseCode),
  );

  courses.forEach((course) => {
    const totalHours = course.tutorRows.reduce((sum, r) => sum + r.hours, 0);
    const totalCost = course.tutorRows.reduce(
      (sum, r) => sum + (r.cost ?? 0),
      0,
    );
    const hasUnknownRate = course.tutorRows.some((r) => r.cost == null);
    const remaining = course.budget != null ? course.budget - totalCost : null;
    const overBudget = remaining != null && remaining < 0;

    const section = document.createElement("section");
    section.className = "card";

    const header = document.createElement("header");
    header.innerHTML = `
      <h2>${course.courseCode} — ${course.courseName}</h2>
      <p class="hint">
        Budget: ${formatMoney(course.budget)}
        &nbsp;·&nbsp; Spent: ${formatMoney(totalCost)}${hasUnknownRate ? " (partial — some tutors have no hourly rate set)" : ""}
        &nbsp;·&nbsp; Remaining: <strong>${remaining != null ? formatMoney(remaining) : "—"}</strong>
        ${overBudget ? " ⚠️ Over budget" : ""}
      </p>
    `;
    section.appendChild(header);

    const table = document.createElement("table");
    table.innerHTML = `
      <thead>
        <tr>
          <th>Tutor</th>
          <th>Hours logged</th>
          <th>Hourly rate</th>
          <th>Cost</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement("tbody");
    course.tutorRows
      .sort((a, b) => b.hours - a.hours)
      .forEach((row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${row.tutorName || "Unknown tutor"}</td>
          <td>${formatHours(row.hours)}</td>
          <td>${row.hourlyRate != null ? formatMoney(row.hourlyRate) : "—"}</td>
          <td>${formatMoney(row.cost)}</td>
        `;
        tbody.appendChild(tr);
      });
    table.appendChild(tbody);
    section.appendChild(table);

    reportSectionsEl.appendChild(section);
  });
}

applyFilterBtn.addEventListener("click", loadReport);
clearFilterBtn.addEventListener("click", () => {
  fromDateEl.value = "";
  toDateEl.value = "";
  loadReport();
});

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

loadReport();