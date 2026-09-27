const COURSES = [];

// course_level is stored as a numeric rank (matches server/routes/tutorApplications.js's
// LEVEL_RANK) but the organiser picks it from a labelled dropdown, same as tutors do
// for their own academic_level on modules.html.
const COURSE_LEVEL_LABELS = {
  3: "third_year",
  4: "honours",
  5: "masters",
  6: "phd",
};

// ---------- state ----------

let activeCourseId = null;
let tutorCount = 0; // total tutors in the system, for the header stat
let volunteerCounts = {}; // course_id -> number of approved volunteers
let shortfallOnly = false; // when true, course rail shows only short-staffed courses, worst-first
let pendingApplicationCounts = {}; // course_id -> number of pending tutor applications
let pendingVolunteerCounts = {}; // course_id -> number of pending student volunteers

// ---------- allocation balance ----------
//
// Which preset of objective weights orders the applicant list (see
// js/allocation-objectives.js, shared with the ranking API). Persisted so a
// refresh keeps the organiser's chosen balance.

const PRESET_STORAGE_KEY = "board.balancePreset";

function validPreset(name) {
  return (
    !!window.AllocationObjectives &&
    window.AllocationObjectives.PRESET_NAMES.includes(name)
  );
}

function loadBalancePreset() {
  try {
    const stored = localStorage.getItem(PRESET_STORAGE_KEY);
    if (validPreset(stored)) return stored;
  } catch (err) {
    // Storage unavailable (private mode, blocked cookies) — just default.
  }
  return "merit";
}

let balancePreset = loadBalancePreset();

function saveBalancePreset(name) {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, name);
  } catch (err) {
    // Persisting is best-effort; the in-page switch still applies.
  }
}

const presetPickerEl = document.getElementById("presetPicker");
const presetHintEl = document.getElementById("presetHint");

function renderPresetPicker() {
  if (!presetPickerEl) return;
  presetPickerEl.querySelectorAll(".preset-btn").forEach((btn) => {
    const active = btn.dataset.preset === balancePreset;
    btn.setAttribute("aria-pressed", String(active));
    btn.classList.toggle("active", active);
  });
}

function setBalancePreset(name) {
  if (!validPreset(name) || name === balancePreset) return;
  balancePreset = name;
  saveBalancePreset(name);
  renderPresetPicker();
  // A different blend re-ranks the same applicants — drop the snapshot
  // guard so renderApplicants() actually rebuilds the list.
  lastApplicantsSnapshot = null;
  if (activeCourseId) {
    const course = COURSES.find((c) => c.id === activeCourseId);
    if (course) renderApplicants(course);
  }
}

presetPickerEl?.addEventListener("click", (event) => {
  const btn = event.target.closest(".preset-btn");
  if (btn) setBalancePreset(btn.dataset.preset);
});

renderPresetPicker();

// ---------- data loading ----------

function mapCourseRow(row) {
  return {
    id: row.id,
    code: row.course_code,
    name: row.course_name,
    minMark: row.min_mark,
    courseLevel: row.course_level,
    department: row.department,
    hoursNeeded: row.hours_per_week,
    tutorsNeeded: row.tutors_needed,
    tutorsAssigned: row.no_of_tutors_assigned ?? 0,
    budget: row.budget,
    dayOfTut: row.Day_of_tut,
    startTime: row.tutor_start_time,
    endTime: row.tutor_end_time,
    venues: row.venues,
    dayOfLab: row.Day_of_lab,
    labStartTime: row.lab_start_time,
    labEndTime: row.lab_end_time,
    labVenues: row.lab_venues,
    tutorialSession:
      row.Day_of_tut && row.tutor_start_time && row.tutor_end_time
        ? {
            day: row.Day_of_tut,
            start: row.tutor_start_time.slice(0, 5),
            end: row.tutor_end_time.slice(0, 5),
          }
        : null,
    labSession:
      row.Day_of_lab && row.lab_start_time && row.lab_end_time
        ? {
            day: row.Day_of_lab,
            start: row.lab_start_time.slice(0, 5),
            end: row.lab_end_time.slice(0, 5),
          }
        : null,
  };
}

