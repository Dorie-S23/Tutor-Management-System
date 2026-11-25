// volunteer-log-hours.js is the volunteer "Log attendance" page: pick a
// session you're covering, and log it while it's happening (the same window
// the server enforces). It's an ES module importing storage.js (role guard +
// entry store) and sessionTiming.js (the logging-window rule), which jsdom
// can't run as a module graph — so the sources are loaded the way
// volunteer-timesheets.render.test.js does it: imports stripped, each file
// eval'd into the window with a sourceURL tag, sharing one global scope.
// The clock is pinned (my-sessions suite's trick) so the "log while it's
// happening" windows in the fixtures are exact whichever timezone runs.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const pageHtmlRaw = fs.readFileSync(
  path.join(__dirname, "..", "html", "volunteer-log-hours.html"),
  "utf8",
);
const timingJs = fs
  .readFileSync(path.join(__dirname, "sessionTiming.js"), "utf8")
  .replace(/^export /gm, "");
const timingJsUrl = pathToFileURL(
  path.join(__dirname, "sessionTiming.js"),
).href;
const storageJs = fs
  .readFileSync(path.join(__dirname, "storage.js"), "utf8")
  .replace(/^export (async function|function)/gm, "$1");
const storageJsUrl = pathToFileURL(path.join(__dirname, "storage.js")).href;
const pageJs = fs
  .readFileSync(path.join(__dirname, "volunteer-log-hours.js"), "utf8")
  // `import` isn't valid inside dom.window.eval (classic script semantics);
  // the sessionTiming import spans several lines, so the strip spans too.
  .replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
const pageJsUrl = pathToFileURL(
  path.join(__dirname, "volunteer-log-hours.js"),
).href;

// The identical newline-free shadow line storage.test.js prepends to its
// eval'd copy of storage.js — Jest's v8 coverage only merges the suites'
// copies cleanly when their text layouts match.
const shadowWindow = `var __fakeLocation = { href: "" }; const window = { location: __fakeLocation }; `;

// --- the pinned clock -------------------------------------------------------
const FIXED_NOW = "2026-09-29T12:00:00Z";
const fixedNowMs = Date.parse(FIXED_NOW);
const localDate = (offsetDays) => {
  const d = new Date(fixedNowMs + offsetDays * 24 * 60 * 60 * 1000);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
};
const TODAY = localDate(0);
const hm = (offsetMinutes) =>
  new Date(fixedNowMs + offsetMinutes * 60000).toTimeString().slice(0, 5);

// One session_excusals row (a session the volunteer covers), with the
// covered slot's times and venue living on the course's timetable columns.
function coverRow({
  courseId,
  courseCode,
  sessionType,
  dateOffset,
  startOffsetMin,
  endOffsetMin,
  venue,
}) {
  return {
    course_id: courseId,
    session_type: sessionType,
    session_date: localDate(dateOffset),
    courses: {
      id: courseId,
      course_code: courseCode,
      course_name: `${courseCode} course`,
      tutor_start_time: "",
      tutor_end_time: "",
      lab_start_time: "",
      lab_end_time: "",
      venues: "",
      lab_venues: "",
      ...(sessionType === "lab"
        ? {
            lab_start_time: `${hm(startOffsetMin)}:00`,
            lab_end_time: `${hm(endOffsetMin)}:00`,
            lab_venues: venue,
          }
        : {
            tutor_start_time: `${hm(startOffsetMin)}:00`,
            tutor_end_time: `${hm(endOffsetMin)}:00`,
            venues: venue,
          }),
    },
    tutors: { name: "Tutor One" },
  };
}

// Two live sessions (one per course), tomorrow's repeat of the first, and
// one already-expired session that must not reach the picker.
const COVERS = [
  coverRow({
    courseId: "c1",
    courseCode: "COMS1016A",
    sessionType: "tutorial",
    dateOffset: 0,
    startOffsetMin: -30,
    endOffsetMin: 10,
    venue: "NS 5",
  }),
  coverRow({
    courseId: "c1",
    courseCode: "COMS1016A",
    sessionType: "tutorial",
    dateOffset: 1,
    startOffsetMin: -30,
    endOffsetMin: 10,
    venue: "NS 5",
  }),
  coverRow({
    courseId: "c2",
    courseCode: "COMS2000",
    sessionType: "lab",
    dateOffset: 0,
    startOffsetMin: -90,
    endOffsetMin: 30,
    venue: "NS 10",
  }),
  coverRow({
    courseId: "c1",
    courseCode: "COMS1016A",
    sessionType: "tutorial",
    dateOffset: 0,
    startOffsetMin: -120,
    endOffsetMin: -90,
    venue: "NS 5",
  }),
];

