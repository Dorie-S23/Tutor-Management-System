// calendar.js is an ES module written to run in a real browser (import/
// export, real fetch calls), not to be require()'d as CommonJS. Like
// board.keyboard-nav.test.js, we load the real calendar.html + calendar.js
// into an actual jsdom document so the test exercises the real render()
// logic — the same function and DOM the app actually runs — rather than a
// reimplementation of it.
//
// calendar.js's own imports (nav.js, storage.js) are stripped and replaced
// with small stand-ins defined in the same script scope, and its two
// auto-invocations of render() at module load are stripped so the test
// controls exactly when and how render() is called instead of racing
// against them.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "calendar.html"),
  "utf8",
);
const rawCalendarJs = fs.readFileSync(
  path.join(__dirname, "calendar.js"),
  "utf8",
);

// This suite is only about render()'s own concurrency safety, so every
// import is replaced with a minimal stand-in instead of the real
// storage.js/nav.js — getEntriesForDate is the one that matters here (see
// below), the rest just need to exist and not throw.
const stubs = `
function highlightActiveTab() {}
function renderWelcomeHeading() {}
function requireRole() {
  return { id: "tutor-1", role: "tutor" };
}
function getScheduleForDate() {
  return [];
}
function getCancelledOccurrencesForDate() {
  return [];
}
function addScheduleClasses() {}
function cancelScheduleOccurrence() {}
function modifyScheduleOccurrence() {}
function clearScheduleException() {}
function updateScheduleClass() {}
function deleteScheduleClass() {}
function clearSchedule() {}
function todayStr() {
  return "2026-01-15";
}

// Test-controlled stand-in for storage.js's getEntriesForDate — the one
// real await inside render()'s per-cell loop, and therefore the one thing
// that has to behave like a real fetch (i.e. actually yield to the event
// loop) for the race this suite reproduces to be possible at all.
window.__entriesCalls = { caller: null, holdFirstFrom: "A", releaseHeld: null };
function getEntriesForDate() {
  const state = window.__entriesCalls;
  if (state.caller === state.holdFirstFrom && !state.releaseHeld) {
    return new Promise((resolve) => {
      state.releaseHeld = () => resolve([]);
    });
  }
  return Promise.resolve([]);
}
`;

function loadCalendar() {
  const calendarJs = rawCalendarJs
    // Drop the real imports — replaced by the stand-ins above.
    .replace(/import\s*{[^}]*}\s*from\s*["'][^"']+["'];?/g, "")
    // Drop the two auto-invocations at module load — the test drives
    // render() itself via window.renderCalendar instead.
    .replace(
      /\nrender\(\);\nfetchCourseSessions\(\)\.then\(render\);\n?/,
      "\n",
    );

  const html = calendarHtml
    .replace(
      '<script type="module" src="../js/calendar.js"></script>',
      // Deliberately unattributed: this suite runs a line-modified copy of
      // calendar.js (auto-invocations stripped), so tagging it with the real
      // file's sourceURL would skew the coverage Jest merges for it.
      `<script>\n${stubs}\n${calendarJs}\n</script>`,
    )
    .replace(
      '<script type="module" src="../js/timetable-import.js"></script>',
      "",
    );

  const dom = new JSDOM(html, {
    url: "http://localhost/calendar.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // fetchCourseSessions() is never called (its trigger was stripped
      // above), but it's still defined and references fetch — stub it out
      // so nothing throws if that ever changes.
      window.fetch = () => Promise.resolve({ ok: true, json: async () => [] });
    },
  });

  return dom.window;
}

function ready() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("calendar.js render() concurrency", () => {
  test("a superseded render() call does not append cells on top of a newer, already-finished one", async () => {
    const window = loadCalendar();
    await ready();

    const gridEl = window.document.getElementById("calendar-grid");
    const state = window.__entriesCalls;

    // Call A: starts, immediately gets stuck on its very first per-cell
    // fetch (cell 0) — mirroring the real bug, where render() is called
    // once directly at load and pauses mid-loop on a real network request.
    state.caller = "A";
    const callA = window.renderCalendar();
    await ready();
    expect(gridEl.children.length).toBe(0); // hasn't appended anything yet

    // Call B: the second overlapping call (in production, triggered by
    // fetchCourseSessions() resolving while call A is still in flight). Its
    // own per-cell fetches all resolve immediately, so it runs to
    // completion while call A is still parked.
    state.caller = "B";
    const callB = window.renderCalendar();
    await callB;

    const totalCells = gridEl.children.length;
    expect(totalCells).toBeGreaterThan(0);
    expect(totalCells % 7).toBe(0); // a whole number of calendar weeks

    // Now let call A's long-parked fetch resolve — it should discover a
    // newer render() has since finished and bail out instead of appending
    // its own (now-stale) cell 0 on top of call B's finished grid.
    state.releaseHeld();
    await callA;

    expect(gridEl.children.length).toBe(totalCells);
  });

  test("without the token guard, the same sequence would double the grid (sanity check on the test itself)", async () => {
    // This isn't testing calendar.js — it's proving the test above actually
    // exercises the bug it claims to, by re-running the identical sequence
    // against a copy of render() with the guard line removed.
    const calendarJsNoGuard = rawCalendarJs
      .replace(/import\s*{[^}]*}\s*from\s*["'][^"']+["'];?/g, "")
      .replace(
        /\nrender\(\);\nfetchCourseSessions\(\)\.then\(render\);\n?/,
        "\n",
      )
      .replace(/if \(token !== renderToken\) return;[^\n]*\n\n?/, "");

    const html = calendarHtml
      .replace(
        '<script type="module" src="../js/calendar.js"></script>',
        `<script>\n${stubs}\n${calendarJsNoGuard}\n</script>`,
      )
      .replace(
        '<script type="module" src="../js/timetable-import.js"></script>',
        "",
      );

    const dom = new JSDOM(html, {
      url: "http://localhost/calendar.html",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = () =>
          Promise.resolve({ ok: true, json: async () => [] });
      },
    });
    const window = dom.window;
    await ready();

    const gridEl = window.document.getElementById("calendar-grid");
    const state = window.__entriesCalls;

    state.caller = "A";
    const callA = window.renderCalendar();
    await ready();

    state.caller = "B";
    const callB = window.renderCalendar();
    await callB;
    const totalCells = gridEl.children.length;

    state.releaseHeld();
    await callA;

    // Without the guard, call A resumes and keeps appending — doubling the
    // grid. If this assertion ever fails, the "bug" reproduction above has
    // drifted from the real code and the fixed-version test isn't actually
    // proving anything.
    expect(gridEl.children.length).toBeGreaterThan(totalCells);
  });
});