// Returns every scheduled tutorial/lab session across all courses, tagged
// with its course — the flat list the timetable grid and the venue-clash
// check both work from.
function getAllSessions() {
  const sessions = [];
  COURSES.forEach((course) => {
    if (course.tutorialSession) {
      sessions.push({
        courseId: course.id,
        courseCode: course.code,
        type: "Tutorial",
        day: course.tutorialSession.day,
        start: course.tutorialSession.start,
        end: course.tutorialSession.end,
        venue: course.venues || "",
      });
    }
    if (course.labSession) {
      sessions.push({
        courseId: course.id,
        courseCode: course.code,
        type: "Lab",
        day: course.labSession.day,
        start: course.labSession.start,
        end: course.labSession.end,
        venue: course.labVenues || "",
      });
    }
  });
  return sessions;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function timesOverlap(startA, endA, startB, endB) {
  return (
    timeToMinutes(startA) < timeToMinutes(endB) &&
    timeToMinutes(startB) < timeToMinutes(endA)
  );
}

// A venue field can list several rooms for one session (e.g. multiple
// tutorial groups) as "MSL004,005,006" — a shorthand where bare numbers
// inherit the last letter prefix (so "005" means "MSL005"). Split that into
// individual, fully-qualified room names rather than comparing the whole
// field as one string.
function parseVenues(venueStr) {
  const tokens = (venueStr || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  let prefix = "";
  return tokens.map((token) => {
    const match = token.match(/^([A-Za-z]+)(\d.*)$/);
    if (match) {
      prefix = match[1];
      return token;
    }
    return prefix && /^\d/.test(token) ? prefix + token : token;
  });
}

// Rooms shared between two venue fields, preserving venueA's original casing.
function sharedVenues(venueA, venueB) {
  const setB = new Set(parseVenues(venueB).map((v) => v.toLowerCase()));
  return parseVenues(venueA).filter((v) => setB.has(v.toLowerCase()));
}

// Same day, at least one room in common, overlapping time.
function sessionsClash(a, b) {
  return (
    a.day &&
    b.day &&
    a.day === b.day &&
    sharedVenues(a.venue, b.venue).length > 0 &&
    timesOverlap(a.start, a.end, b.start, b.end)
  );
}

// Venue double-bookings across every course's Tutorial and Lab sessions.
// excludeCourseId + excludeType lets the edit modal check a session's
// in-progress edits against everyone else (including the *other* session
// type on the same course) without flagging itself.
function findVenueClashes(session, excludeCourseId = null, excludeType = null) {
  if (!session.day || !session.start || !session.end || !session.venue) {
    return [];
  }
  return getAllSessions().filter(
    (other) =>
      !(other.courseId === excludeCourseId && other.type === excludeType) &&
      sessionsClash(session, other),
  );
}

async function fetchCourses() {
  try {
    const res = await fetch("/api/courses");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load courses");

    COURSES.length = 0;
    rows.forEach((row) => COURSES.push(mapCourseRow(row)));
  } catch (err) {
    showToast("Couldn't load courses from the database.");
  }
  renderCourseList();
  renderDetail();
}

async function fetchVolunteerCounts() {
  try {
    const res = await fetch("/api/course-volunteers/counts?status=approved");
    const counts = await res.json();
    if (!res.ok) throw new Error(counts.error || "Failed to load volunteers");
    volunteerCounts = counts;
  } catch (err) {
    volunteerCounts = {};
  }
  renderCourseList();
  renderDetail();
}

async function fetchTutorCount() {
  try {
    const res = await fetch("/api/tutors");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load tutors");
    tutorCount = rows.length;
  } catch (err) {
    tutorCount = 0;
  }
  statTutorsEl.textContent = tutorCount;
}

// No dedicated "pending applications across all courses" endpoint exists,
// so this fetches per-course the same way renderApplicants() already does,
// just for every course at once, and keeps only the counts.
async function fetchPendingApplicationCounts() {
  if (COURSES.length === 0) {
    pendingApplicationCounts = {};
    renderCourseList();
    return;
  }
  try {
    const results = await Promise.all(
      COURSES.map(async (course) => {
        const res = await fetch(
          `/api/tutor-applications?courseId=${course.id}`,
        );
        const rows = await res.json();
        if (!res.ok)
          throw new Error(rows.error || "Failed to load applications");
        const pending = rows.filter(
          (a) => (a.status || "pending").toLowerCase() === "pending",
        ).length;
        return [course.id, pending];
      }),
    );
    pendingApplicationCounts = Object.fromEntries(results);
  } catch (err) {
    // Fails open, same as the rest of the board: badges just show 0 rather
    // than blocking the page if one course's fetch has a hiccup.
    pendingApplicationCounts = {};
  }
  renderCourseList();
}

// Assumes /api/course-volunteers/counts accepts status=pending the same
// way it already accepts status=approved (see fetchVolunteerCounts above).
async function fetchPendingVolunteerCounts() {
  try {
    const res = await fetch("/api/course-volunteers/counts?status=pending");
    const counts = await res.json();
    if (!res.ok) throw new Error(counts.error || "Failed to load volunteers");
    pendingVolunteerCounts = counts;
  } catch (err) {
    pendingVolunteerCounts = {};
  }
  renderCourseList();
}

// ---------- helpers ----------

function initials(name) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ---------- rendering: course rail ----------

const courseListEl = document.getElementById("courseList");
const courseSearchEl = document.getElementById("courseSearch");
const shortfallToggleEl = document.getElementById("shortfallToggle");
const statFilledEl = document.getElementById("statFilled");
const statTutorsEl = document.getElementById("statTutors");
const statPendingEl = document.getElementById("statPending");
const syncStatusEl = document.getElementById("syncStatus");

function shortfall(course) {
  return course.tutorsNeeded ? course.tutorsNeeded - course.tutorsAssigned : 0;
}

// Total items on this course awaiting an organiser's decision: pending
// tutor applications + pending student volunteers.
function pendingCount(course) {
  return (
    (pendingApplicationCounts[course.id] || 0) +
    (pendingVolunteerCounts[course.id] || 0)
  );
}

let lastCourseListSnapshot = null;

function renderCourseList() {
  const query = courseSearchEl.value.trim().toLowerCase();

  // Everything this function's output depends on — if none of it changed
  // since last render, skip the rebuild entirely. Prevents the course
  // rail flashing on every poll tick when nothing actually changed, while
  // still re-rendering immediately for real changes (a live edit from
  // another organiser) or local UI state (typing in search, toggling the
  // shortfall filter, selecting a course).
  const snapshot = JSON.stringify({
    courses: COURSES,
    volunteerCounts,
    pendingApplicationCounts,
    pendingVolunteerCounts,
    query,
    shortfallOnly,
    activeCourseId,
  });
  if (snapshot === lastCourseListSnapshot) return;
  lastCourseListSnapshot = snapshot;

  const filled = COURSES.filter(
    (c) => c.tutorsNeeded && c.tutorsAssigned >= c.tutorsNeeded,
  ).length;
  statFilledEl.textContent = `${filled} / ${COURSES.length}`;

  const totalPending = COURSES.reduce((sum, c) => sum + pendingCount(c), 0);
  statPendingEl.textContent = totalPending;
  statPendingEl.classList.toggle("stat-value--attention", totalPending > 0);

  courseListEl.innerHTML = "";

  let visible = COURSES.filter(
    (c) =>
      !query ||
      c.code.toLowerCase().includes(query) ||
      c.name.toLowerCase().includes(query),
  );

  if (shortfallOnly) {
    visible = visible
      .filter((c) => shortfall(c) > 0)
      .sort((a, b) => shortfall(b) - shortfall(a));
  }

  visible.forEach((course) => {
    const li = document.createElement("li");
    const isFull =
      !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;
    const pending = pendingCount(course);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "course-card" + (course.id === activeCourseId ? " active" : "");
    btn.setAttribute("aria-pressed", course.id === activeCourseId);
    // Roving tabindex: only the active card (or the first, if none is active
    // yet) sits in the page's Tab order — Up/Down/Home/End move between the
    // rest, so an organiser paging through many courses isn't tabbing past
    // every single one to get anywhere else on the page.
    btn.tabIndex = course.id === activeCourseId ? 0 : -1;
    btn.dataset.courseId = String(course.id);
    btn.innerHTML = `
        <span class="course-code">${course.code}</span>
        <span class="course-name">${course.name}</span>
        <div class="card-foot">
          <span>${course.tutorsAssigned} / ${course.tutorsNeeded ?? "—"} assigned, ${volunteerCounts[course.id] ?? 0} volunteered</span>
          <span class="status-pill ${isFull ? "filled" : "open"}">${isFull ? "Staffed" : shortfall(course) > 0 ? `Short ${shortfall(course)}` : "Open"}</span>
          ${pending > 0 ? `<span class="status-pill pending">${pending} to review</span>` : ""}
        </div>
      `;
    btn.addEventListener("click", () => {
      selectCourse(course.id);
      // selectCourse() rebuilds this whole list, destroying the button that
      // was just clicked — without this, focus silently falls back to
      // <body> and the next arrow-key press just scrolls the page instead
      // of reaching the keydown handler below.
      focusCourseCard(course.id);
    });
    li.appendChild(btn);
    courseListEl.appendChild(li);
  });

  const cards = Array.from(courseListEl.querySelectorAll(".course-card"));
  if (cards.length && !cards.some((c) => c.tabIndex === 0)) {
    cards[0].tabIndex = 0;
  }
}

function focusCourseCard(courseId) {
  const card = courseListEl.querySelector(
    `.course-card[data-course-id="${CSS.escape(String(courseId))}"]`,
  );
  if (card) card.focus();
}

function isTypingInField() {
  const active = document.activeElement;
  return !!(
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  );
}

// Listens on the whole page, not just the course list, so Up/Down/Home/End
// navigate courses no matter where focus currently is (including nowhere,
// e.g. right after a mouse click elsewhere) — the only thing that opts out
// is actually typing into a text field, where arrow keys should do their
// normal job of moving the cursor.
document.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (isTypingInField()) return;

  const cards = Array.from(courseListEl.querySelectorAll(".course-card"));
  if (cards.length === 0) return;

  const currentIndex = cards.findIndex(
    (c) => c.dataset.courseId === String(activeCourseId),
  );

  let targetIndex;
  switch (event.key) {
    case "ArrowDown":
      targetIndex =
        currentIndex < 0 ? 0 : Math.min(currentIndex + 1, cards.length - 1);
      break;
    case "ArrowUp":
      targetIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
      break;
    case "Home":
      targetIndex = 0;
      break;
    case "End":
      targetIndex = cards.length - 1;
      break;
  }

  event.preventDefault();
  const targetCourseId = cards[targetIndex].dataset.courseId;
  const targetCourse = COURSES.find((c) => String(c.id) === targetCourseId);
  if (!targetCourse) return;

  selectCourse(targetCourse.id);
  focusCourseCard(targetCourse.id);
});

// ---------- rendering: detail pane ----------

function buildSessionSummary(course) {
  const parts = [];
  if (course.tutorialSession) {
    parts.push(
      `Tutorial ${course.tutorialSession.day} ${course.tutorialSession.start}–${course.tutorialSession.end}${course.venues ? ` (${course.venues})` : ""}`,
    );
  }
  if (course.labSession) {
    parts.push(
      `Lab ${course.labSession.day} ${course.labSession.start}–${course.labSession.end}${course.labVenues ? ` (${course.labVenues})` : ""}`,
    );
  }
  if (parts.length === 0) {
    return `${course.department}  ·  requires a mark of ${course.minMark}+  ·  not yet scheduled`;
  }
  return `${parts.join("  ·  ")}  ·  requires a mark of ${course.minMark}+`;
}

function formatMoney(value) {
  if (value == null) return "Not set";
  return `R${Number(value).toFixed(2)}`;
}

// Weekly cost projection: budget minus each currently-assigned (approved)
// tutor's hourly_rate × this course's hours_per_week. This is a forward-
// looking projection based on who's assigned right now — for actual
// logged-hours cost over time, see the Hours & Budget report page.
function renderRemainingBudget(course, applicantRows) {
  const remainingEl = document.getElementById("dRemainingBudget");
  if (course.budget == null) {
    remainingEl.textContent = "No budget set";
    return;
  }

  const approved = applicantRows.filter(
    (app) => (app.status || "").toLowerCase() === "approved",
  );
  const hasUnknownRate = approved.some(
    (app) => app.tutors?.hourly_rate == null,
  );
  const weeklyCost = approved.reduce((sum, app) => {
    const rate = app.tutors?.hourly_rate;
    return sum + (rate != null ? rate * (course.hoursNeeded || 0) : 0);
  }, 0);

  const remaining = course.budget - weeklyCost;
  remainingEl.textContent =
    formatMoney(remaining) +
    (hasUnknownRate ? " (partial — some rates unknown)" : "");
  remainingEl.classList.toggle("stat-value--attention", remaining < 0);
}

const emptyStateEl = document.getElementById("emptyState");
const courseDetailEl = document.getElementById("courseDetail");
const assignmentCardEl = document.getElementById("assignmentCard");

function selectCourse(courseId) {
  activeCourseId = courseId;
  renderCourseList();
  renderDetail();
}

function renderDetail() {
  if (!activeCourseId) {
    emptyStateEl.hidden = false;
    courseDetailEl.hidden = true;
    return;
  }
  emptyStateEl.hidden = true;
  courseDetailEl.hidden = false;

  const course = COURSES.find((c) => c.id === activeCourseId);

  document.getElementById("dCode").textContent = course.code;
  document.getElementById("dName").textContent = course.name;
  document.getElementById("dSession").textContent = buildSessionSummary(course);
  document.getElementById("dHours").textContent = course.hoursNeeded ?? "—";
  document.getElementById("dTutorsAssigned").textContent =
    `${course.tutorsAssigned} / ${course.tutorsNeeded ?? "—"}`;
  document.getElementById("dVolunteered").textContent =
    volunteerCounts[course.id] ?? 0;
  document.getElementById("dBudget").textContent = formatMoney(course.budget);
  document.getElementById("dRemainingBudget").textContent = "—";

  renderAssignmentCard(course);
  renderApplicants(course);
  renderExcusals(course);
  renderVolunteers(course);
}

// ---------- applications ----------

const LEVEL_LABELS = {
  second_year: "2nd year",
  third_year: "3rd year",
  honours: "Honours",
  masters: "Masters",
  phd: "PhD",
};

const applicantListEl = document.getElementById("applicantList");
const applicantsEmptyEl = document.getElementById("applicantsEmpty");

let applicantsRequestId = 0;

