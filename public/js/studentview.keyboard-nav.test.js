// Same roving-tabindex feature as board.keyboard-nav.test.js, generalised to
// this page's several independent card lists. Loaded the same way
// studentview.dashboard.test.js does: as a classic script with storage.js's
// and highlightTarget.js's imports stubbed out, since jsdom doesn't reliably
// run <script type="module"> even with runScripts: "dangerously".
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "StudentView.html"),
  "utf8",
);
const studentviewSrc = fs
  .readFileSync(path.join(__dirname, "studentview.js"), "utf8")
  .replace(
    /^import \{[^}]*\} from ".\/(?:storage|highlightTarget)\.js";$/gm,
    "",
  );

const stubs = `
function requireRole() {
  return { id: "student-1", name: "Test Student", role: "student" };
}
async function getEntries() { return []; }
function consumeQueryParam() { return null; }
function scrollAndHighlight() {}
`;

function loadPage({ courses = [], applications = [], openSessions = [] } = {}) {
  const script = `<script>${stubs}\n${studentviewSrc}\n</script>`;
  const pageHtml = html
    .replace(
      '<script type="module" src="../js/studentview.js"></script>',
      script,
    )
    .replace('<script src="../js/onboarding.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "");

  const dom = new JSDOM(pageHtml, {
    url: "http://localhost/StudentView.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = {};
      if (!window.CSS.escape) {
        window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }

      window.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes("/api/courses")) {
          return { ok: true, json: async () => courses };
        }
        if (u.includes("/api/course-volunteers") && opts?.method === "DELETE") {
          return { ok: true, status: 204, json: async () => ({}) };
        }
        if (u.includes("/api/course-volunteers?status=open")) {
          return { ok: true, json: async () => openSessions };
        }
        if (u.includes("/api/course-volunteers")) {
          return { ok: true, json: async () => applications };
        }
        return { ok: true, json: async () => [] };
      };
    },
  });

  return dom.window;
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function press(window, el, key) {
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
}

const THREE_COURSES = [
  {
    id: 1,
    course_code: "COMS1000",
    course_name: "Intro to Testing",
    department: "CS",
    tutors_needed: 2,
    no_of_tutors_assigned: 0,
  },
  {
    id: 2,
    course_code: "COMS2000",
    course_name: "Data Structures",
    department: "CS",
    tutors_needed: 2,
    no_of_tutors_assigned: 0,
  },
  {
    id: 3,
    course_code: "COMS3000",
    course_name: "Advanced Testing",
    department: "CS",
    tutors_needed: 1,
    no_of_tutors_assigned: 0,
  },
];

describe("studentview.js keyboard navigation", () => {
  test("the first card in a list is the only one in the tab order to start", async () => {
    const window = loadPage({ courses: THREE_COURSES });
    await wait();

    const cards = window.document.querySelectorAll("#courseList article");
    expect(cards.length).toBe(3);
    expect(cards[0].tabIndex).toBe(0);
    expect(cards[1].tabIndex).toBe(-1);
    expect(cards[2].tabIndex).toBe(-1);
  });

  test("ArrowDown moves focus to the next card and suppresses page scroll", async () => {
    const window = loadPage({ courses: THREE_COURSES });
    await wait();

    const cards = window.document.querySelectorAll("#courseList article");
    cards[0].focus();

    const event = press(window, cards[0], "ArrowDown");

    expect(event.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(cards[1]);
    expect(cards[1].tabIndex).toBe(0);
    expect(cards[0].tabIndex).toBe(-1);
  });

  test("repeated ArrowDown clamps at the last card", async () => {
    const window = loadPage({ courses: THREE_COURSES });
    await wait();

    const cards = window.document.querySelectorAll("#courseList article");
    cards[0].focus();
    press(window, cards[0], "ArrowDown");
    press(window, cards[1], "ArrowDown");
    press(window, cards[2], "ArrowDown"); // no 4th card

    expect(window.document.activeElement).toBe(cards[2]);
  });

  test("ArrowUp moves backward and clamps at the first card", async () => {
    const window = loadPage({ courses: THREE_COURSES });
    await wait();

    const cards = window.document.querySelectorAll("#courseList article");
    cards[2].focus();

    const event = press(window, cards[2], "ArrowUp");
    expect(event.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(cards[1]);

    press(window, cards[1], "ArrowUp");
    press(window, window.document.activeElement, "ArrowUp"); // stays on the first

    expect(window.document.activeElement).toBe(cards[0]);
  });

  test("Home and End jump to the first and last card", async () => {
    const window = loadPage({ courses: THREE_COURSES });
    await wait();

    const cards = window.document.querySelectorAll("#courseList article");
    cards[1].focus();

    const endEvent = press(window, cards[1], "End");
    expect(endEvent.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(cards[2]);

    const homeEvent = press(window, window.document.activeElement, "Home");
    expect(homeEvent.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(cards[0]);
  });

  test("does not hijack arrow keys while typing in a card's mark input", async () => {
    const window = loadPage({ courses: THREE_COURSES });
    await wait();

    const cards = window.document.querySelectorAll("#courseList article");
    cards[0].querySelector(".volunteer-btn").click();
    const markInput = cards[0].querySelector(".mark-input");
    markInput.focus();

    const event = press(window, markInput, "ArrowDown");

    expect(event.defaultPrevented).toBe(false);
    expect(window.document.activeElement).toBe(markInput);
  });

  test("each card list navigates independently of the others", async () => {
    const window = loadPage({
      courses: THREE_COURSES,
      openSessions: [
        {
          id: "s1",
          session_date: "2099-01-01",
          start_time: "09:00:00",
          end_time: "11:00:00",
          courses: { course_code: "OPEN1000", course_name: "Open one" },
        },
        {
          id: "s2",
          session_date: "2099-02-01",
          start_time: "09:00:00",
          end_time: "11:00:00",
          courses: { course_code: "OPEN2000", course_name: "Open two" },
        },
      ],
    });
    await wait();

    const courseCards = window.document.querySelectorAll("#courseList article");
    const sessionCards = window.document.querySelectorAll(
      "#openSessionsList article",
    );

    courseCards[0].focus();
    press(window, courseCards[0], "ArrowDown");
    expect(window.document.activeElement).toBe(courseCards[1]);

    // The open-sessions list still has its own untouched roving tabindex —
    // moving focus in #courseList didn't reset or interfere with it.
    expect(sessionCards[0].tabIndex).toBe(0);
    expect(sessionCards[1].tabIndex).toBe(-1);

    sessionCards[0].focus();
    press(window, sessionCards[0], "ArrowDown");
    expect(window.document.activeElement).toBe(sessionCards[1]);
  });
});
