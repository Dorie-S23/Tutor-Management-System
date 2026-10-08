// Verifies fetchCourseSessions()'s role dispatch: calendar.js is shared by
// calendar.html (tutor) and student-calendar.html (student volunteer), each
// setting data-page-role so the same script pulls recurring Tutorial/Lab
// sessions from a different table depending on who's signed in. Loaded the
// same way calendar.render-race.test.js does — real HTML + JS in jsdom,
// imports stubbed out — with a small window.__test hook (same pattern as
// board.keyboard-nav.test.js) exposing the module-scope courseSessions
// array, since neither page has a DOM element that echoes it verbatim.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const NL = String.fromCharCode(10);

const rawCalendarJs = fs.readFileSync(
  path.join(__dirname, "calendar.js"),
  "utf8",
);

function stubsFor(user) {
  return `
function highlightActiveTab() {}
function renderWelcomeHeading() {}
function requireRole() { return ${JSON.stringify(user)}; }
function getScheduleForDate() { return []; }
function getEntriesForDate() { return Promise.resolve([]); }
function getCancelledOccurrencesForDate() { return []; }
function addScheduleClasses() {}
function loadSchedule() {
  return Promise.resolve([]);
}
function cancelScheduleOccurrence() {}
function modifyScheduleOccurrence() {}
function clearScheduleException() {}
function updateScheduleClass() {}
function deleteScheduleClass() {}
function clearSchedule() {}
function todayStr() { return "2026-01-15"; }
`;
}

const testHook = `
window.__test = { getCourseSessions: () => courseSessions };
`;

function loadPage({ htmlFile, user, fetchImpl }) {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "html", htmlFile),
    "utf8",
  );

  // The injected copy of calendar.js must be byte-identical to the one
  // calendar.day-view.test.js runs — Jest's v8 coverage merges scripts by
  // URL and only overlaps cleanly when their text layouts match, so the
  // imports are sliced off and replaced by one padding newline each to keep
  // the remaining source's line numbers aligned with the real file.
  const calendarSliceStart = rawCalendarJs.indexOf("const pageRole");
  const calendarJs = rawCalendarJs.slice(calendarSliceStart);
  const calendarJsPad = NL.repeat(
    rawCalendarJs.slice(0, calendarSliceStart).split(NL).length - 1,
  );

  const pageHtml = html
    .replace(
      '<script type="module" src="../js/calendar.js"></script>',
      `<script>${stubsFor(user)}\n${testHook}</script>` +
        `<script>${calendarJsPad}${calendarJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "calendar.js")).href}\n</script>`,
    )
    .replace(
      '<script type="module" src="../js/timetable-import.js"></script>',
      "",
    )
    .replace('<script src="../js/logout.js"></script>', "");

  const calls = [];
  const dom = new JSDOM(pageHtml, {
    url: `http://localhost/${htmlFile}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url) => {
        calls.push(String(url));
        return fetchImpl(String(url));
      };
    },
  });

  return { window: dom.window, calls };
}

function ready() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("calendar.js fetchCourseSessions() role dispatch", () => {
  test("tutor path: reads tutor_subject_preference via /api/tutor-applications", async () => {
    const { window, calls } = loadPage({
      htmlFile: "calendar.html",
      user: { id: "tutor-1", role: "tutor" },
      fetchImpl: async (url) => {
        if (url.includes("/api/tutor-applications")) {
          return {
            ok: true,
            json: async () => [
              {
                course_id: 1,
                status: "approved",
                courses: {
                  course_code: "COMS1000",
                  Day_of_tut: "Monday",
                  tutor_start_time: "10:00:00",
                  tutor_end_time: "12:00:00",
                  venues: "MSL004",
                },
              },
            ],
          };
        }
        return { ok: true, json: async () => [] };
      },
    });
    await ready();
    await window.fetchCourseSessions();

    expect(calls.some((u) => u.includes("/api/tutor-applications"))).toBe(true);
    expect(calls.some((u) => u.includes("/api/course-volunteers"))).toBe(false);

    const sessions = window.__test.getCourseSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      courseCode: "COMS1000",
      type: "Tutorial",
    });
  });

  test("student path: reads an approved whole-course volunteer application via /api/course-volunteers", async () => {
    const { window, calls } = loadPage({
      htmlFile: "student-calendar.html",
      user: { id: "student-1", role: "student" },
      fetchImpl: async (url) => {
        if (url.includes("/api/course-volunteers")) {
          return {
            ok: true,
            json: async () => [
              {
                course_id: 1,
                status: "approved",
                courses: {
                  course_code: "COMS1000",
                  Day_of_tut: "Monday",
                  tutor_start_time: "10:00:00",
                  tutor_end_time: "12:00:00",
                  venues: "MSL004",
                },
              },
            ],
          };
        }
        return { ok: true, json: async () => [] };
      },
    });
    await ready();
    await window.fetchCourseSessions();

    expect(calls.some((u) => u.includes("/api/course-volunteers"))).toBe(true);
    expect(calls.some((u) => u.includes("/api/tutor-applications"))).toBe(
      false,
    );

    const sessions = window.__test.getCourseSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      courseCode: "COMS1000",
      type: "Tutorial",
    });
  });

  test("student path: a claimed one-off session (has session_date) is not treated as recurring", async () => {
    const { window } = loadPage({
      htmlFile: "student-calendar.html",
      user: { id: "student-1", role: "student" },
      fetchImpl: async (url) => {
        if (url.includes("/api/course-volunteers")) {
          return {
            ok: true,
            json: async () => [
              {
                course_id: 1,
                status: "approved",
                session_date: "2026-06-01",
                courses: {
                  course_code: "COMS1000",
                  Day_of_tut: "Monday",
                  tutor_start_time: "10:00:00",
                  tutor_end_time: "12:00:00",
                },
              },
            ],
          };
        }
        return { ok: true, json: async () => [] };
      },
    });
    await ready();
    await window.fetchCourseSessions();

    expect(window.__test.getCourseSessions()).toEqual([]);
  });

  test("student path: a pending (not yet approved) application produces no session", async () => {
    const { window } = loadPage({
      htmlFile: "student-calendar.html",
      user: { id: "student-1", role: "student" },
      fetchImpl: async (url) => {
        if (url.includes("/api/course-volunteers")) {
          return {
            ok: true,
            json: async () => [
              {
                course_id: 1,
                status: "pending",
                courses: {
                  course_code: "COMS1000",
                  Day_of_tut: "Monday",
                  tutor_start_time: "10:00:00",
                  tutor_end_time: "12:00:00",
                },
              },
            ],
          };
        }
        return { ok: true, json: async () => [] };
      },
    });
    await ready();
    await window.fetchCourseSessions();

    expect(window.__test.getCourseSessions()).toEqual([]);
  });

  test("a fetch failure leaves courseSessions empty instead of throwing", async () => {
    const { window } = loadPage({
      htmlFile: "student-calendar.html",
      user: { id: "student-1", role: "student" },
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    await ready();
    await window.fetchCourseSessions();

    expect(window.__test.getCourseSessions()).toEqual([]);
  });
});