// Live timetable-clash + weekly-hours check for one tutor against one course.
// Fails open (returns null) so a check-endpoint hiccup never blocks rendering
// the applicant list — the stamps just don't show for that row.
async function fetchAssignmentCheck(tutorId, courseId) {
  try {
    const res = await fetch(
      `/api/tutors/${tutorId}/assignment-check?courseId=${courseId}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "assignment-check failed");
    return data;
  } catch (err) {
    return null;
  }
}

function hasClash(check) {
  return (
    !!check &&
    (check.clashes.busyTimeClashes.length > 0 ||
      check.clashes.courseClashes.length > 0)
  );
}

function buildClashStamp(check) {
  if (!check) return "";
  const { busyTimeClashes, courseClashes } = check.clashes;
  if (busyTimeClashes.length === 0 && courseClashes.length === 0) {
    return `<span class="stamp ok">No timetable clashes</span>`;
  }
  if (busyTimeClashes.length > 0) {
    const b = busyTimeClashes[0];
    return `<span class="stamp warn">Clashes with ${b.title || "your timetable"} (${b.start_time.slice(0, 5)}–${b.end_time.slice(0, 5)})</span>`;
  }
  const c = courseClashes[0];
  return `<span class="stamp warn">Clashes with ${c.course_code} (${c.tutor_start_time.slice(0, 5)}–${c.tutor_end_time.slice(0, 5)})</span>`;
}

function buildWorkloadStamp(check) {
  if (!check) return "";
  const { weeklyHourCap, projectedHours } = check.workload;
  if (weeklyHourCap == null) {
    return `<span class="stamp">${projectedHours} hrs/wk · no cap set</span>`;
  }
  const over = projectedHours > weeklyHourCap;
  return `<span class="stamp ${over ? "blocked" : "ok"}">${projectedHours}/${weeklyHourCap} hrs/wk${over ? " · over cap" : ""}</span>`;
}

// ---------- balance rendering ----------

function applicantDisplayName(app) {
  return app.Tutor_name || app.tutors?.name || "Unknown";
}

// Explains the active balance under the Applications heading: what it
// optimises for, and — when it disagrees with merit-first — who leads
// instead. Plain text (textContent), so names need no escaping.
function renderPresetHint(rows) {
  if (!presetHintEl) return;

  const parts = [];

  const preset = window.AllocationObjectives?.PRESETS?.[balancePreset];
  if (preset) parts.push(preset.description);

  if (rows.length > 1) {
    const leader = rows[0];
    const meritLeader = rows.find((r) => r.ranking?.meritRank === 1);
    if (
      leader.ranking?.meritRank &&
      leader.ranking.meritRank !== 1 &&
      meritLeader
    ) {
      parts.push(
        `${applicantDisplayName(leader)} leads this balance; merit-first would lead with ${applicantDisplayName(meritLeader)}.`,
      );
    }
  }

  presetHintEl.textContent = parts.join(" ");
}

function buildScoreStamp(app) {
  const score = app.ranking?.score;
  if (!Number.isFinite(score)) return "";
  return `<span class="stamp score" title="Blended score across all five objectives under the ${balancePreset} balance">Score ${Math.round(score)}</span>`;
}

// Pareto domination is weight-independent: with several applicants, someone
// who is at least as good on every objective and better on one beats this
// applicant under ANY balance, which is worth flagging either way.
function buildParetoStamp(app, applicantCount) {
  const dominated = app.ranking?.paretoDominated;
  if (dominated === undefined || applicantCount < 2) return "";
  if (dominated) {
    return `<span class="stamp warn" title="Another applicant is at least as good on every objective and strictly better on at least one, under any weighting.">Better all-round option exists</span>`;
  }
  return `<span class="stamp ok" title="No other applicant is better than them on every objective, whatever the weighting.">No better all-round option</span>`;
}

// The second line on an applicant row: one mini gauge per objective (filled
// to the normalised 0-1 score) plus, when the active balance pulls against
// merit-first, the trade-off note explaining how far they moved.
function buildBalanceMeta(app) {
  const objectives = app.ranking?.objectives;
  if (!objectives) return null;

  const meta = document.createElement("div");
  meta.className = "balance-meta";

  const bars = document.createElement("div");
  bars.className = "objective-bars";

  Object.entries(objectives).forEach(([name, value]) => {
    if (!Number.isFinite(value)) return;

    const objective = window.AllocationObjectives?.OBJECTIVES?.[name];
    const label = objective ? objective.label : name;
    const hint = objective ? ` (${objective.hint})` : "";
    const percent = Math.round(value * 100);

    const item = document.createElement("span");
    item.className = "objective-bar";
    item.title = `${label}${hint}: ${percent}%`;
    item.setAttribute("aria-label", `${label}: ${percent}%`);

    const fill = document.createElement("span");
    fill.className = "objective-bar-fill";
    fill.style.setProperty("--value", `${percent}%`);

    item.appendChild(fill);
    item.appendChild(document.createTextNode(label));
    bars.appendChild(item);
  });

  meta.appendChild(bars);

  if (app.ranking.tradeoff) {
    const note = document.createElement("p");
    note.className = "balance-note";
    note.textContent = app.ranking.tradeoff;
    meta.appendChild(note);
  }

  return meta;
}

let lastApplicantsSnapshot = null; // most recent `${courseId}:${preset}:${rowsJson}` rendered

async function renderApplicants(course) {
  const requestId = ++applicantsRequestId;

  let rows = [];
  try {
    const res = await fetch(
      `/api/tutor-applications?courseId=${course.id}&preset=${encodeURIComponent(balancePreset)}`,
    );
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load applications");
  } catch (err) {
    if (requestId === applicantsRequestId)
      showToast("Couldn't load applications for this course.");
    return;
  }

  // the active course may have changed while this request was in flight
  if (requestId !== applicantsRequestId) return;

  // Nothing about this course's applicants changed since we last actually
  // rendered them — skip the rebuild (and the assignment-check fetches
  // below) entirely, rather than flashing an identical list on every poll.
  // The preset is part of the key: switching balance re-ranks the same rows.
  const snapshot = `${course.id}:${balancePreset}:${JSON.stringify(rows)}`;
  if (snapshot === lastApplicantsSnapshot) return;
  lastApplicantsSnapshot = snapshot;

  applicantListEl.innerHTML = "";
  applicantsEmptyEl.hidden = true;

  renderRemainingBudget(course, rows);

  if (rows.length === 0) {
    applicantsEmptyEl.hidden = false;
    renderPresetHint(rows);
    return;
  }

  const checks = await Promise.all(
    rows.map((app) => fetchAssignmentCheck(app.tutor_id, course.id)),
  );

  if (requestId !== applicantsRequestId) return;

  renderPresetHint(rows);

  rows.forEach((app, i) => {
    const check = checks[i];
    const tutor = app.tutors;
    const name = applicantDisplayName(app);
    const status = (app.status || "pending").toLowerCase();
    const levelLabel = LEVEL_LABELS[tutor?.academic_level] || "Year not set";
    const markStamp =
      typeof app.tutor_mark === "number" && app.tutor_mark >= course.minMark
        ? `<span class="stamp ok">Mark ${app.tutor_mark}</span>`
        : `<span class="stamp blocked">Mark ${app.tutor_mark} · below ${course.minMark}</span>`;
    const availabilityStamp = app.Availability
      ? `<span class="stamp ok">Free at tutorial time</span>`
      : `<span class="stamp blocked">Not free at tutorial time</span>`;
    const overrideStamp = app.overrideInfo
      ? `<span class="stamp warn">Overridden: ${app.overrideInfo.reason}</span>`
      : "";

    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tutor-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="avatar">${initials(name)}</span>
      <span class="name-block">
        <span class="name">${name}</span>
        <span class="role">${levelLabel}</span>
      </span>
      <span class="stamp-row">
        ${buildScoreStamp(app)}
        ${markStamp}
        ${availabilityStamp}
        ${buildClashStamp(check)}
        ${buildWorkloadStamp(check)}
        ${buildParetoStamp(app, rows.length)}
        ${overrideStamp}
      </span>
      <span class="status-pill ${status}">${status}</span>
      <span class="applicant-actions"></span>
    `;

    const actionsEl = row.querySelector(".applicant-actions");
    const isFull =
      !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;
    const overCap = check?.workload?.overCap;
    const blockReason =
      (isFull && "This course already has all the tutors it needs") ||
      (overCap &&
        `This would put ${name} at ${check.workload.projectedHours} hrs/week, over their ${check.workload.weeklyHourCap} hr cap`);

    if (status === "pending") {
      actionsEl.appendChild(
        makeApplicantActionBtn(
          "Approve",
          "approve",
          () => {
            if (
              hasClash(check) &&
              !confirm(`${name} has a timetable clash — assign anyway?`)
            ) {
              return;
            }
            openReasonModal(
              `Approve ${name} for ${course.code}?`,
              "Approve with this note",
              (reason) =>
                setApplicationStatus(course, app, "approved", name, {
                  approvalReason: reason,
                }),
              "e.g. Strong mark and full availability at the tutorial time.",
            );
          },
          blockReason,
        ),
      );
      if (blockReason) {
        actionsEl.appendChild(
          makeApplicantActionBtn("Override", "override", () =>
            openOverrideModal(course, app, name, blockReason),
          ),
        );
      }
      actionsEl.appendChild(
        makeApplicantActionBtn("Reject", "", () =>
          openReasonModal(
            `Reject ${name}'s application?`,
            "Reject with this reason",
            (reason) =>
              setApplicationStatus(course, app, "rejected", name, {
                rejectionReason: reason,
              }),
          ),
        ),
      );
    } else if (status === "approved") {
      if (app.locked) {
        const lockedStamp = document.createElement("span");
        lockedStamp.className = "stamp";
        lockedStamp.textContent = "Locked";
        actionsEl.appendChild(lockedStamp);
      } else {
        actionsEl.appendChild(
          makeApplicantActionBtn("Unassign", "", () =>
            setApplicationStatus(course, app, "pending", name),
          ),
        );
        actionsEl.appendChild(
          makeApplicantActionBtn("Lock", "", () => {
            if (
              !confirm(
                `Lock ${name}'s assignment to ${course.code}? This is permanent — it can't be undone or reconsidered afterwards.`,
              )
            ) {
              return;
            }
            setApplicationLock(course, app, name);
          }),
        );
      }
    } else {
      actionsEl.appendChild(
        makeApplicantActionBtn("Reconsider", "", () =>
          setApplicationStatus(course, app, "pending", name),
        ),
      );
    }

    li.appendChild(row);

    const balanceMeta = buildBalanceMeta(app);
    if (balanceMeta) li.appendChild(balanceMeta);

    applicantListEl.appendChild(li);
  });
}

