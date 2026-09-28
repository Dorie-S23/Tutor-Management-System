// The day view: clicking a day cell opens a scrollable hour grid with time
// stamps and lines, the day's sessions/classes as blocks sized to their real
// times, and empty slots that hand off to the add-class form pre-filled for
// that day and time.
//
// Like calendar.render-race.test.js, the real calendar.html + calendar.js are
// loaded into a jsdom document with the module imports replaced by stand-ins,
// so the test drives the same DOM the app actually builds.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "calendar.html"),
  "utf8",
);
const rawCalendarJs = fs.readFileSync(
  path.join(__dirname, "calendar.js"),
  "utf8",
);

const NL = String.fromCharCode(10);

// Stand-ins for nav.js/storage.js. getScheduleForDate and getEntriesForDate
// return one class (10:00-12:00) and one logged-hours entry (14:00-16:00)
// for every date, which is all the day view needs to have something to draw.
const stubs = `
function highlightActiveTab() {}
function renderWelcomeHeading() {}
function requireRole() {
  return { id: "tutor-1", role: "tutor" };
}
function getScheduleForDate() {
  return [
    {
      id: "class-1",
      title: "COMS2000 Lecture",
      dayOfWeek: 4,
      startTime: "10:00",
      endTime: "12:00",
      venue: "FNB1",
    },
  ];
}
function getCancelledOccurrencesForDate() {
  return [];
}
function getEntriesForDate() {
  return Promise.resolve([
    {
      id: "e1",
      date: "2026-01-15",
      hours: 2,
      startTime: "14:00",
      endTime: "16:00",
      subject: "COMS2000",
      notes: "",
    },
  ]);
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
`;

// The real file's first module statement — the imports all live above it,
// which is what the stand-ins above replace.
const calendarSliceStart = rawCalendarJs.indexOf("const pageRole");
const calendarJs = rawCalendarJs.slice(calendarSliceStart);
const calendarJsUrl = pathToFileURL(path.join(__dirname, "calendar.js")).href;
// Pad the injected copy with one newline per sliced-off line so its line
// numbers match the real file's and coverage lands on the right lines.
const calendarJsPad = NL.repeat(
  rawCalendarJs.slice(0, calendarSliceStart).split(NL).length - 1,
);

function loadCalendar() {
  // The stand-ins run in their own tag (unattributed); the real source runs
  // in a second one whose padding + sourceURL keep coverage lines exact.
  // The auto-invocations of render() at module load are left in place,
  // exactly like the real page — the test just waits for them.
  const html = calendarHtml
    .replace(
      '<script type="module" src="../js/calendar.js"></script>',
      "<script>" +
        NL +
        stubs +
        NL +
        "</script>" +
        "<script>" +
        calendarJsPad +
        calendarJs +
        NL +
        "//# sourceURL=" +
        calendarJsUrl +
        NL +
        "</script>",
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
      window.fetch = () => Promise.resolve({ ok: true, json: async () => [] });
      // jsdom doesn't implement scrollIntoView; the add-class form calls it.
      window.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });

  return dom.window;
}

function ready() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Loads the page (letting its own renders settle), then clicks the cell for
// the 10th of the current month and returns everything the assertions need.
async function openDayViewForTest() {
  const window = loadCalendar();
  await ready();
  await ready();

  const doc = window.document;
  const gridEl = doc.getElementById("calendar-grid");

  const now = new Date();
  const firstWeekday = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
  const cell = gridEl.children[firstWeekday + 9]; // the 10th of the month
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-10`;
  expect(cell).toBeTruthy();

  cell.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await ready();
  await ready();

  return { window, doc, dateStr };
}

describe("calendar.js day view", () => {
  test("clicking a day opens a day view with hour lines, time stamps, and event blocks sized to their times", async () => {
    const { doc } = await openDayViewForTest();

    expect(doc.querySelector(".day-view-overlay")).not.toBeNull();
    expect(
      doc.getElementById("day-view-heading").textContent.length,
    ).toBeGreaterThan(0);

    // A stamped line for every hour (06:00–22:00) plus unlabelled half-hour
    // lines in between.
    const labels = Array.from(doc.querySelectorAll(".day-view-time")).map(
      (el) => el.textContent,
    );
    expect(labels.length).toBe(17);
    expect(labels[0]).toBe("06:00");
    expect(labels[labels.length - 1]).toBe("22:00");
    expect(doc.querySelectorAll(".day-view-hour--half").length).toBe(16);

    // The added class (10:00-12:00) is a block 2 hours tall, starting 4 hours
    // down from the 06:00 line (4 * 52px + the 2px gap).
    const classBlock = doc.querySelector(".day-view-event--class");
    expect(classBlock).not.toBeNull();
    expect(classBlock.textContent).toContain("10:00–12:00");
    expect(classBlock.textContent).toContain("COMS2000 Lecture");
    expect(classBlock.style.top).toBe("210px");
    expect(classBlock.style.height).toBe("100px");

    // The logged-hours entry (14:00-16:00) appears as its own block.
    const hoursBlock = doc.querySelector(".day-view-event--hours");
    expect(hoursBlock).not.toBeNull();
    expect(hoursBlock.textContent).toContain("2h · COMS2000");
    expect(hoursBlock.style.top).toBe("418px");
  });

  test("clicking an empty slot closes the day view and pre-fills the add-class form for that day and time", async () => {
    const { window, doc, dateStr } = await openDayViewForTest();

    const lane = doc.querySelector(".day-view-lane");
    expect(lane).not.toBeNull();
    // jsdom has no layout, so pretend the lane starts at y=100 with 52px per
    // hour: clientY 214 = 114px into the lane = 131 minutes past 06:00,
    // snapping down to 08:00.
    lane.getBoundingClientRect = () => ({
      top: 100,
      left: 0,
      right: 400,
      bottom: 900,
      width: 400,
      height: 800,
      x: 0,
      y: 100,
    });
    lane.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, clientY: 214 }),
    );

    expect(doc.querySelector(".day-view-overlay")).toBeNull();

    const card = doc.getElementById("add-class-card");
    expect(card.hidden).toBe(false);
    expect(doc.getElementById("add-class-date").value).toBe(dateStr);
    expect(doc.getElementById("add-class-start").value).toBe("08:00");
    expect(doc.getElementById("add-class-end").value).toBe("09:00");
  });

  test("clicking an event block opens the occurrence editor instead of the add-class form", async () => {
    const { window, doc } = await openDayViewForTest();

    const classBlock = doc.querySelector(".day-view-event--class");
    classBlock.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(doc.querySelector(".day-view-overlay")).toBeNull();
    expect(doc.querySelector(".occurrence-modal-overlay")).not.toBeNull();
    expect(doc.getElementById("add-class-card").hidden).toBe(true);
  });

  test("Escape closes the day view", async () => {
    const { window, doc } = await openDayViewForTest();

    expect(doc.querySelector(".day-view-overlay")).not.toBeNull();
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(doc.querySelector(".day-view-overlay")).toBeNull();
  });
});
