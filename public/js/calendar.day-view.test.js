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
const dateMaskJs = fs.readFileSync(
  path.join(__dirname, "date-mask.js"),
  "utf8",
);

const NL = String.fromCharCode(10);

// Stand-ins for nav.js/storage.js. getScheduleForDate and getEntriesForDate
// return one class (10:00-12:00) and one logged-hours entry (14:00-16:00)
// for every date, which is all the day view needs to have something to draw.
// Tests that need a class with repeat dates swap it in via window.__scheduleClass.
const stubs = `
function highlightActiveTab() {}
function renderWelcomeHeading() {}
function requireRole() {
  return { id: "tutor-1", role: "tutor" };
}
const __defaultClass = {
  id: "class-1",
  title: "COMS2000 Lecture",
  dayOfWeek: 4,
  startTime: "10:00",
  endTime: "12:00",
  venue: "FNB1",
};
function getScheduleForDate() {
  return [window.__scheduleClass || __defaultClass];
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
function addScheduleClasses(classes) {
  if (window.__addFails) return Promise.reject(new Error("database is down"));
  window.__addedClasses = (window.__addedClasses || []).concat(classes);
  return Promise.resolve(classes);
}
function loadSchedule() {
  return Promise.resolve([]);
}
function cancelScheduleOccurrence() {}
function modifyScheduleOccurrence() {}
function clearScheduleException() {}
function updateScheduleClass(id, changes) {
  window.__updatedClasses = (window.__updatedClasses || []).concat([
    { id, changes },
  ]);
  return Promise.resolve();
}
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

function loadCalendar({ withMask = false } = {}) {
  // The stand-ins run in their own tag (unattributed); the real source runs
  // in a second one whose padding + sourceURL keep coverage lines exact.
  // The auto-invocations of render() at module load are left in place,
  // exactly like the real page — the test just waits for them.
  let html = calendarHtml
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
  if (withMask) {
    // The real mask, loaded where calendar.html loads it — without it the
    // occurrence editor's date fields fall back to plain native inputs.
    // (Function form so `$&`-like sequences in the source stay literal.)
    html = html.replace(
      '<script src="../js/date-mask.js"></script>',
      () => "<script>" + dateMaskJs + NL + "</script>",
    );
  }

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
async function openDayViewForTest(scheduleClass, { withMask = false } = {}) {
  const window = loadCalendar({ withMask });
  await ready();
  await ready();

  // A test-supplied class must be in place before the day view reads the
  // schedule; the load-time render above only draws month pills.
  if (scheduleClass) window.__scheduleClass = scheduleClass;

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

  describe("manual add-class form", () => {
    // Submitting shows a toast with a 2.6s hide timer; closing the window
    // clears it so the worker can exit (after letting submit's render settle).
    let openWindow = null;
    afterEach(async () => {
      await ready();
      openWindow?.close();
      openWindow = null;
    });

    async function openForm() {
      const window = loadCalendar();
      openWindow = window;
      await ready();
      await ready();
      const doc = window.document;
      doc.getElementById("add-class-btn").click();
      doc.getElementById("add-class-date").value = "2026-01-15"; // a Thursday
      doc.getElementById("add-class-subject").value = "COMS2011A";
      doc.getElementById("add-class-start").value = "09:00";
      doc.getElementById("add-class-end").value = "10:00";
      doc.getElementById("add-class-venue").value = "FNB1";
      return { window, doc };
    }

    async function submit(window, doc) {
      doc
        .getElementById("add-class-form")
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
      await ready(); // the save waits on the server
    }

    test("without repeat, the class is added to just that one day", async () => {
      const { window, doc } = await openForm();
      expect(doc.getElementById("add-class-repeat-until-field").hidden).toBe(
        true,
      );

      await submit(window, doc);

      expect(window.__addedClasses).toEqual([
        expect.objectContaining({
          title: "COMS2011A",
          dayOfWeek: 4,
          firstDate: "2026-01-15",
          endDate: "2026-01-15",
          startTime: "09:00",
          endTime: "10:00",
          venue: "FNB1",
        }),
      ]);
    });

    test("ticking repeat reveals a required until-date and adds a weekly series through it", async () => {
      const { window, doc } = await openForm();
      const repeat = doc.getElementById("add-class-repeat");
      const untilField = doc.getElementById("add-class-repeat-until-field");
      const until = doc.getElementById("add-class-repeat-until");

      repeat.checked = true;
      repeat.dispatchEvent(new window.Event("change", { bubbles: true }));
      expect(untilField.hidden).toBe(false);
      expect(until.required).toBe(true);
      expect(until.min).toBe("2026-01-15");

      until.value = "2026-05-28";
      await submit(window, doc);

      expect(window.__addedClasses).toEqual([
        expect.objectContaining({
          dayOfWeek: 4,
          firstDate: "2026-01-15",
          endDate: "2026-05-28",
        }),
      ]);
      // The form resets on close, hiding the until-date again.
      expect(repeat.checked).toBe(false);
      expect(untilField.hidden).toBe(true);
      expect(until.required).toBe(false);
    });

    test("if the server rejects the class, the form stays open with what was typed", async () => {
      const { window, doc } = await openForm();
      window.__addFails = true;

      await submit(window, doc);

      expect(doc.getElementById("add-class-card").hidden).toBe(false);
      expect(doc.getElementById("add-class-subject").value).toBe("COMS2011A");
      const toast = doc.getElementById("toast");
      expect(toast.textContent).toBe("database is down");
      expect(toast.classList.contains("toast--danger")).toBe(true);
    });
  });

  test("Escape closes the day view", async () => {
    const { window, doc } = await openDayViewForTest();

    expect(doc.querySelector(".day-view-overlay")).not.toBeNull();
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(doc.querySelector(".day-view-overlay")).toBeNull();
  });
});

// The occurrence editor's weekly-repeat controls: a saved class (one-off or
// series) can be given a repeat range from a start date to an end date from
// the edit dialog, and an existing repeat can be extended or stopped there.
describe("occurrence editor weekly repeat", () => {
  // Saving shows a toast with a 2.6s hide timer; closing the window clears it
  // so the worker can exit (after letting the save's render settle).
  let openWindow = null;
  afterEach(async () => {
    await ready();
    openWindow?.close();
    openWindow = null;
  });

  async function openEditor(scheduleClass, { withMask = false } = {}) {
    const { window, doc, dateStr } = await openDayViewForTest(scheduleClass, {
      withMask,
    });
    openWindow = window;
    doc
      .querySelector(".day-view-event--class")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    return { window, doc, dateStr };
  }

  function findSaveButton(doc) {
    return Array.from(doc.querySelectorAll(".occurrence-modal button")).find(
      (btn) => btn.textContent === "Update all future classes",
    );
  }

  function classRepeatingThisMonth() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    return {
      id: "class-1",
      title: "COMS2000 Lecture",
      dayOfWeek: 4,
      startTime: "10:00",
      endTime: "12:00",
      venue: "FNB1",
      firstDate: `${y}-${m}-01`,
      endDate: `${y}-${m}-28`,
    };
  }

  test("a saved one-off class can be made to repeat weekly from the editor", async () => {
    const { window, doc, dateStr } = await openEditor();
    const repeat = doc.getElementById("occurrence-repeat");
    const range = doc.getElementById("occurrence-repeat-range");
    expect(repeat.checked).toBe(false);
    expect(range.hidden).toBe(true);

    repeat.checked = true;
    repeat.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(range.hidden).toBe(false);
    // The range prefills with the class's own date.
    expect(doc.getElementById("occurrence-repeat-from").value).toBe(dateStr);

    const from = doc.getElementById("occurrence-repeat-from");
    from.value = "2026-01-15"; // a Thursday
    from.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(doc.getElementById("occurrence-repeat-until").min).toBe(
      "2026-01-15",
    );
    doc.getElementById("occurrence-repeat-until").value = "2026-05-28";

    findSaveButton(doc).click();
    await ready();

    expect(window.__updatedClasses).toEqual([
      {
        id: "class-1",
        changes: expect.objectContaining({
          firstDate: "2026-01-15",
          endDate: "2026-05-28",
          dayOfWeek: 4,
        }),
      },
    ]);
    expect(doc.querySelector(".occurrence-modal-overlay")).toBeNull();
  });

  test("an incomplete or backwards range is rejected without saving", async () => {
    const { window, doc } = await openEditor();
    const repeat = doc.getElementById("occurrence-repeat");
    repeat.checked = true;
    repeat.dispatchEvent(new window.Event("change", { bubbles: true }));

    // Repeat until is required once the box is ticked.
    findSaveButton(doc).click();
    await ready();
    let toast = doc.getElementById("toast");
    expect(window.__updatedClasses).toBeUndefined();
    expect(toast.textContent).toBe("Pick the date the weekly repeat ends.");
    expect(doc.querySelector(".occurrence-modal-overlay")).not.toBeNull();

    // And the range can't run backwards.
    const from = doc.getElementById("occurrence-repeat-from");
    from.value = "2026-05-28";
    from.dispatchEvent(new window.Event("change", { bubbles: true }));
    doc.getElementById("occurrence-repeat-until").value = "2026-01-15";
    findSaveButton(doc).click();
    await ready();
    toast = doc.getElementById("toast");
    expect(window.__updatedClasses).toBeUndefined();
    expect(toast.textContent).toBe("The repeat can't end before it starts.");
    expect(toast.classList.contains("toast--danger")).toBe(true);
  });

  test("a weekly class prefills its range, and unticking stops it after the opened day", async () => {
    const cls = classRepeatingThisMonth();
    const { window, doc, dateStr } = await openEditor(cls);

    const repeat = doc.getElementById("occurrence-repeat");
    expect(repeat.checked).toBe(true);
    expect(doc.getElementById("occurrence-repeat-from").value).toBe(
      cls.firstDate,
    );
    expect(doc.getElementById("occurrence-repeat-until").value).toBe(
      cls.endDate,
    );
    const note = doc.getElementById("occurrence-repeat-note");
    expect(note.hidden).toBe(true);

    repeat.checked = false;
    repeat.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(doc.getElementById("occurrence-repeat-range").hidden).toBe(true);
    expect(note.hidden).toBe(false);

    findSaveButton(doc).click();
    await ready();

    expect(window.__updatedClasses).toEqual([
      {
        id: "class-1",
        changes: expect.objectContaining({ endDate: dateStr }),
      },
    ]);
  });

  test("impossible typed repeat dates block the save with the field's message", async () => {
    const { window, doc } = await openEditor(undefined, { withMask: true });
    const repeat = doc.getElementById("occurrence-repeat");
    repeat.checked = true;
    repeat.dispatchEvent(new window.Event("change", { bubbles: true }));

    // An impossible start date stops the save before the day-of-week check.
    const fromField = doc.getElementById("occurrence-repeat-from-typed");
    fromField.value = "32/13/2026";
    fromField.dispatchEvent(new window.Event("input", { bubbles: true }));
    findSaveButton(doc).click();
    await ready();
    expect(window.__updatedClasses).toBeUndefined();
    expect(doc.querySelector(".occurrence-modal-overlay")).not.toBeNull();
    expect(fromField.validationMessage).toMatch(/doesn't exist/);
    expect(doc.activeElement).toBe(fromField);

    // Same for the end date, once the start is a real date again.
    fromField.value = "15/01/2026";
    fromField.dispatchEvent(new window.Event("input", { bubbles: true }));
    const untilField = doc.getElementById("occurrence-repeat-until-typed");
    untilField.value = "29/02/2026";
    untilField.dispatchEvent(new window.Event("input", { bubbles: true }));
    findSaveButton(doc).click();
    await ready();
    expect(window.__updatedClasses).toBeUndefined();
    expect(doc.activeElement).toBe(untilField);

    // Fixing both lets the update through.
    untilField.value = "28/05/2026";
    untilField.dispatchEvent(new window.Event("input", { bubbles: true }));
    findSaveButton(doc).click();
    await ready();
    expect(window.__updatedClasses).toEqual([
      {
        id: "class-1",
        changes: expect.objectContaining({
          firstDate: "2026-01-15",
          endDate: "2026-05-28",
          dayOfWeek: 4,
        }),
      },
    ]);
  });
});