function loadPage({ covers = COVERS, coversFail = false, entries = [] } = {}) {
  // Every external script on the page (theme, nav-menu, date-mask, the
  // module itself, notifications) is stripped — the sources under test are
  // eval'd by hand below.
  const pageHtml = pageHtmlRaw.replace(
    /<script[^>]*src="\.\.\/js\/[^"]*"[^>]*><\/script>/g,
    "",
  );

  const calls = [];

  const dom = new JSDOM(pageHtml, {
    url: "http://localhost/volunteer-log-hours.html",
    runScripts: "dangerously",
    beforeParse(window) {
      const RealDate = window.Date;
      class FixedDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(fixedNowMs);
          else super(...args);
        }
        static now() {
          return fixedNowMs;
        }
      }
      window.Date = FixedDate;
      window.sessionStorage.setItem(
        "user",
        JSON.stringify({ id: "v1", role: "volunteer" }),
      );
      // nav.js isn't worth loading just for the tab highlight.
      window.highlightActiveTab = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.fetch = async (fetchUrl, options = {}) => {
        const href = String(fetchUrl);
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url: href, method: options.method || "GET", body });
        if (href.startsWith("/api/session-excusals")) {
          if (coversFail) throw new Error("network down");
          return { ok: true, json: async () => covers };
        }
        if (href.startsWith("/api/hour-entries") && !options.method) {
          return { ok: true, json: async () => entries };
        }
        // POST /api/hour-entries — echo the entry back.
        return { ok: true, json: async () => ({ id: "e9", ...body }) };
      };
    },
  });

  // One sourceURL per eval so each file's coverage lands on its own lines;
  // they all evaluate in the window's global scope and share bindings.
  dom.window.eval(`${timingJs}\n//# sourceURL=${timingJsUrl}`);
  dom.window.eval(`${shadowWindow}${storageJs}\n//# sourceURL=${storageJsUrl}`);
  dom.window.eval(`${pageJs}\n//# sourceURL=${pageJsUrl}`);

  return { window: dom.window, document: dom.window.document, calls };
}

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const submitForm = (window, document) =>
  document
    .getElementById("attendance-form")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );

function pickCourse(document, courseCode) {
  const chip = [...document.querySelectorAll(".course-chip")].find((c) =>
    c.textContent.includes(courseCode),
  );
  chip.click();
  return chip;
}

function pickSession(document, index) {
  const chip = document.querySelectorAll(".session-chip")[index];
  chip.click();
  return chip;
}

