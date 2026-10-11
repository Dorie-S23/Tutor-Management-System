// calendar.js flows the day-view and render-race suites don't reach: the
// tutor's course-session pills (with excusals), the occurrence editor's
// per-day and series actions, the confirm-gated destructive actions, and the
// student volunteer's cover pills + day view. Same harness as
// calendar.day-view.test.js — real pages, imports stubbed, sliced source
// with line-padding so coverage lands on the right lines — made
// configurable through window.__config so each test seeds its own data.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const tutorHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "calendar.html"),
  "utf8",
);
const studentHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "student-calendar.html"),
  "utf8",
);
const rawCalendarJs = fs.readFileSync(
  path.join(__dirname, "calendar.js"),
  "utf8",
);

const NL = String.fromCharCode(10);

const stubs = `
function highlightActiveTab() {}
function renderWelcomeHeading() {}
function requireRole() {
  return { id: "u1", name: "Test User", role: window.__config.role };
}
function getScheduleForDate() {
  return window.__config.scheduleClass ? [window.__config.scheduleClass] : [];
}
function getCancelledOccurrencesForDate() {
  return window.__config.cancelled || [];
}
function getEntriesForDate() {
  return Promise.resolve(window.__config.entries || []);
}
function addScheduleClasses(classes) {
  window.__calls.push(["addScheduleClasses", classes]);
  return Promise.resolve(classes);
}
function loadSchedule() {
  return Promise.resolve([]);
}
function cancelScheduleOccurrence(id, date) {
  window.__calls.push(["cancelScheduleOccurrence", id, date]);
  return Promise.resolve();
}
function modifyScheduleOccurrence(id, date, overrides) {
  window.__calls.push(["modifyScheduleOccurrence", id, date, overrides]);
  return Promise.resolve();
}
function clearScheduleException(id, date) {
  window.__calls.push(["clearScheduleException", id, date]);
  return Promise.resolve();
}
function updateScheduleClass(id, changes) {
  window.__calls.push(["updateScheduleClass", id, changes]);
  return Promise.resolve();
}
function deleteScheduleClass(id) {
  window.__calls.push(["deleteScheduleClass", id]);
  return Promise.resolve();
}
function clearSchedule() {
  window.__calls.push(["clearSchedule"]);
  return Promise.resolve();
}
function todayStr() {
  return window.__config.today || "2026-01-15";
}
`;

const calendarSliceStart = rawCalendarJs.indexOf("const pageRole");
const calendarJs = rawCalendarJs.slice(calendarSliceStart);
const calendarJsUrl = pathToFileURL(path.join(__dirname, "calendar.js")).href;
const calendarJsPad = NL.repeat(
  rawCalendarJs.slice(0, calendarSliceStart).split(NL).length - 1,
);

function loadCalendar(role, config = {}) {
  const pageHtml = (role === "tutor" ? tutorHtml : studentHtml)
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

  const dom = new JSDOM(pageHtml, {
    url:
      role === "tutor"
        ? "http://localhost/calendar.html"
        : "http://localhost/student-calendar.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.__config = { role, ...config };
      window.__calls = [];
      window.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/api/tutor-applications")) {
          if (config.tutorAppsFail) {
            return { ok: false, json: async () => ({ error: "nope" }) };
          }
          return { ok: true, json: async () => config.tutorApps || [] };
        }
        if (u.includes("/api/course-volunteers")) {
          if (config.volunteerAppsFail) {
            return { ok: false, json: async () => ({ error: "nope" }) };
          }
          return { ok: true, json: async () => config.volunteerApps || [] };
        }
        if (u.includes("/api/session-excusals") && u.includes("coverUserId=")) {
          if (config.coversFail) throw new Error("covers endpoint offline");
          return { ok: true, json: async () => config.covers || [] };
        }
        if (u.includes("/api/session-excusals")) {
          if (config.excusalsFail) {
            return { ok: false, json: async () => ({ error: "nope" }) };
          }
          return { ok: true, json: async () => config.excusals || [] };
        }
        return { ok: true, json: async () => [] };
      };
      window.HTMLElement.prototype.scrollIntoView = () => {};
      // jsdom 26 doesn't implement <dialog>.showModal/close — the in-app
      // confirm dialog needs both.
      window.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
      window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
      };
    },
  });

  return dom.window;
}

