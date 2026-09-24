// Board.js is a plain browser script (no module.exports, top-level
// const/let state) written to run inside a real page, not to be
// require()'d as a CommonJS module. To test its keyboard-navigation
// behaviour honestly — including the exact bug this feature fixed, where
// nothing has keyboard focus yet — we load the real board.html + board.js
// into an actual jsdom document per test and drive it through real
// KeyboardEvents, the same way a browser would.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const boardHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "board.html"),
  "utf8",
);
const boardJs = fs.readFileSync(path.join(__dirname, "board.js"), "utf8");

// Appended to board.js's own script text so it shares board.js's top-level
// scope (COURSES, activeCourseId, renderCourseList) without board.js having
// to export anything for tests — it never runs in a CommonJS context in
// production, so it must not gain a module.exports.
const testHooks = `
window.__test = {
  pushCourse: (c) => COURSES.push(c),
  renderCourseList: () => renderCourseList(),
  getActiveCourseId: () => activeCourseId,
};
`;

// board.js's init() starts a polling interval for live updates — closing
// each window after its test stops those timers, otherwise they'd keep
// firing against a torn-down document and leave the Jest process hanging.
const openDoms = [];

function loadBoard() {
  const html = boardHtml
    .replace(
      '<script src="../js/board.js"></script>',
      `<script>\n${boardJs}\n${testHooks}\n</script>`,
    )
    .replace('<script src="../js/logout.js"></script>', "")
    .replace('<script src="../js/onboarding.js"></script>', "");

  const dom = new JSDOM(html, {
    url: "http://localhost/board.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // The init IIFE calls fetchCourses() etc. — stub fetch so those
      // resolve to nothing instead of throwing ReferenceError.
      window.fetch = () => Promise.resolve({ ok: true, json: async () => [] });
      if (!window.CSS) window.CSS = {};
      if (!window.CSS.escape) {
        window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }
    },
  });

  openDoms.push(dom);
  return dom.window;
}

afterEach(() => {
  openDoms.splice(0).forEach((dom) => dom.window.close());
});

function seedThreeCourses(window) {
  window.__test.pushCourse({
    id: "c1",
    code: "COMS1000",
    name: "Intro to Testing",
    tutorsAssigned: 1,
    tutorsNeeded: 2,
  });
  window.__test.pushCourse({
    id: "c2",
    code: "COMS2000",
    name: "Data Structures",
    tutorsAssigned: 2,
    tutorsNeeded: 2,
  });
  window.__test.pushCourse({
    id: "c3",
    code: "COMS3000",
    name: "Advanced Testing",
    tutorsAssigned: 0,
    tutorsNeeded: 1,
  });
  window.__test.renderCourseList();
}

// Waits for the init IIFE's stubbed-fetch promises to settle before a test
// touches the DOM it builds.
function ready() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function press(window, key) {
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  window.document.dispatchEvent(event);
  return event;
}

describe("board.js keyboard navigation", () => {
  test("ArrowDown with nothing focused selects the first course and suppresses page scroll", async () => {
    const window = loadBoard();
    await ready();
    seedThreeCourses(window);

    window.document.body.focus();
    expect(window.document.activeElement.tagName).toBe("BODY");
    expect(window.__test.getActiveCourseId()).toBeNull();

    const event = press(window, "ArrowDown");

    expect(event.defaultPrevented).toBe(true);
    expect(window.__test.getActiveCourseId()).toBe("c1");
    expect(window.document.activeElement.className).toContain("course-card");
    expect(window.document.activeElement.textContent).toContain(
      "Intro to Testing",
    );
  });

  test("repeated ArrowDown moves forward one course at a time and clamps at the last course", async () => {
    const window = loadBoard();
    await ready();
    seedThreeCourses(window);

    press(window, "ArrowDown"); // -> c1
    press(window, "ArrowDown"); // -> c2
    expect(window.__test.getActiveCourseId()).toBe("c2");

    press(window, "ArrowDown"); // -> c3
    expect(window.__test.getActiveCourseId()).toBe("c3");

    press(window, "ArrowDown"); // stays on c3, no 4th course
    expect(window.__test.getActiveCourseId()).toBe("c3");
  });

  test("ArrowUp moves backward and clamps at the first course", async () => {
    const window = loadBoard();
    await ready();
    seedThreeCourses(window);

    press(window, "ArrowDown"); // -> c1
    press(window, "ArrowDown"); // -> c2

    const event = press(window, "ArrowUp"); // -> c1
    expect(event.defaultPrevented).toBe(true);
    expect(window.__test.getActiveCourseId()).toBe("c1");

    press(window, "ArrowUp"); // stays on c1
    expect(window.__test.getActiveCourseId()).toBe("c1");
  });

  test("Home and End jump to the first and last course", async () => {
    const window = loadBoard();
    await ready();
    seedThreeCourses(window);

    press(window, "ArrowDown"); // -> c1, just to establish a position

    const endEvent = press(window, "End");
    expect(endEvent.defaultPrevented).toBe(true);
    expect(window.__test.getActiveCourseId()).toBe("c3");

    const homeEvent = press(window, "Home");
    expect(homeEvent.defaultPrevented).toBe(true);
    expect(window.__test.getActiveCourseId()).toBe("c1");
  });

  test("does not hijack arrow keys while typing in the course search field", async () => {
    const window = loadBoard();
    await ready();
    seedThreeCourses(window);

    const searchInput = window.document.getElementById("courseSearch");
    searchInput.focus();

    const event = press(window, "ArrowDown");

    expect(event.defaultPrevented).toBe(false);
    expect(window.__test.getActiveCourseId()).toBeNull();
  });

  test("ignores keys other than ArrowDown/ArrowUp/Home/End", async () => {
    const window = loadBoard();
    await ready();
    seedThreeCourses(window);

    const event = press(window, "a");

    expect(event.defaultPrevented).toBe(false);
    expect(window.__test.getActiveCourseId()).toBeNull();
  });
});