function makeApplicantActionBtn(label, variant, onClick, disabledTitle) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small" + (variant ? ` ${variant}` : "");
  btn.textContent = label;
  if (disabledTitle) {
    btn.disabled = true;
    btn.title = disabledTitle;
  } else {
    btn.addEventListener("click", onClick);
  }
  return btn;
}

// Collects a required reason/note before an approve or reject goes through
// — the tutor or student sees this text next to their status on their own
// dashboard, so it needs to actually say something useful to them.
const reasonModal = document.getElementById("reasonModal");
const reasonForm = document.getElementById("reasonForm");
const reasonHeading = document.getElementById("reasonHeading");
const reasonInput = document.getElementById("reasonInput");
const reasonError = document.getElementById("reasonError");
const reasonSubmitBtn = document.getElementById("reasonSubmitBtn");

let pendingReasonConfirm = null; // callback set by whichever button opened the modal

function openReasonModal(title, confirmLabel, onConfirm, placeholder) {
  pendingReasonConfirm = onConfirm;
  reasonHeading.textContent = title;
  reasonSubmitBtn.textContent = confirmLabel;
  reasonInput.placeholder =
    placeholder || "e.g. Mark just below the course minimum this term.";
  reasonForm.reset();
  reasonError.hidden = true;
  reasonModal.showModal();
  reasonInput.focus();
}

function closeReasonModal() {
  pendingReasonConfirm = null;
  reasonModal.close();
}

document
  .getElementById("reasonCloseBtn")
  .addEventListener("click", closeReasonModal);
document
  .getElementById("reasonCancelBtn")
  .addEventListener("click", closeReasonModal);
reasonModal.addEventListener("click", (e) => {
  if (e.target === reasonModal) closeReasonModal();
});

reasonForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const reason = reasonInput.value.trim();
  if (!reason) {
    reasonError.textContent = "A reason is required.";
    reasonError.hidden = false;
    return;
  }
  const confirmCallback = pendingReasonConfirm;
  closeReasonModal();
  confirmCallback?.(reason);
});

async function setApplicationStatus(course, app, status, name, reasons = {}) {
  const { rejectionReason, approvalReason } = reasons;
  const previousStatus = (app.status || "pending").toLowerCase();
  try {
    const res = await fetch(`/api/tutor-applications/${app.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, rejectionReason, approvalReason }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that application.");
      return;
    }
    const messages = {
      approved: `${name} assigned to ${course.code}`,
      rejected: `${name}'s application rejected`,
      pending: `${name} moved back to pending`,
    };
    showToast(messages[status] || "Application updated.");

    // Update the pending badge locally instead of re-fetching every
    // course's applications again just to recompute one count.
    const wasPending = previousStatus === "pending";
    const isPending = status === "pending";
    if (wasPending !== isPending) {
      const current = pendingApplicationCounts[course.id] || 0;
      pendingApplicationCounts[course.id] = Math.max(
        0,
        current + (isPending ? 1 : -1),
      );
    }

    await fetchCourses();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

async function setApplicationLock(course, app, name) {
  try {
    const res = await fetch(`/api/tutor-applications/${app.id}/lock`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked: true }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't lock that assignment.");
      return;
    }
    showToast(`${name}'s assignment to ${course.code} is now locked.`);
    await fetchCourses();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

// ---------- override modal ----------

let pendingOverride = null; // { course, app, name } for whichever row opened the modal

const overrideModal = document.getElementById("overrideModal");
const overrideForm = document.getElementById("overrideForm");
const overrideFormError = document.getElementById("overrideFormError");
const overrideModalContext = document.getElementById("overrideModalContext");
const overrideReasonInput = document.getElementById("overrideReasonInput");
const overrideSubmitBtn = document.getElementById("overrideSubmitBtn");

function openOverrideModal(course, app, name, blockReason) {
  pendingOverride = { course, app, name };
  overrideForm.reset();
  overrideFormError.hidden = true;
  overrideModalContext.textContent = `${blockReason}. Approving ${name} for ${course.code} anyway will be recorded against your account with the reason below.`;
  overrideModal.showModal();
  overrideReasonInput.focus();
}

function closeOverrideModal() {
  overrideModal.close();
  pendingOverride = null;
}

document
  .getElementById("overrideModalCloseBtn")
  .addEventListener("click", closeOverrideModal);
document
  .getElementById("overrideCancelBtn")
  .addEventListener("click", closeOverrideModal);
overrideModal.addEventListener("click", (e) => {
  if (e.target === overrideModal) closeOverrideModal();
});

overrideForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  overrideFormError.hidden = true;
  if (!pendingOverride) return;

  const { course, app, name } = pendingOverride;
  const reason = overrideReasonInput.value.trim();

  overrideSubmitBtn.disabled = true;
  overrideSubmitBtn.textContent = "Approving…";

  try {
    const res = await fetch(`/api/tutor-applications/${app.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "approved",
        override: true,
        organiserId: getSessionUserId(),
        reason,
      }),
    });
    const body = await res.json();

    if (!res.ok) {
      overrideFormError.textContent =
        body.error || "Couldn't override that rule.";
      overrideFormError.hidden = false;
      return;
    }

    closeOverrideModal();
    showToast(`${name} approved for ${course.code} (override recorded)`);
    await fetchCourses();
  } catch (err) {
    overrideFormError.textContent =
      "Network error — couldn't reach the server.";
    overrideFormError.hidden = false;
  } finally {
    overrideSubmitBtn.disabled = false;
    overrideSubmitBtn.textContent = "Approve with override";
  }
});

// ---------- session excusals ----------

const excusalListEl = document.getElementById("excusalList");
const excusalsEmptyEl = document.getElementById("excusalsEmpty");

let excusalsRequestId = 0;
let lastExcusalsSnapshot = null;

async function renderExcusals(course) {
  const requestId = ++excusalsRequestId;

  let rows = [];
  try {
    const res = await fetch(`/api/session-excusals?courseId=${course.id}`);
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load excusals");
  } catch (err) {
    if (requestId === excusalsRequestId)
      showToast("Couldn't load session excusals for this course.");
    return;
  }

  if (requestId !== excusalsRequestId) return;

  const snapshot = `${course.id}:${JSON.stringify(rows)}`;
  if (snapshot === lastExcusalsSnapshot) return;
  lastExcusalsSnapshot = snapshot;

  excusalListEl.innerHTML = "";
  excusalsEmptyEl.hidden = true;

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter((e) => e.session_date >= today);

  if (upcoming.length === 0) {
    excusalsEmptyEl.hidden = false;
    return;
  }

  upcoming.forEach((excusal) => {
    const name = excusal.tutors?.name || "Unknown";

    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tutor-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="avatar">${initials(name)}</span>
      <span class="name-block">
        <span class="name">${name}</span>
        <span class="role">${excusal.session_date}${excusal.reason ? ` — ${excusal.reason}` : ""}</span>
      </span>
    `;

    li.appendChild(row);
    excusalListEl.appendChild(li);
  });
}

// ---------- volunteers ----------

const volunteerListEl = document.getElementById("volunteerList");
const volunteersEmptyEl = document.getElementById("volunteersEmpty");

let volunteersRequestId = 0;
let lastVolunteersSnapshot = null;

async function renderVolunteers(course) {
  const requestId = ++volunteersRequestId;

  let rows = [];
  try {
    const res = await fetch(`/api/course-volunteers?courseId=${course.id}`);
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load volunteers");
  } catch (err) {
    if (requestId === volunteersRequestId)
      showToast("Couldn't load volunteers for this course.");
    return;
  }

  // the active course may have changed while this request was in flight
  if (requestId !== volunteersRequestId) return;

  const snapshot = `${course.id}:${JSON.stringify(rows)}`;
  if (snapshot === lastVolunteersSnapshot) return;
  lastVolunteersSnapshot = snapshot;

  volunteerListEl.innerHTML = "";
  volunteersEmptyEl.hidden = true;

  if (rows.length === 0) {
    volunteersEmptyEl.hidden = false;
    return;
  }

  rows.forEach((vol) => {
    const student = vol.users;
    const status = (vol.status || "pending").toLowerCase();
    const isOpenSession = status === "open";
    const name = isOpenSession
      ? "Open — unclaimed"
      : student?.name || "Unknown";

    let detailStamp = "";
    if (typeof vol.mark === "number") {
      detailStamp = `<span class="stamp ok">Mark ${vol.mark}</span>`;
    } else if (vol.session_date) {
      const [y, m, d] = vol.session_date.split("-");
      const time = `${vol.start_time?.slice(0, 5)}–${vol.end_time?.slice(0, 5)}`;
      const venue = vol.venue ? ` · ${vol.venue}` : "";
      detailStamp = `<span class="stamp">${d}/${m}/${y} · ${time}${venue}</span>`;
    }

    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tutor-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="avatar">${initials(name)}</span>
      <span class="name-block">
        <span class="name">${name}</span>
        <span class="role">${student?.email || ""}</span>
      </span>
      <span class="stamp-row">
        ${detailStamp}
      </span>
      <span class="status-pill ${status}">${status}</span>
      <span class="applicant-actions"></span>
    `;

    const actionsEl = row.querySelector(".applicant-actions");

    if (status === "pending") {
      actionsEl.appendChild(
        makeApplicantActionBtn("Approve", "approve", () =>
          openReasonModal(
            `Approve ${name} for ${course.code}?`,
            "Approve with this note",
            (reason) =>
              setVolunteerStatus(course, vol, "approved", name, {
                approvalReason: reason,
              }),
            "e.g. Mark comfortably above the course minimum.",
          ),
        ),
      );
      actionsEl.appendChild(
        makeApplicantActionBtn("Reject", "", () =>
          openReasonModal(
            `Reject ${name}'s volunteer request?`,
            "Reject with this reason",
            (reason) =>
              setVolunteerStatus(course, vol, "rejected", name, {
                rejectionReason: reason,
              }),
          ),
        ),
      );
    } else if (status === "approved") {
      if (vol.locked) {
        const lockedStamp = document.createElement("span");
        lockedStamp.className = "stamp";
        lockedStamp.textContent = "Locked";
        actionsEl.appendChild(lockedStamp);
      } else {
        actionsEl.appendChild(
          makeApplicantActionBtn("Reconsider", "", () =>
            setVolunteerStatus(course, vol, "pending", name),
          ),
        );
        actionsEl.appendChild(
          makeApplicantActionBtn("Lock", "", () => {
            if (
              !confirm(
                `Lock ${name}'s approval for ${course.code}? This is permanent — it can't be undone or reconsidered afterwards.`,
              )
            ) {
              return;
            }
            setVolunteerLock(course, vol, name);
          }),
        );
      }
    } else if (!isOpenSession) {
      actionsEl.appendChild(
        makeApplicantActionBtn("Reconsider", "", () =>
          setVolunteerStatus(course, vol, "pending", name),
        ),
      );
    }

    li.appendChild(row);
    volunteerListEl.appendChild(li);
  });
}

