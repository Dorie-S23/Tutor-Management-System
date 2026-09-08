// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const HOUR_START = 7; // 07:00
const HOUR_END = 19; // 19:00
const SLOT_MINUTES = 30;
const TOTAL_SLOTS = ((HOUR_END - HOUR_START) * 60) / SLOT_MINUTES;

const gridEl = document.getElementById("timetableGrid");
const unscheduledEl = document.getElementById("timetableUnscheduled");

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

function mapCourseRow(row) {
  return {
    id: row.id,
    code: row.course_code,
    dayOfTut: row.Day_of_tut,
    startTime: row.tutor_start_time,
    endTime: row.tutor_end_time,
    venues: row.venues,
  };
}

// Flattens each course's tutorial session into a list of placeable sessions.
function getAllSessions(courses) {
  const sessions = [];
  courses.forEach((c) => {
    if (c.dayOfTut && c.startTime && c.endTime) {
      sessions.push({
        courseId: c.id,
        courseCode: c.code,
        type: "Tutorial",
        day: c.dayOfTut,
        start: c.startTime.slice(0, 5),
        end: c.endTime.slice(0, 5),
        venue: c.venues || "",
      });
    }
  });
  return sessions;
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

// At least one room in common, overlapping time, on the same day — a real
// double-booking.
function findClashPartners(session, allSessions) {
  if (!session.venue) return [];
  return allSessions.filter(
    (other) =>
      other !== session &&
      other.day.trim().toLowerCase() === session.day.trim().toLowerCase() &&
      sharedVenues(session.venue, other.venue).length > 0 &&
      timesOverlap(session.start, session.end, other.start, other.end),
  );
}

function renderGrid(sessions) {
  gridEl.innerHTML = "";
  gridEl.style.gridTemplateRows = `auto repeat(${TOTAL_SLOTS}, 28px)`;

  const corner = document.createElement("div");
  corner.className = "timetable-grid-header";
  gridEl.appendChild(corner);

  DAY_NAMES.forEach((day) => {
    const header = document.createElement("div");
    header.className = "timetable-grid-header";
    header.textContent = day.slice(0, 3);
    gridEl.appendChild(header);
  });

  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const minutesFromStart = slot * SLOT_MINUTES;
    const hour = HOUR_START + Math.floor(minutesFromStart / 60);
    const isHourMark = minutesFromStart % 60 === 0;

    const label = document.createElement("div");
    label.className = "timetable-time-label";
    label.style.gridRow = String(slot + 2);
    label.style.gridColumn = "1";
    label.textContent = isHourMark ? `${String(hour).padStart(2, "0")}:00` : "";
    gridEl.appendChild(label);

    for (let day = 0; day < DAY_NAMES.length; day++) {
      const cellBg = document.createElement("div");
      cellBg.className = "timetable-cell-bg";
      cellBg.style.gridRow = String(slot + 2);
      cellBg.style.gridColumn = String(day + 2);
      gridEl.appendChild(cellBg);
    }
  }

  const unplaced = [];
  const totalMinutes = (HOUR_END - HOUR_START) * 60;

  // Group sessions by day so overlapping ones on the same day can be laid
  // out side-by-side instead of stacking on top of each other.
  const byDay = DAY_NAMES.map(() => []);
  sessions.forEach((session) => {
    const dayIndex = DAY_NAMES.findIndex(
      (d) => d.toLowerCase() === session.day.trim().toLowerCase(),
    );
    const startMin = timeToMinutes(session.start);
    const endMin = timeToMinutes(session.end);
    if (dayIndex === -1 || endMin <= HOUR_START * 60 || startMin >= HOUR_END * 60) {
      unplaced.push(session);
      return;
    }
    byDay[dayIndex].push(session);
  });

  byDay.forEach((daySessions, dayIndex) => {
    if (daySessions.length === 0) return;

    const overlay = document.createElement("div");
    overlay.className = "timetable-day-overlay";
    overlay.style.gridRow = `2 / span ${TOTAL_SLOTS}`;
    overlay.style.gridColumn = String(dayIndex + 2);
    gridEl.appendChild(overlay);

    // Greedy lane assignment (like Google Calendar's day view): sessions
    // sorted by start time each go into the first lane whose previous
    // session has already ended, otherwise a new lane opens.
    const sorted = [...daySessions].sort(
      (a, b) => timeToMinutes(a.start) - timeToMinutes(b.start),
    );
    const laneEndMinutes = [];
    const laneOfSession = new Map();
    sorted.forEach((session) => {
      const startMin = timeToMinutes(session.start);
      let lane = laneEndMinutes.findIndex((end) => end <= startMin);
      if (lane === -1) {
        lane = laneEndMinutes.length;
        laneEndMinutes.push(timeToMinutes(session.end));
      } else {
        laneEndMinutes[lane] = timeToMinutes(session.end);
      }
      laneOfSession.set(session, lane);
    });
    const laneCount = laneEndMinutes.length;

    sorted.forEach((session) => {
      const startMin = Math.max(timeToMinutes(session.start), HOUR_START * 60);
      const endMin = Math.min(timeToMinutes(session.end), HOUR_END * 60);
      const lane = laneOfSession.get(session);

      const clashPartners = findClashPartners(session, sessions);
      const block = document.createElement("a");
      block.href = `board.html?edit=${session.courseId}`;
      block.className = `timetable-session ${session.type.toLowerCase()}${clashPartners.length ? " clash" : ""}`;
      block.style.top = `${((startMin - HOUR_START * 60) / totalMinutes) * 100}%`;
      block.style.height = `${((endMin - startMin) / totalMinutes) * 100}%`;
      block.style.left = `${(lane / laneCount) * 100}%`;
      block.style.width = `${100 / laneCount}%`;
      block.title = clashPartners.length
        ? `Venue clash (${clashPartners.map((p) => sharedVenues(session.venue, p.venue).join("/")).join(", ")}) with ${clashPartners.map((p) => `${p.courseCode} ${p.type}`).join(", ")}`
        : `${session.courseCode} ${session.type}${session.venue ? ` · ${session.venue}` : " · no venue set"}`;
      block.innerHTML = `
        <span class="session-code">${session.courseCode}${clashPartners.length ? " ⚠" : ""}</span>
        <span class="session-meta">${session.type} · ${session.start}–${session.end}</span>
        ${session.venue ? `<span class="session-meta">${session.venue}</span>` : ""}
      `;
      overlay.appendChild(block);
    });
  });

  if (unplaced.length > 0) {
    unscheduledEl.hidden = false;
    unscheduledEl.textContent = `Couldn't place on the grid (unrecognised day or outside 07:00–19:00): ${unplaced
      .map((s) => `${s.courseCode} ${s.type} (${s.day} ${s.start}–${s.end})`)
      .join(", ")}`;
  } else {
    unscheduledEl.hidden = true;
  }
}

async function loadAndRender() {
  try {
    const res = await fetch("/api/courses");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load courses");
    const courses = rows.map(mapCourseRow);
    renderGrid(getAllSessions(courses));
  } catch (err) {
    unscheduledEl.hidden = false;
    unscheduledEl.textContent = "Couldn't load courses from the database.";
  }
}

loadAndRender();
