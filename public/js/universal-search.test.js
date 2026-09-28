// universal-search.js is the shared header search dropped into board.html,
// tutors.html, and timesheet-review.html. Plain browser script — loaded
// into a real jsdom window with a stubbed fetch and the //# sourceURL tag
// so Jest's v8 coverage attributes executed lines back to the real file.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const searchJs = fs.readFileSync(
  path.join(__dirname, "universal-search.js"),
  "utf8",
);

const SEARCH_MARKUP = `
  <div class="universal-search">
    <input id="universalSearchInput">
    <ul id="universalSearchResults" hidden></ul>
  </div>
`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

const COURSES = [
  { id: "c1", course_code: "MATH1000", course_name: "Intro Maths" },
  { id: "c2", course_code: "PHYS2000", course_name: "Physics" },
];

const TUTORS = [
  { id: "t1", name: "Ann Smith", student_number: "123", email: "ann@x" },
  { id: "t2", name: null, student_number: "456", email: "zed@y" },
];

const TIMESHEETS = [
  {
    user_id: "u1",
    week_start: "2026-09-01T00:00:00",
    users: { name: "Ann Smith" },
  },
  // No users join — must not break the matcher for any query.
  { user_id: "u2", week_start: "2026-09-08T00:00:00" },
  // Matched tutor with an unknown week start.
  { user_id: "u3", week_start: null, users: { name: "Ann Smith" } },
];

function defaultRespond(url) {
  if (url === "/api/courses") return jsonResponse(COURSES);
  if (url === "/api/tutors") return jsonResponse(TUTORS);
  if (url === "/api/timesheets") return jsonResponse(TIMESHEETS);
  throw new Error(`unexpected fetch: ${url}`);
}

function loadSearch({ markup = SEARCH_MARKUP, respond } = {}) {
  const calls = [];
  const dom = new JSDOM(
    `<!doctype html><html><body>${markup}<script>${searchJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "universal-search.js")).href}</script></body></html>`,
    {
      url: "http://localhost/board.html",
      runScripts: "dangerously",
      beforeParse(window) {
        window.fetch = (url) => {
          calls.push(String(url));
          return respond(String(url));
        };
      },
    },
  );

  return { win: dom.window, calls };
}

describe("universal-search.js", () => {
  test("does nothing on pages without the search markup", () => {
    const { win, calls } = loadSearch({
      markup: "<p>plain page</p>",
      respond: defaultRespond,
    });

    expect(calls).toHaveLength(0);
    expect(win.document.querySelector("#universalSearchResults")).toBeNull();
  });

  test("matches courses, tutors, and timesheets as the user types", async () => {
    const { win, calls } = loadSearch({ respond: defaultRespond });
    await flush();
    expect(calls).toEqual(["/api/courses", "/api/tutors", "/api/timesheets"]);

    const input = win.document.getElementById("universalSearchInput");
    const results = win.document.getElementById("universalSearchResults");
    const type = (value) => {
      input.value = value;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    };

    // Course-code match.
    type("math");
    expect(results.hidden).toBe(false);
    expect(results.innerHTML).toContain("Courses");
    expect(results.innerHTML).toContain("board.html?course=c1");
    expect(results.innerHTML).toContain("MATH1000 — Intro Maths");

    // Course-name-only match.
    type("intro");
    expect(results.innerHTML).toContain("MATH1000 — Intro Maths");
    expect(results.innerHTML).not.toContain("PHYS2000");

    // Tutor name + timesheet (joined user name) matches, plus the
    // student-number suffix on the tutor link.
    type("smith");
    expect(results.innerHTML).toContain("Tutors");
    expect(results.innerHTML).toContain("tutors.html?highlight=t1");
    expect(results.innerHTML).toContain("Ann Smith — 123");
    expect(results.innerHTML).toContain("Timesheets");
    expect(results.innerHTML).toContain(
      "timesheet-review.html?highlight=u1_2026-09-01T00:00:00",
    );
    expect(results.innerHTML).toContain("week of 01/09/2026");
    // Null week_start renders an empty date rather than crashing.
    expect(results.innerHTML).toContain("Ann Smith — week of ");

    // Tutor email match, with a null name falling back to "Unnamed tutor".
    type("zed");
    expect(results.innerHTML).toContain("tutors.html?highlight=t2");
    expect(results.innerHTML).toContain("Unnamed tutor — 456");

    // Tutor student-number match.
    type("123");
    expect(results.innerHTML).toContain("Ann Smith — 123");

    type("zzz");
    expect(results.innerHTML).toContain("No matches");

    type("   ");
    expect(results.hidden).toBe(true);
    expect(results.innerHTML).toBe("");

    // Focusing re-shows results for a non-empty query and does nothing
    // for an empty one.
    input.value = "math";
    input.dispatchEvent(new win.Event("focus"));
    expect(results.hidden).toBe(false);

    input.value = "";
    input.dispatchEvent(new win.Event("focus"));
    expect(results.hidden).toBe(false);

    // Clicks outside the search (or anywhere inside it) toggle visibility.
    win.document.body.click();
    expect(results.hidden).toBe(true);

    input.value = "math";
    input.dispatchEvent(new win.Event("focus"));
    input.click();
    expect(results.hidden).toBe(false);
  });

  test("survives failing endpoints (rejection and non-ok responses)", async () => {
    // All endpoints reject: every list resets to empty.
    const failed = loadSearch({
      respond: () => Promise.reject(new Error("offline")),
    });
    await flush();
    const inputA = failed.win.document.getElementById("universalSearchInput");
    inputA.value = "math";
    inputA.dispatchEvent(new failed.win.Event("input", { bubbles: true }));
    expect(
      failed.win.document.getElementById("universalSearchResults").innerHTML,
    ).toContain("No matches");

    // Non-ok courses/tutors fall back to empty lists while timesheets
    // keep working.
    const partial = loadSearch({
      respond: (url) =>
        url === "/api/timesheets"
          ? jsonResponse(TIMESHEETS)
          : jsonResponse([], false),
    });
    await flush();
    const inputB = partial.win.document.getElementById("universalSearchInput");
    inputB.value = "smith";
    inputB.dispatchEvent(new partial.win.Event("input", { bubbles: true }));
    const htmlB = partial.win.document.getElementById(
      "universalSearchResults",
    ).innerHTML;
    expect(htmlB).toContain("Timesheets");
    expect(htmlB).not.toContain("Courses");
    expect(htmlB).not.toContain("Tutors</li>");
  });
});