async function setVolunteerStatus(course, vol, status, name, reasons = {}) {
  const { rejectionReason, approvalReason } = reasons;
  const previousStatus = (vol.status || "pending").toLowerCase();
  try {
    const res = await fetch(`/api/course-volunteers/${vol.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status,
        rejectionReason,
        approvalReason,
        organiserId: getSessionUserId(),
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that volunteer.");
      return;
    }
    const messages = {
      approved: `${name} approved for ${course.code}`,
      rejected: `${name}'s volunteer request rejected`,
      pending: `${name} moved back to pending`,
    };
    showToast(messages[status] || "Volunteer updated.");

    const wasPending = previousStatus === "pending";
    const isPending = status === "pending";
    if (wasPending !== isPending) {
      const current = pendingVolunteerCounts[course.id] || 0;
      pendingVolunteerCounts[course.id] = Math.max(
        0,
        current + (isPending ? 1 : -1),
      );
    }

    renderVolunteers(course);
    fetchVolunteerCounts();
    // Approving/un-approving a volunteer now changes the course's
    // assigned-tutor count too (see courseVolunteers.js), so the shortfall/
    // staffed pill needs a real re-fetch, not just a re-render of the stale
    // in-memory COURSES array.
    await fetchCourses();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

async function setVolunteerLock(course, vol, name) {
  try {
    const res = await fetch(`/api/course-volunteers/${vol.id}/lock`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked: true }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't lock that volunteer.");
      return;
    }
    showToast(`${name}'s approval for ${course.code} is now locked.`);
    renderVolunteers(course);
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

let lastAssignmentCardSnapshot = null;

// ---------- post overflow session modal ----------

let pendingOverflowCourse = null;

const postOverflowSessionBtn = document.getElementById(
  "postOverflowSessionBtn",
);
const postOverflowSessionModal = document.getElementById(
  "postOverflowSessionModal",
);
const postOverflowSessionForm = document.getElementById(
  "postOverflowSessionForm",
);
const postOverflowSessionFormError = document.getElementById(
  "postOverflowSessionFormError",
);
const postOverflowSessionModalContext = document.getElementById(
  "postOverflowSessionModalContext",
);
const overflowSessionDateInput = document.getElementById(
  "overflowSessionDateInput",
);
const overflowSessionStartInput = document.getElementById(
  "overflowSessionStartInput",
);
const overflowSessionEndInput = document.getElementById(
  "overflowSessionEndInput",
);
const overflowSessionVenueInput = document.getElementById(
  "overflowSessionVenueInput",
);
const overflowSessionReasonInput = document.getElementById(
  "overflowSessionReasonInput",
);
const postOverflowSessionSubmitBtn = document.getElementById(
  "postOverflowSessionSubmitBtn",
);

function openPostOverflowSessionModal() {
  const course = COURSES.find((c) => c.id === activeCourseId);
  if (!course) return;
  pendingOverflowCourse = course;
  postOverflowSessionForm.reset();
  postOverflowSessionFormError.hidden = true;
  postOverflowSessionModalContext.textContent = `Post a specific gap in ${course.code} for a volunteer to claim — a regular slot with nobody to cover it, not a standing weekly commitment.`;
  postOverflowSessionModal.showModal();
  overflowSessionDateInput.focus();
}

function closePostOverflowSessionModal() {
  postOverflowSessionModal.close();
  pendingOverflowCourse = null;
}

postOverflowSessionBtn.addEventListener("click", openPostOverflowSessionModal);
document
  .getElementById("postOverflowSessionModalCloseBtn")
  .addEventListener("click", closePostOverflowSessionModal);
document
  .getElementById("postOverflowSessionCancelBtn")
  .addEventListener("click", closePostOverflowSessionModal);
postOverflowSessionModal.addEventListener("click", (e) => {
  if (e.target === postOverflowSessionModal) closePostOverflowSessionModal();
});

postOverflowSessionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  postOverflowSessionFormError.hidden = true;
  if (!pendingOverflowCourse) return;

  const course = pendingOverflowCourse;
  const sessionDate = overflowSessionDateInput.value;
  const startTime = overflowSessionStartInput.value;
  const endTime = overflowSessionEndInput.value;

  if (endTime <= startTime) {
    postOverflowSessionFormError.textContent =
      "End time must be after start time.";
    postOverflowSessionFormError.hidden = false;
    return;
  }

  postOverflowSessionSubmitBtn.disabled = true;
  postOverflowSessionSubmitBtn.textContent = "Posting…";
  try {
    const res = await fetch("/api/course-volunteers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: course.id,
        sessionDate,
        startTime,
        endTime,
        venue: overflowSessionVenueInput.value.trim(),
        reason: overflowSessionReasonInput.value.trim(),
        organiserId: getSessionUserId(),
      }),
    });
    const body = await res.json();

    if (!res.ok) {
      postOverflowSessionFormError.textContent =
        body.error || "Couldn't post that session.";
      postOverflowSessionFormError.hidden = false;
      return;
    }

    closePostOverflowSessionModal();
    showToast(`Posted a ${course.code} session for volunteers to claim`);
    renderVolunteers(course);
  } catch (err) {
    postOverflowSessionFormError.textContent =
      "Network error — couldn't reach the server.";
    postOverflowSessionFormError.hidden = false;
  } finally {
    postOverflowSessionSubmitBtn.disabled = false;
    postOverflowSessionSubmitBtn.textContent = "Post session";
  }
});

function renderAssignmentCard(course) {
  const isFull =
    !!course.tutorsNeeded && course.tutorsAssigned >= course.tutorsNeeded;
  const className =
    "assignment-card " + (course.tutorsAssigned > 0 ? "filled" : "empty");
  const html = isFull
    ? `<p class="empty-copy">This course is fully staffed — ${course.tutorsAssigned} of ${course.tutorsNeeded} tutor spots filled.</p>`
    : `<p class="empty-copy">${course.tutorsAssigned} of ${course.tutorsNeeded ?? "—"} tutor spots filled. Approve an applicant below to fill the rest.</p>`;

  const snapshot = `${course.id}:${className}:${html}`;
  if (snapshot === lastAssignmentCardSnapshot) return;
  lastAssignmentCardSnapshot = snapshot;

  assignmentCardEl.className = className;
  assignmentCardEl.innerHTML = html;
}

// ---------- bulk-fill obvious assignments ----------

const obviousFillBtn = document.getElementById("obviousFillBtn");
const obviousFillModal = document.getElementById("obviousFillModal");
const obviousFillList = document.getElementById("obviousFillList");
const obviousFillEmpty = document.getElementById("obviousFillEmpty");
const obviousFillHint = document.getElementById("obviousFillHint");
const obviousFillConfirmBtn = document.getElementById("obviousFillConfirmBtn");

function closeObviousFillModal() {
  obviousFillModal.close();
}

