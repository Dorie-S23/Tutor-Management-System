// Shared header search across courses, tutors, and timesheets. Dropped
// into board.html / tutors.html / timesheet-review.html as a plain
// script — self-contained, fetches its own data, and doesn't depend on
// any page's own JS state so it behaves identically everywhere.

const searchInput = document.getElementById("universalSearchInput");
const resultsEl = document.getElementById("universalSearchResults");

if (searchInput && resultsEl) {
  let courses = [];
  let tutors = [];
  let timesheets = [];

  async function loadData() {
    try {
      const [coursesRes, tutorsRes, timesheetsRes] = await Promise.all([
        fetch("/api/courses"),
        fetch("/api/tutors"),
        fetch("/api/timesheets"),
      ]);
      courses = coursesRes.ok ? await coursesRes.json() : [];
      tutors = tutorsRes.ok ? await tutorsRes.json() : [];
      timesheets = timesheetsRes.ok ? await timesheetsRes.json() : [];
    } catch {
      courses = [];
      tutors = [];
      timesheets = [];
    }
  }

  function toDisplayDate(dateStr) {
    if (!dateStr) return "";
    const [y, m, d] = dateStr.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  }

  function matchCourses(q) {
    return courses.filter(
      (c) =>
        c.course_code?.toLowerCase().includes(q) ||
        c.course_name?.toLowerCase().includes(q),
    );
  }

  function matchTutors(q) {
    return tutors.filter(
      (t) =>
        t.name?.toLowerCase().includes(q) ||
        t.email?.toLowerCase().includes(q) ||
        t.student_number?.toLowerCase().includes(q),
    );
  }

  function matchTimesheets(q) {
    return timesheets.filter((s) => s.users?.name?.toLowerCase().includes(q));
  }

  function renderResults(query) {
    const q = query.trim().toLowerCase();
    if (!q) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
      return;
    }

    const courseMatches = matchCourses(q).slice(0, 5);
    const tutorMatches = matchTutors(q).slice(0, 5);
    const timesheetMatches = matchTimesheets(q).slice(0, 5);

    if (
      courseMatches.length === 0 &&
      tutorMatches.length === 0 &&
      timesheetMatches.length === 0
    ) {
      resultsEl.innerHTML = `<li class="universal-search-empty">No matches</li>`;
      resultsEl.hidden = false;
      return;
    }

    const sections = [];

    if (courseMatches.length > 0) {
      sections.push(
        `<li class="universal-search-group">Courses</li>` +
          courseMatches
            .map(
              (c) => `
          <li><a href="board.html?course=${c.id}">${c.course_code} — ${c.course_name}</a></li>
        `,
            )
            .join(""),
      );
    }

    if (tutorMatches.length > 0) {
      sections.push(
        `<li class="universal-search-group">Tutors</li>` +
          tutorMatches
            .map(
              (t) => `
          <li><a href="tutors.html?highlight=${t.id}">${t.name || "Unnamed tutor"}${t.student_number ? ` — ${t.student_number}` : ""}</a></li>
        `,
            )
            .join(""),
      );
    }

    if (timesheetMatches.length > 0) {
      sections.push(
        `<li class="universal-search-group">Timesheets</li>` +
          timesheetMatches
            .map(
              (s) => `
          <li><a href="timesheet-review.html?highlight=${s.user_id}_${s.week_start}">${s.users?.name || "Unknown tutor"} — week of ${toDisplayDate(s.week_start)}</a></li>
        `,
            )
            .join(""),
      );
    }

    resultsEl.innerHTML = sections.join("");
    resultsEl.hidden = false;
  }

  searchInput.addEventListener("input", () =>
    renderResults(searchInput.value),
  );
  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim()) renderResults(searchInput.value);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".universal-search")) {
      resultsEl.hidden = true;
    }
  });

  loadData();
}