function wait(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pills only render for dates in the visible month — the real current one.
const NOW = new Date();
const VIEW_YEAR = NOW.getFullYear();
const VIEW_MONTH = NOW.getMonth();
const DAYS_IN_MONTH = new Date(VIEW_YEAR, VIEW_MONTH + 1, 0).getDate();
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
function isoOfDay(dayOfMonth) {
  return `${VIEW_YEAR}-${String(VIEW_MONTH + 1).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
}
// First Thursday of the visible month — the recurring tutorial's day.
const TUT_DAY = (() => {
  for (let d = 1; d <= DAYS_IN_MONTH; d++) {
    if (new Date(VIEW_YEAR, VIEW_MONTH, d).getDay() === 4) return d;
  }
  return null;
})();
const TUT_ISO = isoOfDay(TUT_DAY);

const tutorCourse = {
  course_code: "COMS1016A",
  course_name: "Intro to CS",
  Day_of_tut: "Thursday",
  tutor_start_time: "10:00:00",
  tutor_end_time: "12:00:00",
  venues: "MSL004",
};

function currentMonthCell(window, iso) {
  const dayNum = Number(iso.slice(-2));
  return Array.from(window.document.querySelectorAll(".calendar-day")).find(
    (cell) =>
      !cell.classList.contains("other-month") &&
      Number(cell.querySelector(".calendar-day-number").textContent) === dayNum,
  );
}

describe("calendar.js — tutor course-session pills", () => {
  test("approved applications render tutorial pills and colour-key chips; pending ones don't", async () => {
    const window = loadCalendar("tutor", {
      tutorApps: [
        {
          status: "approved",
          course_id: 7,
          courses: tutorCourse,
        },
        {
          status: "pending",
          course_id: 8,
          courses: { ...tutorCourse, course_code: "PENDING999" },
        },
      ],
    });
    await wait();
    await wait();

    const cell = currentMonthCell(window, TUT_ISO);
    const pill = cell.querySelector(".calendar-course-pill");
    expect(pill).not.toBeNull();
    expect(pill.textContent).toBe("10:00 COMS1016A · Tut");
    expect(pill.title).toContain("COMS1016A Tutorial · 10:00–12:00 · MSL004");
    expect(window.document.body.textContent).not.toContain("PENDING999");

    const key = window.document.getElementById("course-color-key");
    expect(key.hidden).toBe(false);
    expect(key.textContent).toContain("COMS1016A");
  });

  test("an excused session renders struck through with the cover and reason in its tooltip", async () => {
    const window = loadCalendar("tutor", {
      tutorApps: [{ status: "approved", course_id: 7, courses: tutorCourse }],
      excusals: [
        {
          course_id: 7,
          session_date: TUT_ISO,
          session_type: "tutorial",
          reason: "Family emergency",
          cover: { name: "Nora N" },
        },
      ],
    });
    await wait();
    await wait();

    const pill = currentMonthCell(window, TUT_ISO).querySelector(
      ".calendar-course-pill",
    );
    expect(pill.classList.contains("calendar-course-pill--excused")).toBe(true);
    expect(pill.textContent).toContain("Excused");
    expect(pill.title).toContain("Nora N is covering");
    expect(pill.title).toContain("Reason: Family emergency");

    expect(
      window.document.getElementById("course-color-key").textContent,
    ).toContain("Excused");
  });

  test("clicking a session pill stays on the grid; clicking the cell background opens the day view", async () => {
    const window = loadCalendar("tutor", {
      tutorApps: [{ status: "approved", course_id: 7, courses: tutorCourse }],
    });
    await wait();
    await wait();

    const cell = currentMonthCell(window, TUT_ISO);
    cell.querySelector(".calendar-course-pill").click();
    await wait();
    expect(window.document.querySelector(".day-view-overlay")).toBeNull();

    cell.click();
    await wait();
    expect(window.document.querySelector(".day-view-overlay")).not.toBeNull();
  });
});

const editableClass = {
  id: "class-1",
  title: "COMS2000 Lecture",
  dayOfWeek: 4,
  startTime: "10:00",
  endTime: "12:00",
  venue: "FNB1",
};

function openOccurrenceEditor(window) {
  // Pick the editor for a non-other-month cell so the date is in view.
  const pill = Array.from(
    window.document.querySelectorAll(".calendar-class-pill"),
  ).find((p) => !p.closest(".calendar-day").classList.contains("other-month"));
  pill.click();
  return pill.closest(".calendar-day");
}

describe("calendar.js — occurrence editor", () => {
  test("clicking a class pill opens the editor pre-filled with the class", async () => {
    const window = loadCalendar("tutor", {
      scheduleClass: editableClass,
    });
    await wait();
    await wait();

    openOccurrenceEditor(window);
    await wait();

    const modal = window.document.querySelector(".occurrence-modal");
    expect(modal).not.toBeNull();
    expect(modal.querySelector("input").value).toBe("COMS2000 Lecture");
    expect(modal.textContent).toContain("Thursday");
    expect(modal.querySelector("input[type='time']").value).toBe("10:00");
  });

  test('"Save for this day only" calls modifyScheduleOccurrence with the edited values', async () => {
    const window = loadCalendar("tutor", { scheduleClass: editableClass });
    await wait();
    await wait();

    openOccurrenceEditor(window);
    await wait();

    const modal = window.document.querySelector(".occurrence-modal");
    modal.querySelector("input").value = "COMS2001 Tut";
    [...modal.querySelectorAll("button")]
      .find((b) => b.textContent === "Save for this day only")
      .click();
    await wait();

    const call = window.__calls.find(
      (c) => c[0] === "modifyScheduleOccurrence",
    );
    expect(call).toBeDefined();
    expect(call[1]).toBe("class-1");
    expect(call[3]).toMatchObject({
      title: "COMS2001 Tut",
      startTime: "10:00",
      endTime: "12:00",
      venue: "FNB1",
    });
    expect(window.document.querySelector(".occurrence-modal")).toBeNull();
  });

  test('"Cancel class for this day" calls cancelScheduleOccurrence', async () => {
    const window = loadCalendar("tutor", { scheduleClass: editableClass });
    await wait();
    await wait();

    openOccurrenceEditor(window);
    await wait();

    [
      ...window.document
        .querySelector(".occurrence-modal")
        .querySelectorAll("button"),
    ]
      .find((b) => b.textContent === "Cancel class for this day")
      .click();
    await wait();

    const call = window.__calls.find(
      (c) => c[0] === "cancelScheduleOccurrence",
    );
    expect(call[1]).toBe("class-1");
    expect(call[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('a modified occurrence offers "Revert to default", which clears the exception', async () => {
    const window = loadCalendar("tutor", {
      scheduleClass: { ...editableClass, isModifiedOccurrence: true },
    });
    await wait();
    await wait();

    openOccurrenceEditor(window);
    await wait();

    const modal = window.document.querySelector(".occurrence-modal");
    expect(modal.textContent).toContain("Revert to default");
    [...modal.querySelectorAll("button")]
      .find((b) => b.textContent === "Revert to default")
      .click();
    await wait();

    const call = window.__calls.find((c) => c[0] === "clearScheduleException");
    expect(call[1]).toBe("class-1");
  });

  test("saving the series without an end date is rejected without touching the class", async () => {
    const window = loadCalendar("tutor", {
      scheduleClass: {
        ...editableClass,
        firstDate: TUT_ISO,
        endDate: "2099-12-31",
      },
    });
    await wait();
    await wait();

    openOccurrenceEditor(window);
    await wait();

    const modal = window.document.querySelector(".occurrence-modal");
    modal.querySelector("#occurrence-repeat-until").value = "";
    [...modal.querySelectorAll("button")]
      .find((b) => b.textContent === "Update all future classes")
      .click();
    await wait();

    expect(window.__calls.some((c) => c[0] === "updateScheduleClass")).toBe(
      false,
    );
  });

  test("a repeat ending before it starts is rejected", async () => {
    const window = loadCalendar("tutor", {
      scheduleClass: {
        ...editableClass,
        firstDate: TUT_ISO,
        endDate: "2099-12-31",
      },
    });
    await wait();
    await wait();

    openOccurrenceEditor(window);
    await wait();

    const modal = window.document.querySelector(".occurrence-modal");
    modal.querySelector("#occurrence-repeat-from").value = "2026-02-10";
    modal.querySelector("#occurrence-repeat-until").value = "2026-02-03";
    [...modal.querySelectorAll("button")]
      .find((b) => b.textContent === "Update all future classes")
      .click();
    await wait();

    expect(window.__calls.some((c) => c[0] === "updateScheduleClass")).toBe(
      false,
    );
  });

  test("saving the series with a valid range updates the class and follows the new start date's weekday", async () => {
    const window = loadCalendar("tutor", {
      scheduleClass: {
        ...editableClass,
        firstDate: TUT_ISO,
        endDate: "2099-12-31",
      },
    });
    await wait();
    await wait();

    openOccurrenceEditor(window);
    await wait();

    const modal = window.document.querySelector(".occurrence-modal");
    modal.querySelector("#occurrence-repeat-from").value = "2026-02-02"; // a Monday
    modal.querySelector("#occurrence-repeat-until").value = "2026-03-31";
    [...modal.querySelectorAll("button")]
      .find((b) => b.textContent === "Update all future classes")
      .click();
    await wait();

    const call = window.__calls.find((c) => c[0] === "updateScheduleClass");
    expect(call[2]).toMatchObject({
      firstDate: "2026-02-02",
      endDate: "2026-03-31",
      dayOfWeek: 1,
    });
  });

  test("unticking the repeat stops the series after the day being edited", async () => {
    const window = loadCalendar("tutor", {
      scheduleClass: {
        ...editableClass,
        firstDate: TUT_ISO,
        endDate: "2099-12-31",
      },
    });
    await wait();
    await wait();

    const cell = openOccurrenceEditor(window);
    await wait();

    const modal = window.document.querySelector(".occurrence-modal");
    modal.querySelector("#occurrence-repeat").click();
    [...modal.querySelectorAll("button")]
      .find((b) => b.textContent === "Update all future classes")
      .click();
    await wait();

    const call = window.__calls.find((c) => c[0] === "updateScheduleClass");
    const dayNum = Number(
      cell.querySelector(".calendar-day-number").textContent,
    );
    expect(call[2].endDate).toBe(isoOfDay(dayNum));
  });

  test("deleting the series asks first, and only a confirmed click deletes", async () => {
    const window = loadCalendar("tutor", {
      scheduleClass: { ...editableClass, firstDate: TUT_ISO, endDate: TUT_ISO },
    });
    await wait();
    await wait();

    openOccurrenceEditor(window);
    await wait();

    [
      ...window.document
        .querySelector(".occurrence-modal")
        .querySelectorAll("button"),
    ]
      .find((b) => b.textContent === "Delete all future classes")
      .click();
    await wait();

    const confirmModal = window.document.getElementById("confirm-modal");
    expect(confirmModal.textContent).toContain(
      "Remove this recurring class and all its future occurrences?",
    );

    window.document.getElementById("confirm-modal-cancel-btn").click();
    await wait();
    expect(window.__calls.some((c) => c[0] === "deleteScheduleClass")).toBe(
      false,
    );

    // Reopen and confirm this time.
    openOccurrenceEditor(window);
    await wait();
    [
      ...window.document
        .querySelector(".occurrence-modal")
        .querySelectorAll("button"),
    ]
      .find((b) => b.textContent === "Delete all future classes")
      .click();
    await wait();
    window.document.getElementById("confirm-modal-confirm-btn").click();
    await wait();

    expect(window.__calls.some((c) => c[0] === "deleteScheduleClass")).toBe(
      true,
    );
    const deleted = window.__calls.find((c) => c[0] === "deleteScheduleClass");
    expect(deleted[1]).toBe("class-1");
  });

  test("a cancelled occurrence offers restore, shows in the day view, and Close is a no-op", async () => {
    const window = loadCalendar("tutor", {
      scheduleClass: editableClass,
      cancelled: [
        {
          id: "class-1",
          title: "COMS2000 Lecture",
          startTime: "10:00",
          endTime: "12:00",
        },
      ],
      // Also an excused course session, excused before session_type existed —
      // the legacy key ("<courseId>|<date>|*") must still match the tutorial.
      tutorApps: [{ status: "approved", course_id: 7, courses: tutorCourse }],
      excusals: [
        {
          course_id: 7,
          session_date: TUT_ISO,
          reason: "Sick day",
          cover: { name: "Nora N" },
        },
      ],
    });
    await wait();
    await wait();

    // Grid: the cancelled pill and the legacy-excused course pill both show.
    const cell = currentMonthCell(window, TUT_ISO);
    const cancelledPill = cell.querySelector(".calendar-class-pill--cancelled");
    expect(cancelledPill.textContent).toContain("\u2715 COMS2000");
    expect(cancelledPill.title).toBe(
      "COMS2000 Lecture cancelled for this day · click to restore",
    );
    expect(
      cell.querySelector(".calendar-course-pill--excused").title,
    ).toContain("Reason: Sick day");

    // Clicking it opens the cancelled-state editor; restore clears the exception.
    cancelledPill.click();
    await wait();
    const modal = window.document.querySelector(".occurrence-modal");
    expect(modal.querySelector("h2").textContent).toBe("Cancelled class");
    expect(modal.textContent).toContain("This class is cancelled on this day.");
    [...modal.querySelectorAll("button")]
      .find((b) => b.textContent === "Restore this class")
      .click();
    await wait();
    expect(window.document.querySelector(".occurrence-modal")).toBeNull();
    const restore = window.__calls.find(
      (c) => c[0] === "clearScheduleException",
    );
    expect(restore[1]).toBe("class-1");
    expect(restore[2]).toBe(TUT_ISO);

    // The day view shows the excused session and the cancellation; the
    // cancelled block opens the same editor, whose Close is a no-op.
    cell.click();
    await wait();
    const overlay = window.document.querySelector(".day-view-overlay");
    expect(overlay.querySelector(".day-view-event--excused")).not.toBeNull();
    const cancelledBlock = overlay.querySelector(".day-view-event--cancelled");
    expect(cancelledBlock.textContent).toContain("\u2715 COMS2000 Lecture");
    cancelledBlock.click();
    await wait();
    expect(window.document.querySelector(".day-view-overlay")).toBeNull();
    expect(
      window.document.querySelector(".occurrence-modal h2").textContent,
    ).toBe("Cancelled class");
    [
      ...window.document
        .querySelector(".occurrence-modal")
        .querySelectorAll("button"),
    ]
      .find((b) => b.textContent === "Close")
      .click();
    await wait();
    expect(
      window.__calls.filter((c) => c[0] === "clearScheduleException"),
    ).toHaveLength(1);
  });
});

describe("calendar.js — clear-classes confirm gate", () => {
  test("declining the confirm leaves the schedule alone; confirming clears it", async () => {
    const window = loadCalendar("tutor", {});
    await wait();
    await wait();

    window.document.getElementById("clear-classes-btn").click();
    await wait();
    window.document.getElementById("confirm-modal-cancel-btn").click();
    await wait();
    expect(window.__calls.some((c) => c[0] === "clearSchedule")).toBe(false);

    window.document.getElementById("clear-classes-btn").click();
    await wait();
    window.document.getElementById("confirm-modal-confirm-btn").click();
    await wait();
    expect(window.__calls.some((c) => c[0] === "clearSchedule")).toBe(true);
  });
});

describe("calendar.js — volunteer course claims", () => {
  test("approved recurring claims load (lab and tutorial slots); claimed overflow sessions stay out", async () => {
    const window = loadCalendar("volunteer", {
      volunteerApps: [
        {
          status: "approved",
          course_id: 5,
          courses: {
            course_code: "COMS1016A",
            course_name: "Intro to CS",
            Day_of_lab: "Thursday",
            lab_start_time: "14:00:00",
            lab_end_time: "16:00:00",
            lab_venues: "MSL010",
            Day_of_tut: "Friday",
            tutor_start_time: "09:00:00",
            tutor_end_time: "10:00:00",
            venues: "MSL004",
          },
        },
        {
          status: "approved",
          course_id: 6,
          // A claimed overflow session has its own date — deliberately
          // excluded from the recurring course-session slots.
          session_date: TUT_ISO,
          courses: { ...tutorCourse, course_code: "SKIP9999" },
        },
        {
          status: "pending",
          course_id: 7,
          courses: { ...tutorCourse, course_code: "PENDING888" },
        },
      ],
    });
    await wait();
    await wait();

    // The student page has no colour key — recurring claims only feed it, so
    // the visible grid must stay untouched (no cover pills from claims).
    expect(
      window.document.querySelectorAll(".calendar-day").length,
    ).toBeGreaterThan(0);
    expect(
      window.document.querySelectorAll(".calendar-course-pill--cover"),
    ).toHaveLength(0);
  });
});

describe("calendar.js — api failures degrade gracefully", () => {
  test("a tutor whose session endpoints fail still gets a usable grid", async () => {
    const window = loadCalendar("tutor", {
      tutorAppsFail: true,
      excusalsFail: true,
    });
    await wait();
    await wait();

    expect(
      window.document.querySelectorAll(".calendar-day").length,
    ).toBeGreaterThan(0);
    expect(window.document.getElementById("course-color-key").hidden).toBe(
      true,
    );
    expect(window.document.querySelector(".calendar-course-pill")).toBeNull();
  });

  test("a volunteer whose session endpoints fail still gets a usable grid", async () => {
    const window = loadCalendar("volunteer", {
      volunteerAppsFail: true,
      coversFail: true,
    });
    await wait();
    await wait();

    expect(
      window.document.querySelectorAll(".calendar-day").length,
    ).toBeGreaterThan(0);
    expect(
      window.document.querySelectorAll(".calendar-course-pill--cover"),
    ).toHaveLength(0);
  });
});

describe("calendar.js — student volunteer covers", () => {
  const coverExcusal = {
    session_date: TUT_ISO,
    course_id: 3,
    session_type: "lab",
    courses: {
      course_code: "COMS1016A",
      course_name: "Intro to CS",
      Day_of_lab: "Thursday",
      lab_start_time: "14:00:00",
      lab_end_time: "16:00:00",
      lab_venues: "MSL010",
    },
    tutors: { name: "Tessa T" },
  };

  test("a cover renders a Cover pill on the right date with the tutor in its tooltip", async () => {
    const window = loadCalendar("volunteer", { covers: [coverExcusal] });
    await wait();
    await wait();

    const pill = currentMonthCell(window, TUT_ISO).querySelector(
      ".calendar-course-pill--cover",
    );
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain("Cover");
    expect(pill.textContent).toContain("14:00 COMS1016A · Lab");
    expect(pill.title).toContain("You're covering COMS1016A Lab for Tessa T");
  });

  test("the day view shows the cover and logged hours as blocks; untimed covers become chips", async () => {
    const window = loadCalendar("volunteer", {
      covers: [
        coverExcusal,
        // No times on the course row — the day view can't place it on the
        // hour grid, so it must fall back to a chip under it.
        {
          ...coverExcusal,
          courses: { course_code: "COMS9999", course_name: "Extra" },
        },
      ],
      entries: [
        {
          startTime: "09:00",
          endTime: "10:00",
          hours: 1,
          subject: "PHYS1000",
          notes: "",
        },
      ],
    });
    await wait();
    await wait();

    currentMonthCell(window, TUT_ISO).click();
    await wait();

    const overlay = window.document.querySelector(".day-view-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector(".day-view-empty")).toBeNull();

    const coverBlock = overlay.querySelector(".day-view-event--cover");
    expect(coverBlock).not.toBeNull();
    expect(coverBlock.title).toContain("for Tessa T");

    const hoursBlock = overlay.querySelector(".day-view-event--hours");
    expect(hoursBlock).not.toBeNull();
    expect(hoursBlock.textContent).toContain("PHYS1000");

    const chip = overlay.querySelector(".day-view-extra-chip");
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("COMS9999");
  });

  test("clicking an empty day-view slot closes it and pre-fills the add-class form", async () => {
    const window = loadCalendar("volunteer", { covers: [coverExcusal] });
    await wait();
    await wait();

    currentMonthCell(window, TUT_ISO).click();
    await wait();

    const lane = window.document.querySelector(".day-view-lane");
    lane.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, clientY: 0 }),
    );
    await wait();

    expect(window.document.querySelector(".day-view-overlay")).toBeNull();
    const card = window.document.getElementById("add-class-card");
    expect(card.hidden).toBe(false);
    expect(window.document.getElementById("add-class-date").value).toBe(
      TUT_ISO,
    );
    // The click lands at the very top of the lane — the first half-hour slot
    // of the grid's opening hour.
    expect(window.document.getElementById("add-class-start").value).toBe(
      "06:00",
    );
    expect(window.document.getElementById("add-class-end").value).toBe("07:00");
  });
});