async function openObviousFillModal() {
  obviousFillList.innerHTML = "";
  obviousFillEmpty.hidden = true;
  obviousFillHint.textContent = "Loading…";
  obviousFillConfirmBtn.hidden = false;
  obviousFillConfirmBtn.disabled = true;
  obviousFillModal.showModal();

  let groups = [];
  try {
    const res = await fetch("/api/tutor-applications/obvious-fill");
    groups = await res.json();
    if (!res.ok)
      throw new Error(groups.error || "Failed to load obvious fills");
  } catch (err) {
    obviousFillHint.textContent = "Couldn't load obvious fills — try again.";
    return;
  }

  const totalApplications = groups.reduce(
    (sum, g) => sum + g.applications.length,
    0,
  );

  if (totalApplications === 0) {
    obviousFillHint.textContent = "";
    obviousFillEmpty.hidden = false;
    obviousFillConfirmBtn.hidden = true;
    return;
  }

  obviousFillHint.textContent = `${totalApplications} application${totalApplications === 1 ? "" : "s"} across ${groups.length} course${groups.length === 1 ? "" : "s"} can be filled without any judgment call — uncheck anything you'd rather decide yourself.`;

  groups.forEach((group) => {
    const heading = document.createElement("li");
    heading.className = "obvious-fill-course-head";
    heading.textContent = `${group.course.code} — ${group.course.name}`;
    obviousFillList.appendChild(heading);

    group.applications.forEach((app) => {
      const li = document.createElement("li");
      const row = document.createElement("label");
      row.className = "tutor-row";
      row.style.cursor = "pointer";
      row.innerHTML = `
        <input type="checkbox" class="obvious-fill-check" data-id="${app.id}" checked>
        <span class="name-block">
          <span class="name">${app.tutorName || "Unknown"}</span>
        </span>
        <span class="stamp-row">
          <span class="stamp ok">Mark ${app.mark}</span>
        </span>
      `;
      li.appendChild(row);
      obviousFillList.appendChild(li);
    });
  });

  obviousFillConfirmBtn.disabled = false;
}

obviousFillBtn.addEventListener("click", openObviousFillModal);
document
  .getElementById("obviousFillCloseBtn")
  .addEventListener("click", closeObviousFillModal);
document
  .getElementById("obviousFillCancelBtn")
  .addEventListener("click", closeObviousFillModal);
obviousFillModal.addEventListener("click", (e) => {
  if (e.target === obviousFillModal) closeObviousFillModal();
});

obviousFillConfirmBtn.addEventListener("click", async () => {
  const ids = Array.from(
    obviousFillList.querySelectorAll(".obvious-fill-check:checked"),
  ).map((cb) => cb.dataset.id);

  if (ids.length === 0) {
    closeObviousFillModal();
    return;
  }

  obviousFillConfirmBtn.disabled = true;
  obviousFillConfirmBtn.textContent = "Approving…";

  try {
    const res = await fetch("/api/tutor-applications/bulk-approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationIds: ids }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't fill those assignments.");
      return;
    }
    const failed = body.results.filter((r) => !r.success);
    const succeeded = body.results.length - failed.length;
    showToast(
      failed.length === 0
        ? `${succeeded} assignment${succeeded === 1 ? "" : "s"} filled.`
        : `${succeeded} filled, ${failed.length} couldn't be — something changed since you opened this.`,
    );
    closeObviousFillModal();
    await fetchCourses();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  } finally {
    obviousFillConfirmBtn.disabled = false;
    obviousFillConfirmBtn.textContent = "Approve selected";
  }
});

// ---------- auto-allocate whole school ----------
//
// Same reviewable-list shape as Obvious Fill, but backed by a real draft:
// opening the modal calls auto-allocate to propose assignments for every
// course in one pass (unambiguous slots picked outright, ambiguous ones
// ranked by mark), and Publish applies only the still-checked rows. The
// draft itself already exists in allocation_drafts the moment the modal
// opens — cancelling just leaves it unpublished, nothing to clean up.

const autoAllocateBtn = document.getElementById("autoAllocateBtn");
const autoAllocateModal = document.getElementById("autoAllocateModal");
const autoAllocateList = document.getElementById("autoAllocateList");
const autoAllocateEmpty = document.getElementById("autoAllocateEmpty");
const autoAllocateHint = document.getElementById("autoAllocateHint");
const autoAllocatePublishBtn = document.getElementById(
  "autoAllocatePublishBtn",
);

let activeAutoAllocateDraftId = null;

function closeAutoAllocateModal() {
  autoAllocateModal.close();
}

async function openAutoAllocateModal() {
  activeAutoAllocateDraftId = null;
  autoAllocateList.innerHTML = "";
  autoAllocateEmpty.hidden = true;
  autoAllocateHint.textContent = "Proposing assignments…";
  autoAllocatePublishBtn.hidden = false;
  autoAllocatePublishBtn.disabled = true;
  autoAllocateModal.showModal();

  let draft, assignments, skipped;
  try {
    const res = await fetch("/api/allocation-drafts/auto-allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organiserId: getSessionUserId() }),
    });
    const body = await res.json();
    if (!res.ok)
      throw new Error(body.error || "Failed to propose an allocation");
    ({ draft, assignments, skipped } = body);
  } catch (err) {
    autoAllocateHint.textContent =
      "Couldn't propose an allocation — try again.";
    autoAllocatePublishBtn.hidden = true;
    return;
  }

  if (!draft || assignments.length === 0) {
    autoAllocateHint.textContent = "";
    autoAllocateEmpty.hidden = false;
    autoAllocatePublishBtn.hidden = true;
    renderSkippedCandidates(skipped);
    return;
  }

  activeAutoAllocateDraftId = draft.id;
  autoAllocateHint.textContent = `${assignments.length} assignment${assignments.length === 1 ? "" : "s"} proposed across every course with an open slot — uncheck anything you'd rather decide yourself.`;

  const byCourse = new Map();
  assignments.forEach((a) => {
    const key = a.course?.course_code || String(a.course_id);
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key).push(a);
  });

  byCourse.forEach((group, courseKey) => {
    const heading = document.createElement("li");
    heading.className = "obvious-fill-course-head";
    heading.textContent = `${courseKey} — ${group[0].course?.course_name || ""}`;
    autoAllocateList.appendChild(heading);

    group.forEach((assignment) => {
      const li = document.createElement("li");
      const row = document.createElement("label");
      row.className = "tutor-row";
      row.style.cursor = "pointer";
      row.innerHTML = `
        <input type="checkbox" class="auto-allocate-check" data-id="${assignment.id}" checked>
        <span class="name-block">
          <span class="name">${assignment.tutor?.name || "Unknown"}</span>
          <span class="role">${assignment.explanation}</span>
        </span>
      `;
      li.appendChild(row);
      autoAllocateList.appendChild(li);
    });
  });

  renderSkippedCandidates(skipped);

  autoAllocatePublishBtn.disabled = false;
}

// Every eligible-but-not-proposed applicant (locked, over the tutor's hour
// cap, or simply outranked for a slot) is still shown here — not as
// something to publish, just so the organiser can see why they didn't make
// the cut instead of the run looking like it silently ignored them.
function renderSkippedCandidates(skipped) {
  if (!skipped || skipped.length === 0) return;

  const heading = document.createElement("li");
  heading.className = "obvious-fill-course-head";
  heading.textContent = "Not proposed";
  autoAllocateList.appendChild(heading);

  skipped.forEach((skip) => {
    const course = COURSES.find((c) => c.id === skip.courseId);
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tutor-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="name-block">
        <span class="name">${skip.tutorName || "Unknown"} &mdash; ${course?.code || `course ${skip.courseId}`}</span>
        <span class="role">${skip.reason}</span>
      </span>
    `;
    li.appendChild(row);
    autoAllocateList.appendChild(li);
  });
}

autoAllocateBtn.addEventListener("click", openAutoAllocateModal);
document
  .getElementById("autoAllocateCloseBtn")
  .addEventListener("click", closeAutoAllocateModal);
document
  .getElementById("autoAllocateCancelBtn")
  .addEventListener("click", closeAutoAllocateModal);
autoAllocateModal.addEventListener("click", (e) => {
  if (e.target === autoAllocateModal) closeAutoAllocateModal();
});

autoAllocatePublishBtn.addEventListener("click", async () => {
  if (!activeAutoAllocateDraftId) {
    closeAutoAllocateModal();
    return;
  }

  const allChecks = Array.from(
    autoAllocateList.querySelectorAll(".auto-allocate-check"),
  );
  const excludeAssignmentIds = allChecks
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.id);

  if (excludeAssignmentIds.length === allChecks.length) {
    closeAutoAllocateModal();
    return;
  }

  autoAllocatePublishBtn.disabled = true;
  autoAllocatePublishBtn.textContent = "Publishing…";

  try {
    const res = await fetch(
      `/api/allocation-drafts/${activeAutoAllocateDraftId}/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organiserId: getSessionUserId(),
          excludeAssignmentIds,
        }),
      },
    );
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't publish that allocation.");
      return;
    }
    const failed = body.results.filter((r) => !r.success);
    const succeeded = body.results.length - failed.length;
    showToast(
      failed.length === 0
        ? `${succeeded} assignment${succeeded === 1 ? "" : "s"} published.`
        : `${succeeded} published, ${failed.length} couldn't be — something changed since you opened this. See History for details.`,
    );
    closeAutoAllocateModal();
    await fetchCourses();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  } finally {
    autoAllocatePublishBtn.disabled = false;
    autoAllocatePublishBtn.textContent = "Publish selected";
  }
});

// ---------- add / edit course modal ----------