describe("volunteer-log-hours.js", () => {
  test("boots one chip per covered course, expired sessions filtered out", async () => {
    const { document } = loadPage();
    await wait();

    const courseChips = document.querySelectorAll(".course-chip");
    expect(courseChips).toHaveLength(2);
    // Chips follow the soonest-session order: COMS2000's lab starts first.
    expect(courseChips[0].textContent).toContain("COMS2000");
    expect(courseChips[1].textContent).toContain("COMS1016A");
    expect(
      courseChips[0]
        .querySelector(".chip-icon")
        .classList.contains("chip-icon--blue"),
    ).toBe(true);

    pickCourse(document, "COMS1016A");
    const sessionChips = document.querySelectorAll(".session-chip");
    // Today's live session + tomorrow's; the expired one stays out.
    expect(sessionChips).toHaveLength(2);
    expect(sessionChips[0].className).toContain("is-open");
    expect(sessionChips[1].className).toContain("is-locked");
    expect(
      sessionChips[0].querySelector(".session-chip__time").textContent,
    ).toBe(`${hm(-30)}–${hm(10)} · NS 5`);
    expect(
      sessionChips[0].querySelector(".session-chip__note").textContent,
    ).toBe(`Log now — closes ${hm(20)}`);
    expect(
      sessionChips[1].querySelector(".session-chip__note").textContent,
    ).toBe(`Logging opens at ${hm(-30)}`);
  });

  test("a failed covers fetch shows the retry message", async () => {
    const { document } = loadPage({ coversFail: true });
    await wait();

    expect(document.getElementById("courseChips").textContent).toContain(
      "Couldn't load your covers right now — try again later.",
    );
  });

  test("no covers shows the empty state", async () => {
    const { document } = loadPage({ covers: [] });
    await wait();

    expect(document.getElementById("courseChips").textContent).toContain(
      "You aren't covering any sessions right now",
    );
  });

  test("picking the live session prefills the attendance card", async () => {
    const { document } = loadPage();
    await wait();

    pickCourse(document, "COMS1016A");
    pickSession(document, 0);

    expect(document.getElementById("attendanceCard").hidden).toBe(false);
    expect(document.getElementById("scheduledLabel").textContent).toBe(
      "Covering for Tutor One",
    );
    expect(document.getElementById("scheduledVenue").textContent).toBe("NS 5");
    // 40 minutes rounds up to a whole credited hour.
    expect(document.getElementById("startTime").value).toBe(hm(-30));
    expect(document.getElementById("endTime").value).toBe(hm(10));
    expect(document.getElementById("duration-value").textContent).toBe("1h");
    expect(document.getElementById("form-error").hidden).toBe(true);
  });

  test("picking a future session warns that logging isn't open yet", async () => {
    const { document } = loadPage();
    await wait();

    pickCourse(document, "COMS1016A");
    pickSession(document, 1);

    const formError = document.getElementById("form-error");
    expect(formError.hidden).toBe(false);
    expect(formError.textContent).toBe(
      `You can only log a session while it's happening — logging opens at ${hm(-30)}.`,
    );
  });

  test("the duration label tracks the time fields", async () => {
    const { window, document } = loadPage();
    await wait();

    pickCourse(document, "COMS1016A");
    pickSession(document, 0);
    const start = document.getElementById("startTime");
    const end = document.getElementById("endTime");
    const duration = document.getElementById("duration-value");
    const input = (el) =>
      el.dispatchEvent(new window.Event("input", { bubbles: true }));

    start.value = "09:00";
    end.value = "10:30";
    input(end);
    // 90 minutes rounds up to two credited hours.
    expect(duration.textContent).toBe("2h");

    end.value = "09:20";
    input(end);
    expect(duration.textContent).toBe("Rounds to 0h");

    end.value = "08:00";
    input(end);
    expect(duration.textContent).toBe("—");
  });

  test("submitting the live session posts a Peer support entry", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    pickCourse(document, "COMS1016A");
    pickSession(document, 0);
    document.getElementById("notes").value = "  covered for Alex  ";
    submitForm(window, document);
    await wait();

    const post = calls.find(
      (c) => c.method === "POST" && c.url === "/api/hour-entries",
    );
    expect(post.body).toEqual({
      userId: "v1",
      date: TODAY,
      hours: 1,
      startTime: hm(-30),
      endTime: hm(10),
      taskType: "Peer support",
      courseId: "c1",
      notes: "covered for Alex",
    });
    expect(document.getElementById("toast").textContent).toBe(
      "Attendance submitted — it's under Completed sessions.",
    );
    expect(document.getElementById("notes").value).toBe("");
    expect(document.getElementById("form-error").hidden).toBe(true);
  });

  test("an end time before the start is refused", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    pickCourse(document, "COMS1016A");
    pickSession(document, 0);
    document.getElementById("endTime").value = "00:00";
    submitForm(window, document);

    expect(document.getElementById("form-error").textContent).toBe(
      "The ending time must be after the starting time.",
    );
    expect(
      calls.some((c) => c.method === "POST" && c.url === "/api/hour-entries"),
    ).toBe(false);
  });

  test("under 30 minutes asks for a double-check", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    pickCourse(document, "COMS1016A");
    pickSession(document, 0);
    document.getElementById("startTime").value = "09:00";
    document.getElementById("endTime").value = "09:20";
    submitForm(window, document);

    expect(document.getElementById("form-error").textContent).toBe(
      "That's under 30 minutes — double-check the times before submitting.",
    );
    expect(
      calls.some((c) => c.method === "POST" && c.url === "/api/hour-entries"),
    ).toBe(false);
  });

  test("submitting a session outside its window shows the block message", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    pickCourse(document, "COMS1016A");
    pickSession(document, 1); // tomorrow's session: early
    submitForm(window, document);

    expect(document.getElementById("form-error").textContent).toBe(
      `You can only log a session while it's happening — logging opens at ${hm(-30)}.`,
    );
    expect(
      calls.some((c) => c.method === "POST" && c.url === "/api/hour-entries"),
    ).toBe(false);
  });

  test("an overlapping logged entry blocks the submit", async () => {
    const { window, document, calls } = loadPage({
      entries: [
        {
          id: "e1",
          date: TODAY,
          start_time: `${hm(-40)}:00`,
          end_time: `${hm(-20)}:00`,
        },
      ],
    });
    await wait();

    pickCourse(document, "COMS1016A");
    pickSession(document, 0);
    submitForm(window, document);
    await wait();

    expect(document.getElementById("form-error").textContent).toBe(
      "This overlaps an entry you've already logged for this day.",
    );
    expect(
      calls.some((c) => c.method === "POST" && c.url === "/api/hour-entries"),
    ).toBe(false);
  });

  test("a failed submit surfaces the server's message and re-enables the button", async () => {
    const { window, document } = loadPage();
    await wait();

    // Swap in a refusing store after boot: the duplicate check passes, the
    // add fails.
    window.fetch = async (fetchUrl, options = {}) => {
      if (options.method === "POST") {
        return { ok: false, json: async () => ({ error: "Window closed" }) };
      }
      return { ok: true, json: async () => [] };
    };

    pickCourse(document, "COMS1016A");
    pickSession(document, 0);
    submitForm(window, document);
    await wait();

    expect(document.getElementById("form-error").textContent).toBe(
      "Window closed",
    );
    expect(document.getElementById("submit-btn").disabled).toBe(false);
  });
});
