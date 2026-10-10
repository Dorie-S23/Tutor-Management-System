// timetable.js is a plain browser script (no imports/exports) that renders
// the organiser's weekly grid from /api/courses, so it runs as-is inside a
// real jsdom document with a stubbed fetch — same pattern as the rest of
// this suite's frontend tests.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const src = fs.readFileSync(path.join(__dirname, "timetable.js"), "utf8");

// A full course row as /api/courses returns it.
function course(overrides = {}) {
  return {
    id: 1,
    course_code: "MATH2001",
    Day_of_tut: "Monday",
    tutor_start_time: "10:00:00",
    tutor_end_time: "11:00:00",
    venues: "MSL004",
    Day_of_lab: null,
    lab_start_time: null,
    lab_end_time: null,
    lab_venues: null,
    ...overrides,
  };
}

function withDom(courses, fn) {
  const dom = new JSDOM(
    `
    <body>
      <div id="timetableGrid"></div>
      <p id="timetableUnscheduled" hidden></p>
      <script>
        window.__courses = ${JSON.stringify(courses)};
        window.fetch = () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve(window.__courses),
          });
        ${src}
        //# sourceURL=${pathToFileURL(path.join(__dirname, "timetable.js")).href}
      </script>
    </body>
  `,
    { url: "http://localhost/html/timetable.html", runScripts: "dangerously" },
  );
  return dom.window;
}

// Wait for loadAndRender()'s fetch->render chain to settle.
async function rendered(window) {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  return window;
}

describe("timetable grid", () => {
  test("renders a block per scheduled session, with course and times", async () => {
    const window = await rendered(
      withDom([
        course(),
        course({
          id: 2,
          course_code: "CS2001",
          Day_of_tut: null, // only a lab this week
          tutor_start_time: null,
          tutor_end_time: null,
          venues: null,
          Day_of_lab: "Tuesday",
          lab_start_time: "14:00:00",
          lab_end_time: "16:00:00",
          lab_venues: "Lab1",
        }),
      ]),
    );

    const blocks = window.document.querySelectorAll(".timetable-session");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].textContent).toContain("MATH2001");
    expect(blocks[0].textContent).toContain("Tutorial · 10:00–11:00");
    expect(blocks[1].textContent).toContain("CS2001");
    expect(blocks[1].textContent).toContain("Lab · 14:00–16:00");
    // Each block links to its course on the board — selected, not straight
    // into the edit modal (board.html's ?course= deep link, same as the
    // universal search box uses).
    expect(blocks[0].href).toContain("board.html?course=1");
    expect(blocks[1].href).toContain("board.html?course=2");
  });

  test("flags a venue clash when two sessions share a room and overlap", async () => {
    const window = await rendered(
      withDom([
        course({ id: 1, course_code: "MATH2001" }),
        course({
          id: 2,
          course_code: "STAT2002",
          tutor_start_time: "10:30:00",
          tutor_end_time: "11:30:00",
        }),
      ]),
    );

    const blocks = [...window.document.querySelectorAll(".timetable-session")];
    expect(blocks).toHaveLength(2);
    blocks.forEach((block) => {
      expect(block.className).toContain("clash");
      expect(block.textContent).toContain("⚠");
    });
    // The clash title names the shared room and the other course.
    expect(blocks[0].title).toContain("MSL004");
    expect(blocks[0].title).toContain("STAT2002 Tutorial");
  });

  test("no clash flag when the times don't overlap, even in the same venue", async () => {
    const window = await rendered(
      withDom([
        course({ id: 1 }),
        course({
          id: 2,
          course_code: "STAT2002",
          tutor_start_time: "11:00:00",
          tutor_end_time: "12:00:00",
        }),
      ]),
    );

    const blocks = [...window.document.querySelectorAll(".timetable-session")];
    expect(blocks).toHaveLength(2);
    blocks.forEach((block) => {
      expect(block.className).not.toContain("clash");
    });
  });

  test("lays out overlapping sessions side-by-side in separate lanes", async () => {
    const window = await rendered(
      withDom([
        course({ id: 1 }),
        course({
          id: 2,
          course_code: "STAT2002",
          tutor_start_time: "10:30:00",
          tutor_end_time: "11:30:00",
          venues: "MSL999", // different room: side-by-side, not a clash
        }),
      ]),
    );

    const blocks = [...window.document.querySelectorAll(".timetable-session")];
    expect(blocks).toHaveLength(2);
    blocks.forEach((block) => {
      expect(block.className).not.toContain("clash");
    });
    // Side-by-side: same width, different horizontal offsets.
    expect(blocks[0].style.width).toBe(blocks[1].style.width);
    expect(blocks[0].style.left).not.toBe(blocks[1].style.left);
  });

  test("lists sessions with an unrecognised day or out-of-range time as unplaced", async () => {
    const window = await rendered(
      withDom([
        course({ id: 1, Day_of_tut: "Funday" }),
        course({
          id: 2,
          course_code: "EARLY101",
          tutor_start_time: "06:00:00",
          tutor_end_time: "07:00:00",
        }),
      ]),
    );

    const unscheduled = window.document.getElementById("timetableUnscheduled");
    expect(unscheduled.hidden).toBe(false);
    expect(unscheduled.textContent).toContain(
      "MATH2001 Tutorial (Funday 10:00–11:00)",
    );
    expect(unscheduled.textContent).toContain("EARLY101 Tutorial");
  });

  test("hides the unplaced notice when everything fits", async () => {
    const window = await rendered(withDom([course()]));
    const unscheduled = window.document.getElementById("timetableUnscheduled");
    expect(unscheduled.hidden).toBe(true);
  });

  test("builds a header cell per weekday plus the time column", async () => {
    const window = await rendered(withDom([course()]));
    const headers = [
      ...window.document.querySelectorAll(".timetable-grid-header"),
    ];
    // Corner cell + 7 days.
    expect(headers).toHaveLength(8);
    expect(headers.slice(1).map((h) => h.textContent)).toEqual([
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
    ]);
  });

  test("shows a friendly message when the courses can't be loaded", async () => {
    const dom = new JSDOM(
      `
      <body>
        <div id="timetableGrid"></div>
        <p id="timetableUnscheduled" hidden></p>
        <script>
          window.fetch = () => Promise.reject(new Error("down"));
          ${src}
          //# sourceURL=${pathToFileURL(path.join(__dirname, "timetable.js")).href}
        </script>
      </body>
    `,
      {
        url: "http://localhost/html/timetable.html",
        runScripts: "dangerously",
      },
    );

    await rendered(dom.window);
    const unscheduled = dom.window.document.getElementById(
      "timetableUnscheduled",
    );
    expect(unscheduled.hidden).toBe(false);
    expect(unscheduled.textContent).toContain("Couldn't load courses");
  });
});