const addCourseBtn = document.getElementById("addCourseBtn");
const editCourseBtn = document.getElementById("editCourseBtn");
const deleteCourseBtn = document.getElementById("deleteCourseBtn");
const deleteCourseModal = document.getElementById("deleteCourseModal");
const deleteCourseMessage = document.getElementById("deleteCourseMessage");
const deleteCourseError = document.getElementById("deleteCourseError");
const deleteCourseConfirmBtn = document.getElementById(
  "deleteCourseConfirmBtn",
);

let deletingCourseId = null;

function openDeleteCourseModal(course) {
  deletingCourseId = course.id;
  deleteCourseError.hidden = true;
  deleteCourseMessage.textContent = `Delete ${course.code} — ${course.name}? This can't be undone.`;
  deleteCourseModal.showModal();
}

function closeDeleteCourseModal() {
  deleteCourseModal.close();
  deletingCourseId = null;
}
const addCourseModal = document.getElementById("addCourseModal");
const addCourseForm = document.getElementById("addCourseForm");
const addCourseError = document.getElementById("addCourseError");
const addCourseSubmitBtn = document.getElementById("addCourseSubmitBtn");
const addCourseHeading = document.getElementById("addCourseHeading");
const courseClashWarningEl = document.getElementById("courseClashWarning");

const venuesInput = document.getElementById("venuesInput");
const labVenuesInput = document.getElementById("labVenuesInput");
const hasTutorialInput = document.getElementById("hasTutorialInput");
const hasLabInput = document.getElementById("hasLabInput");
const tutorialFieldsEl = document.getElementById("tutorialFields");
const labFieldsEl = document.getElementById("labFields");

let editingCourseId = null; // null = adding a new course, otherwise id of course being edited

function setFieldsRequired(ids, required) {
  ids.forEach((id) => {
    document.getElementById(id).required = required;
  });
}

const TUTORIAL_FIELD_IDS = [
  "dayOfTutInput",
  "tutorStartTimeInput",
  "tutorEndTimeInput",
  "venuesInput",
];
const LAB_FIELD_IDS = [
  "dayOfLabInput",
  "labStartTimeInput",
  "labEndTimeInput",
  "labVenuesInput",
];

function updateTutorialVisibility() {
  const checked = hasTutorialInput.checked;
  tutorialFieldsEl.hidden = !checked;
  setFieldsRequired(TUTORIAL_FIELD_IDS, checked);
  checkModalClashes();
}

function updateLabVisibility() {
  const checked = hasLabInput.checked;
  labFieldsEl.hidden = !checked;
  setFieldsRequired(LAB_FIELD_IDS, checked);
  checkModalClashes();
}

hasTutorialInput.addEventListener("change", updateTutorialVisibility);
hasLabInput.addEventListener("change", updateLabVisibility);

function openCourseModal(course = null) {
  editingCourseId = course ? course.id : null;
  addCourseForm.reset();
  addCourseError.hidden = true;
  courseClashWarningEl.hidden = true;

  addCourseHeading.textContent = course ? "Edit course" : "Add a course";
  addCourseSubmitBtn.textContent = course ? "Save changes" : "Add course";

  if (course) {
    document.getElementById("courseCodeInput").value = course.code;
    document.getElementById("courseNameInput").value = course.name;
    document.getElementById("minMarkInput").value = course.minMark;
    document.getElementById("courseLevelInput").value =
      COURSE_LEVEL_LABELS[course.courseLevel] ?? "";
    document.getElementById("departmentInput").value = course.department ?? "";
    document.getElementById("hoursPerWeekInput").value =
      course.hoursNeeded ?? "";
    document.getElementById("TutorsNeededInput").value =
      course.tutorsNeeded ?? "";
    document.getElementById("budgetInput").value = course.budget ?? "";

    document.getElementById("dayOfTutInput").value = course.dayOfTut ?? "";
    document.getElementById("tutorStartTimeInput").value = course.startTime
      ? course.startTime.slice(0, 5)
      : "";
    document.getElementById("tutorEndTimeInput").value = course.endTime
      ? course.endTime.slice(0, 5)
      : "";
    venuesInput.value = course.venues ?? "";
    hasTutorialInput.checked = !!(course.dayOfTut || course.venues);

    document.getElementById("dayOfLabInput").value = course.dayOfLab ?? "";
    document.getElementById("labStartTimeInput").value = course.labStartTime
      ? course.labStartTime.slice(0, 5)
      : "";
    document.getElementById("labEndTimeInput").value = course.labEndTime
      ? course.labEndTime.slice(0, 5)
      : "";
    labVenuesInput.value = course.labVenues ?? "";
    hasLabInput.checked = !!(course.dayOfLab || course.labVenues);
  } else {
    hasTutorialInput.checked = false;
    hasLabInput.checked = false;
  }

  updateTutorialVisibility();
  updateLabVisibility();

  addCourseModal.showModal();
  document.getElementById("courseCodeInput").focus();
}

// Live venue-clash preview while editing a course's Tutorial/Lab times —
// purely client-side against the already-loaded COURSES list, so it updates
// instantly as the organiser types. Checks each checked session against
// every other course's sessions, and (if both are checked) this course's
// own Tutorial against its own Lab. Disables the submit button while a
// problem shows; the server re-checks on submit regardless as the source
// of truth.
function readModalSession(checked, dayId, startId, endId, venueInput) {
  if (!checked) return null;
  return {
    day: document.getElementById(dayId).value.trim(),
    start: document.getElementById(startId).value,
    end: document.getElementById(endId).value,
    venue: venueInput.value.trim(),
  };
}

function clashMessage(type, session, other) {
  const shared = sharedVenues(session.venue, other.venue).join(", ");
  return `${type} clash: ${shared} is already booked for ${other.courseCode} ${other.type} (${other.day} ${other.start}–${other.end}).`;
}

function checkModalClashes() {
  const tutorialSession = readModalSession(
    hasTutorialInput.checked,
    "dayOfTutInput",
    "tutorStartTimeInput",
    "tutorEndTimeInput",
    venuesInput,
  );
  const labSession = readModalSession(
    hasLabInput.checked,
    "dayOfLabInput",
    "labStartTimeInput",
    "labEndTimeInput",
    labVenuesInput,
  );

  const problems = [];

  if (tutorialSession) {
    findVenueClashes(tutorialSession, editingCourseId, "Tutorial").forEach(
      (c) => problems.push(clashMessage("Tutorial", tutorialSession, c)),
    );
  }
  if (labSession) {
    findVenueClashes(labSession, editingCourseId, "Lab").forEach((c) =>
      problems.push(clashMessage("Lab", labSession, c)),
    );
  }
  if (
    tutorialSession &&
    labSession &&
    sessionsClash(tutorialSession, labSession)
  ) {
    const shared = sharedVenues(tutorialSession.venue, labSession.venue).join(
      ", ",
    );
    problems.push(
      `This course's own Tutorial and Lab overlap each other (${shared}, ${tutorialSession.day}).`,
    );
  }

  if (problems.length === 0) {
    courseClashWarningEl.hidden = true;
    addCourseSubmitBtn.disabled = false;
    return;
  }

  courseClashWarningEl.textContent = `⚠ ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more issue${problems.length > 2 ? "s" : ""})` : ""}`;
  courseClashWarningEl.hidden = false;
  addCourseSubmitBtn.disabled = true;
}

[
  "dayOfTutInput",
  "tutorStartTimeInput",
  "tutorEndTimeInput",
  "venuesInput",
  "dayOfLabInput",
  "labStartTimeInput",
  "labEndTimeInput",
  "labVenuesInput",
].forEach((id) => {
  document.getElementById(id).addEventListener("input", checkModalClashes);
});

function closeCourseModal() {
  addCourseModal.close();
}

addCourseBtn.addEventListener("click", () => openCourseModal());
editCourseBtn.addEventListener("click", () => {
  const course = COURSES.find((c) => c.id === activeCourseId);
  if (course) openCourseModal(course);
});
deleteCourseBtn.addEventListener("click", () => {
  const course = COURSES.find((c) => c.id === activeCourseId);
  if (course) openDeleteCourseModal(course);
});

deleteCourseConfirmBtn.addEventListener("click", async () => {
  if (deletingCourseId === null) return;

  deleteCourseError.hidden = true;
  deleteCourseConfirmBtn.disabled = true;
  deleteCourseConfirmBtn.textContent = "Deleting…";

  try {
    const res = await fetch(`/api/courses/${deletingCourseId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      deleteCourseError.textContent =
        body.error || "Couldn't delete that course.";
      deleteCourseError.hidden = false;
      return;
    }
    closeDeleteCourseModal();
    activeCourseId = null;
    await fetchCourses();
  } catch (err) {
    deleteCourseError.textContent =
      "Network error — couldn't reach the server.";
    deleteCourseError.hidden = false;
  } finally {
    deleteCourseConfirmBtn.disabled = false;
    deleteCourseConfirmBtn.textContent = "Delete course";
  }
});

document
  .getElementById("deleteCourseCloseBtn")
  .addEventListener("click", closeDeleteCourseModal);
document
  .getElementById("deleteCourseCancelBtn")
  .addEventListener("click", closeDeleteCourseModal);
deleteCourseModal.addEventListener("click", (e) => {
  if (e.target === deleteCourseModal) closeDeleteCourseModal();
});
document
  .getElementById("addCourseCloseBtn")
  .addEventListener("click", closeCourseModal);
document
  .getElementById("addCourseCancelBtn")
  .addEventListener("click", closeCourseModal);

addCourseModal.addEventListener("click", (e) => {
  if (e.target === addCourseModal) closeCourseModal();
});

addCourseForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  addCourseError.hidden = true;

  const hoursValue = document.getElementById("hoursPerWeekInput").value;
  const tutorsNeededValue = document.getElementById("TutorsNeededInput").value;
  const budgetValue = document.getElementById("budgetInput").value;

  const tutorialChecked = hasTutorialInput.checked;
  const labChecked = hasLabInput.checked;

  const dayOfTutValue = document.getElementById("dayOfTutInput").value.trim();
  const startTimeValue = document.getElementById("tutorStartTimeInput").value;
  const endTimeValue = document.getElementById("tutorEndTimeInput").value;

  const dayOfLabValue = document.getElementById("dayOfLabInput").value.trim();
  const labStartTimeValue = document.getElementById("labStartTimeInput").value;
  const labEndTimeValue = document.getElementById("labEndTimeInput").value;

  const payload = {
    course_code: document.getElementById("courseCodeInput").value.trim(),
    course_name: document.getElementById("courseNameInput").value.trim(),
    min_mark: Number(document.getElementById("minMarkInput").value),
    course_level: document.getElementById("courseLevelInput").value,
    department: document.getElementById("departmentInput").value.trim(),
    hours_per_week: hoursValue === "" ? null : Number(hoursValue),
    tutors_needed: tutorsNeededValue === "" ? null : Number(tutorsNeededValue),
    budget: budgetValue === "" ? null : Number(budgetValue),
    has_tutorial: tutorialChecked,
    day_of_tut: tutorialChecked && dayOfTutValue !== "" ? dayOfTutValue : null,
    tutor_start_time:
      tutorialChecked && startTimeValue !== "" ? startTimeValue : null,
    tutor_end_time:
      tutorialChecked && endTimeValue !== "" ? endTimeValue : null,
    venues: tutorialChecked ? venuesInput.value.trim() || null : null,
    has_lab: labChecked,
    day_of_lab: labChecked && dayOfLabValue !== "" ? dayOfLabValue : null,
    lab_start_time:
      labChecked && labStartTimeValue !== "" ? labStartTimeValue : null,
    lab_end_time: labChecked && labEndTimeValue !== "" ? labEndTimeValue : null,
    lab_venues: labChecked ? labVenuesInput.value.trim() || null : null,
  };

  const isEditing = editingCourseId !== null;
  addCourseSubmitBtn.disabled = true;
  addCourseSubmitBtn.textContent = isEditing ? "Saving…" : "Adding…";

  try {
    const res = await fetch(
      isEditing ? `/api/courses/${editingCourseId}` : "/api/courses",
      {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const body = await res.json();

    if (!res.ok) {
      addCourseError.textContent = body.error || "Couldn't save that course.";
      addCourseError.hidden = false;
      return;
    }

    closeCourseModal();
    showToast(
      isEditing
        ? `${body.course_code} updated.`
        : `${body.course_code} added to the course register.`,
    );
    await fetchCourses();
  } catch (err) {
    addCourseError.textContent = "Network error — couldn't reach the server.";
    addCourseError.hidden = false;
  } finally {
    addCourseSubmitBtn.disabled = false;
    addCourseSubmitBtn.textContent = isEditing ? "Save changes" : "Add course";
  }
});

// ---------- toast ----------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- search wiring ----------

courseSearchEl.addEventListener("input", renderCourseList);
shortfallToggleEl.addEventListener("change", () => {
  shortfallOnly = shortfallToggleEl.checked;
  renderCourseList();
});

// "/" jumps to the course search from anywhere on the page, unless the
// organiser is already typing into a field (so it doesn't hijack real input).
document.addEventListener("keydown", (event) => {
  if (event.key !== "/") return;
  if (isTypingInField()) return;
  event.preventDefault();
  courseSearchEl.focus();
});

// ---------- misc ----------

// prevent accidental scroll-to-change on number fields (min mark / hours per week)
document.querySelectorAll('input[type="number"]').forEach((el) => {
  el.addEventListener("wheel", () => el.blur(), { passive: true });
});

// ---------- guided tour ----------

// board.js has no login/session guard of its own today, so this reads the
// same sessionStorage "user" key storage.js's getCurrentUser() uses,
// rather than assuming a currentUser variable exists here.
function getSessionUserId() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw).id : "anon";
  } catch {
    return "anon";
  }
}

const ORGANISER_TOUR_STEPS = [
  {
    selector: ".header-right",
    title: "Your snapshot",
    body: "At a glance: how many courses are fully staffed, how many tutors are on the roll, and how many applications or volunteers still need a decision.",
    placement: "bottom",
  },
  {
    selector: "#statPending",
    title: "Needs review",
    body: 'This counts every pending tutor application and student volunteer across all courses. Courses with something waiting also get a "to review" badge in the list on the left.',
    placement: "bottom",
  },
  {
    selector: "#courseSearch",
    title: "Find a course",
    body: "Search by course code or name to jump straight to it.",
    placement: "bottom",
  },
  {
    selector: ".shortfall-toggle",
    title: "Spot the gaps",
    body: "Toggle this to show only short-staffed courses, worst shortfall first — handy when you're trying to close gaps quickly.",
    placement: "bottom",
  },
  {
    selector: "#addCourseBtn",
    title: "Add a course",
    body: "New course to staff? Add it here with its code, department, hours needed, and session time.",
    placement: "bottom",
  },
  {
    selector: "#courseList",
    title: "Pick a course",
    body: "Click any course to see who's assigned, who's applied, who's volunteered, and any session excusals — approve or reject right from there.",
    placement: "right",
  },
  {
    selector: "a[href='tutors.html']",
    title: "Manage tutors",
    body: "The full tutor roster lives here — add, edit, or remove tutors, and set hourly rates and weekly hour caps.",
    placement: "bottom",
  },
  {
    selector: "a[href='timesheet-review.html']",
    title: "Review timesheets",
    body: "Logged hours from tutors show up here for you to review.",
    placement: "bottom",
  },
  {
    selector: "a[href='hours-budget-report.html']",
    title: "Hours & budget report",
    body: "See logged tutoring hours broken down by tutor and course, with cost calculated against each course's budget.",
    placement: "bottom",
  },
];

const tourBtn = document.getElementById("tour-button");
if (tourBtn) {
  tourBtn.addEventListener("click", () => {
    window.Onboarding?.start(ORGANISER_TOUR_STEPS, {
      tourId: "organiser-board",
      userId: getSessionUserId(),
      force: true,
    });
  });
}

// ---------- live updates (concurrent editing) ----------
// Polls the existing /api/... routes on an interval so another organiser's
// changes (course edits, approvals, rejections, locks, excusals) show up
// here without a manual reload. Every render function this triggers already
// skips its own DOM rebuild when the fetched data is unchanged (see the
// snapshot checks throughout this file), so poll ticks with nothing new
// don't cause visible flicker.

function isAnyModalOpen() {
  return Boolean(
    addCourseModal?.open ||
    reasonModal?.open ||
    overrideModal?.open ||
    obviousFillModal?.open ||
    deleteCourseModal?.open,
  );
}

function formatSyncStatus(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 3) return "Synced just now";
  return `Synced ${seconds}s ago`;
}

let lastSyncedAt = null;

function tickSyncStatusLabel() {
  if (syncStatusEl && lastSyncedAt) {
    syncStatusEl.textContent = formatSyncStatus(lastSyncedAt);
  }
}

let refreshInFlight = false;

async function refreshBoard() {
  // Don't yank the page out from under an organiser who's mid-form, and
  // don't let overlapping refreshes race.
  if (refreshInFlight || isAnyModalOpen()) return;

  refreshInFlight = true;
  try {
    await fetchCourses();
    await Promise.all([
      fetchTutorCount(),
      fetchVolunteerCounts(),
      fetchPendingApplicationCounts(),
      fetchPendingVolunteerCounts(),
    ]);
    lastSyncedAt = new Date();
    tickSyncStatusLabel();
  } catch (err) {
    // Fails open, same as every other fetch on this page.
  } finally {
    refreshInFlight = false;
  }
}

const POLL_INTERVAL_MS = 8000;

function startPollingSync() {
  setInterval(() => {
    if (!document.hidden) refreshBoard();
  }, POLL_INTERVAL_MS);

  setInterval(tickSyncStatusLabel, 1000); // keeps the "Xs ago" label current

  // Catch up immediately when the tab regains focus.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshBoard();
  });
}

// ---------- init ----------

async function init() {
  await fetchCourses();
  fetchTutorCount();
  fetchVolunteerCounts();
  fetchPendingApplicationCounts();
  fetchPendingVolunteerCounts();
  lastSyncedAt = new Date();
  tickSyncStatusLabel();
  startPollingSync();

  const params = new URLSearchParams(location.search);

  // Deep link from the universal search box (?course=<id>)
  const courseParam = params.get("course");
  if (courseParam) {
    const course = COURSES.find((c) => String(c.id) === courseParam);
    if (course) selectCourse(course.id);
  }

  // Arriving from the timetable grid with ?edit=<courseId> jumps straight to
  // that course's edit modal, so a session block there is a one-click edit.
  const editId = Number(params.get("edit"));
  if (Number.isInteger(editId) && editId > 0) {
    const course = COURSES.find((c) => c.id === editId);
    if (course) {
      selectCourse(course.id);
      openCourseModal(course);
    }
  }

  window.Onboarding?.start(ORGANISER_TOUR_STEPS, {
    tourId: "organiser-board",
    userId: getSessionUserId(),
  });
}

init();
