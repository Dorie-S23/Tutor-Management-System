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
const { pathToFileURL } = require("url");

const boardHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "board.html"),
  "utf8",
);
const boardJs = fs.readFileSync(path.join(__dirname, "board.js"), "utf8");
// board.js's preset picker reads window.AllocationObjectives, which the real
// page provides via this script tag — inline it the same way so the tested
// markup matches production.
const allocationObjectivesJs = fs.readFileSync(
  path.join(__dirname, "allocation-objectives.js"),
  "utf8",
);

// Injected as a separate <script> tag right after board.js's — classic
// scripts share the page's global scope, so it still reaches board.js's
// top-level bindings (COURSES, activeCourseId, renderCourseList) without
// board.js having to export anything for tests — it never runs in a
// CommonJS context in production, so it must not gain a module.exports.
const testHooks = `
window.__test = {
  pushCourse: (c) => COURSES.push(c),
  pushLockedCourse: (c) => LOCKED_COURSES.push(c),
  renderCourseList: () => renderCourseList(),
  getActiveCourseId: () => activeCourseId,
};
`;

// board.js's init() starts a polling interval for live updates — closing
// each window after its test stops those timers, otherwise they'd keep
// firing against a torn-down document and leave the Jest process hanging.
const openDoms = [];

function loadBoard({ user } = {}) {
  // Each injected script must be byte-identical to the copy run by the
  // sibling suite for that file (allocation-objectives.test.js and
  // board.transcript.test.js) — Jest's v8 coverage merges scripts by URL
  // and only overlaps cleanly when their text layouts match.
  const html = boardHtml
    .replace(
      '<script src="../js/allocation-objectives.js"></script>',
      `<script>${allocationObjectivesJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "allocation-objectives.js")).href}</script>`,
    )
    .replace(
      '<script src="../js/board.js"></script>',
      `<script>${boardJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "board.js")).href}\n</script>` +
        `<script>${testHooks}</script>`,
    )
    .replace('<script src="../js/logout.js"></script>', "")
    .replace('<script src="../js/onboarding.js"></script>', "");

  const dom = new JSDOM(html, {
    url: "http://localhost/board.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // board.js gates the "+ Add course" button on the signed-in user's
      // role, so tests that assert on it seed the session first.
      if (user) {
        window.sessionStorage.setItem("user", JSON.stringify(user));
      }
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

  test("locked courses render after the organiser's own and open the request-access panel", async () => {
    const window = loadBoard();
    await ready();

    window.__test.pushCourse({
      id: "c1",
      code: "COMS1000",
      name: "Intro to Testing",
      tutorsAssigned: 1,
      tutorsNeeded: 2,
      accessible: true,
    });
    window.__test.pushLockedCourse({
      id: "c9",
      code: "COMS9000",
      name: "Someone Elses Course",
      department: "Computer Science",
      minMark: 60,
      tutorsAssigned: 0,
      tutorsNeeded: 1,
    });
    window.__test.renderCourseList();

    const cards = Array.from(window.document.querySelectorAll(".course-card"));
    expect(cards).toHaveLength(2);
    // Accessible course stays to the left; the locked one is greyed.
    expect(cards[0].textContent).toContain("Intro to Testing");
    expect(cards[1].textContent).toContain("Someone Elses Course");
    expect(cards[1].classList.contains("course-card--locked")).toBe(true);
    expect(cards[1].textContent).toContain("No access");
    expect(cards[1].style.getPropertyValue("--accent")).toBe("");

    cards[1].click();

    expect(window.__test.getActiveCourseId()).toBe("c9");
    expect(
      window.document
        .getElementById("courseDetail")
        .classList.contains("course-detail--locked"),
    ).toBe(true);
    expect(window.document.getElementById("lockedPanel").hidden).toBe(false);
  });

  test("keyboard navigation reaches a locked course too", async () => {
    const window = loadBoard();
    await ready();
    window.__test.pushCourse({
      id: "c1",
      code: "COMS1000",
      name: "Intro to Testing",
      tutorsAssigned: 1,
      tutorsNeeded: 2,
      accessible: true,
    });
    window.__test.pushLockedCourse({
      id: "c9",
      code: "COMS9000",
      name: "Someone Elses Course",
      department: "Computer Science",
      minMark: 60,
      tutorsAssigned: 0,
      tutorsNeeded: 1,
    });
    window.__test.renderCourseList();

    press(window, "End");

    expect(window.__test.getActiveCourseId()).toBe("c9");
    expect(window.document.getElementById("lockedPanel").hidden).toBe(false);
  });

  test("the add-course button shows only for the super-organiser", async () => {
    const plain = loadBoard({
      user: { id: "org1", role: "organiser", courseIds: [1] },
    });
    await ready();
    expect(plain.document.getElementById("addCourseBtn").hidden).toBe(true);

    const superWin = loadBoard({
      user: { id: "admin1", role: "super_organiser" },
    });
    await ready();
    expect(superWin.document.getElementById("addCourseBtn").hidden).toBe(false);
  });
});
