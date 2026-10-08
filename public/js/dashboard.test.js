// dashboard.js is a real ES module (imports from ./nav.js, ./storage.js and
// ./highlightTarget.js), so — same approach as the studentview.js test — we
// inline it as a classic script with those imports stubbed out, sharing scope
// with the test hooks below. window.fetch has to be stubbed inside
// beforeParse: the page's init IIFE runs during parsing, so anything set
// after `new JSDOM(...)` returns is too late for it.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pathToFileURL } = require("url");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "dashboard.html"),
  "utf8",
);

// The import lines are blanked out in place (same byte length) rather than
// removed, so the inline script shares every line and byte offset with the
// real file and the V8 coverage jest collects for it (matched back to the
// file via the sourceURL comment) lines up exactly instead of smearing
// across the file.
function blankImports(src, moduleNames) {
  const re = new RegExp(
    `^import[\\s\\S]*?from "\\.\\/(?:${moduleNames})\\.js";`,
    "gm",
  );
  return src.replace(re, (match) => match.replace(/[^\n]/g, " "));
}

const dashboardSrc = blankImports(
  fs.readFileSync(path.join(__dirname, "dashboard.js"), "utf8"),
  "nav|storage|highlightTarget",
);

// Stubs for the blanked imports. They sit *after* the page source in the
// inline script (see loadPage) so the source keeps the file's line numbering;
// function declarations hoist across the whole script, so the page's
// top-level requireRole() call still finds them. Their config
// (window.__user etc.) is injected in beforeParse, before any of it runs.
const stubs = `
function requireRole() {
  return window.__user;
}
function highlightActiveTab() {}
function todayStr() {
  return window.__today;
}
function toDateStr(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() + "-" + p(date.getMonth() + 1) + "-" + p(date.getDate())
  );
}
function getWeekStart(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diffToMonday);
  return toDateStr(date);
}
function getMonthStart(dateStr) {
  return dateStr.slice(0, 7) + "-01";
}
async function getWeekTotal() {
  return window.__weekTotal;
}
async function getEntries() {
  return window.__entries;
}
function consumeQueryParam(name) {
  return name in window.__params ? window.__params[name] : null;
}
function scrollAndHighlight(el) {
  window.__highlighted.push(el);
}
`;

// A fixed clock so "today"/"tomorrow" sessions and the daysUntil boundaries
// are deterministic. The fixtures build their HH:MM strings from the same
// instant, so the suite is timezone-agnostic (same trick as my-sessions).
const FIXED_NOW = "2026-09-29T12:00:00Z";
const fixedNowMs = Date.parse(FIXED_NOW);
const fixedNowHm = new Date(fixedNowMs).toTimeString().slice(0, 5);
const oneMinuteEarlierHm = new Date(fixedNowMs - 60000)
  .toTimeString()
  .slice(0, 5);
const oneMinuteLaterHm = new Date(fixedNowMs + 60000)
  .toTimeString()
  .slice(0, 5);

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function ymd(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dateInDays(days) {
  const d = new Date(fixedNowMs);
  d.setDate(d.getDate() + days);
  return ymd(d.getTime());
}
const TODAY = dateInDays(0);
const TODAY_NAME = DAY_NAMES[new Date(fixedNowMs).getDay()];
const TOMORROW = dateInDays(1);
const TOMORROW_NAME = DAY_NAMES[(new Date(fixedNowMs).getDay() + 1) % 7];

// Course scheduled for a tutorial tomorrow morning and a lab later today
// (ending one minute after the pinned "now", so it still counts as today).
function courseFixture(overrides = {}) {
  return {
    id: 1,
    course_code: "COMS1010",
    course_name: "Applied Data Science",
    Day_of_tut: TOMORROW_NAME,
    tutor_start_time: "08:00:00",
    tutor_end_time: "09:00:00",
    venues: "FNB1",
    Day_of_lab: TODAY_NAME,
    lab_start_time: "10:00:00",
    lab_end_time: `${oneMinuteLaterHm}:00`,
    lab_venues: "MSL001",
    ...overrides,
  };
}

function loadPage({
  user = { id: "tutor-1", name: "Thabo", role: "tutor" },
  applications = [],
  excusals = [],
  weeklyCap = null,
  weekTotal = 0,
  entries = [],
  timesheets = [],
  applicationsFail = false,
  excusalsFail = false,
  excusalDeleteFail = false,
  excusePostFail = false,
  timesheetsFail = false,
  params = {},
  // The calendar logic (daysUntil, "today's" sessions) needs the page clock
  // pinned to the same instant the fixtures were built from.
  now = FIXED_NOW,
} = {}) {
  const script = `<script>${dashboardSrc}
${stubs}
//# sourceURL=${pathToFileURL(path.join(__dirname, "dashboard.js")).href}</script>`;
  const pageHtml = html
    .replace('<script type="module" src="../js/dashboard.js"></script>', script)
    .replace('<script src="../js/user-badge.js"></script>', "")
    .replace('<script src="../js/onboarding.js"></script>', "")
    .replace('<script src="../js/notifications.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "");

  const calls = [];
  const jsdomErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => jsdomErrors.push(e));

  const dom = new JSDOM(pageHtml, {
    url: "http://localhost/dashboard.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // Test hooks and stub config, ready before the page script runs.
      window.__user = user;
      window.__today = TODAY;
      window.__weekTotal = weekTotal;
      window.__entries = entries;
      window.__params = params;
      window.__tours = [];
      window.__highlighted = [];
      window.Onboarding = {
        start: (steps, opts) => window.__tours.push(opts),
      };
      if (now !== null) {
        const RealDate = window.Date;
        const fixedMs = new RealDate(now).getTime();
        class FixedDate extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(fixedMs);
            else super(...args);
          }
          static now() {
            return fixedMs;
          }
        }
        window.Date = FixedDate;
      }
      if (!window.CSS) window.CSS = {};
      if (!window.CSS.escape) {
        window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }
      // jsdom ships HTMLDialogElement but not its modal API — stub just
      // enough for the excuse dialog to open and close.
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function () {
          this.open = true;
        };
        window.HTMLDialogElement.prototype.close = function () {
          this.open = false;
        };
      }

      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = opts.method || "GET";
        calls.push({
          url: u,
          method,
          body: opts.body ? JSON.parse(opts.body) : null,
        });
        if (u.includes("/api/tutor-applications")) {
          if (applicationsFail) {
            return { ok: false, json: async () => ({ error: "boom" }) };
          }
          return { ok: true, json: async () => applications };
        }
        if (u.includes("/api/session-excusals") && method === "DELETE") {
          if (excusalDeleteFail) {
            return {
              ok: false,
              json: async () => ({ error: "Too late to cancel" }),
            };
          }
          return { ok: true, status: 204, json: async () => ({}) };
        }
        if (u.includes("/api/session-excusals") && method === "POST") {
          if (excusePostFail) {
            return {
              ok: false,
              json: async () => ({ error: "No cover available" }),
            };
          }
          return { ok: true, json: async () => ({}) };
        }
        if (u.startsWith("/api/session-excusals")) {
          if (excusalsFail) {
            return { ok: false, json: async () => ({ error: "boom" }) };
          }
          return { ok: true, json: async () => excusals };
        }
        if (u.startsWith("/api/tutors/")) {
          return {
            ok: true,
            json: async () => ({ weekly_hour_cap: weeklyCap }),
          };
        }
        if (u.includes("/api/timesheets/due-reminder")) {
          return { ok: true, json: async () => ({}) };
        }
        if (u.includes("/api/timesheets")) {
          if (timesheetsFail) {
            return { ok: false, json: async () => ({ error: "boom" }) };
          }
          return { ok: true, json: async () => timesheets };
        }
        return { ok: true, json: async () => ({}) };
      };
    },
  });

  return { window: dom.window, calls, jsdomErrors };
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const findCall = (calls, urlPart, method = "GET") =>
  calls.find((c) => c.method === method && c.url.includes(urlPart));
const countCalls = (calls, urlPart, method = "GET") =>
  calls.filter((c) => c.method === method && c.url.includes(urlPart)).length;

describe("dashboard.js", () => {
  test("bounces an unauthorised visitor before fetching anything", async () => {
    const { calls, jsdomErrors } = loadPage({ user: null });
    await wait();

    expect(calls).toHaveLength(0);
    const messages = jsdomErrors
      .map((e) => `${e.message} ${e.detail && e.detail.message}`)
      .join("\n");
    expect(messages).toContain("Not authorized");
  });

  test("counts only approved course assignments", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "Approved", // case-insensitive on purpose
          courses: courseFixture(),
        },
        { id: "a2", course_id: 2, status: "pending", courses: courseFixture() },
        {
          id: "a3",
          course_id: 3,
          status: "rejected",
          courses: courseFixture(),
        },
      ],
    });
    await wait();

    const doc = window.document;
    expect(doc.getElementById("stat-courses-assigned").textContent).toBe("1");
    expect(doc.querySelectorAll("#dashCoursesList .dash-course")).toHaveLength(
      1,
    );
    expect(doc.getElementById("dashCoursesEmpty").hidden).toBe(true);
  });

  test("renders my courses with their weekly schedule", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture(),
        },
        {
          id: "a2",
          course_id: 2,
          status: "approved",
          courses: courseFixture({
            id: 2,
            course_code: "MATH2000",
            course_name: "Algebra",
            Day_of_tut: null,
            Day_of_lab: null,
          }),
        },
      ],
    });
    await wait();

    const rows = window.document.querySelectorAll(
      "#dashCoursesList .dash-course",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.courseId).toBe("1");
    expect(rows[0].querySelector(".dash-course__code").textContent).toBe(
      "COMS1010",
    );
    expect(rows[0].querySelector(".dash-course__times").textContent).toBe(
      `Tutorial · ${TOMORROW_NAME.slice(0, 3)} 08:00–09:00 · Lab · ${TODAY_NAME.slice(0, 3)} 10:00–${oneMinuteLaterHm}`,
    );
    expect(rows[1].querySelector(".dash-course__times").textContent).toBe(
      "Schedule to be announced",
    );
  });

  test("shows hours this week against the weekly cap", async () => {
    const { window } = loadPage({ weeklyCap: 10, weekTotal: 4.5 });
    await wait();

    const doc = window.document;
    expect(doc.getElementById("stat-hours-worked").textContent).toBe("4.5/10h");
    expect(doc.getElementById("stat-hours-sublabel").textContent).toBe(
      "5.5h remaining",
    );
    expect(
      doc
        .getElementById("stat-hours-sublabel")
        .classList.contains("stat-sublabel--danger"),
    ).toBe(false);
    expect(doc.getElementById("capacity-value").textContent).toBe("4.5h used");
    expect(doc.getElementById("capacity-max").textContent).toBe("of 10h max");
    expect(doc.getElementById("capacity-bar-fill").style.width).toBe("45%");
    expect(doc.getElementById("capacity-caption").textContent).toBe(
      "5.5h remaining this week",
    );
  });

  test("warns and flags the bar when the week goes over the cap", async () => {
    const { window } = loadPage({ weeklyCap: 10, weekTotal: 12 });
    await wait();

    const doc = window.document;
    const sublabel = doc.getElementById("stat-hours-sublabel");
    expect(sublabel.textContent).toBe("2h over your weekly cap");
    expect(sublabel.classList.contains("stat-sublabel--danger")).toBe(true);
    expect(doc.getElementById("capacity-bar-fill").style.width).toBe("100%");
    expect(
      doc
        .getElementById("capacity-bar-fill")
        .classList.contains("capacity-bar__fill--over"),
    ).toBe(true);
    expect(doc.getElementById("capacity-caption").textContent).toBe(
      "You're over your weekly cap.",
    );
  });

  test("marks the weekly cap as reached at exactly the limit", async () => {
    const { window } = loadPage({ weeklyCap: 10, weekTotal: 10 });
    await wait();

    const doc = window.document;
    expect(doc.getElementById("stat-hours-sublabel").textContent).toBe(
      "Weekly cap reached",
    );
    expect(doc.getElementById("capacity-caption").textContent).toBe(
      "Full weekly cap used.",
    );
    expect(
      doc
        .getElementById("capacity-bar-fill")
        .classList.contains("capacity-bar__fill--over"),
    ).toBe(false);
  });

  test("falls back to the cap carried on the applications join", async () => {
    const { window } = loadPage({
      weeklyCap: null,
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "pending",
          tutors: { weekly_hour_cap: 8 },
          courses: courseFixture(),
        },
      ],
    });
    await wait();

    expect(
      window.document.getElementById("stat-hours-worked").textContent,
    ).toBe("0/8h");
  });

  test("explains when no weekly cap is set", async () => {
    const { window } = loadPage({ weeklyCap: null });
    await wait();

    const doc = window.document;
    expect(doc.getElementById("stat-hours-worked").textContent).toBe("0");
    const sublabel = doc.getElementById("stat-hours-sublabel");
    expect(sublabel.textContent).toBe("No weekly cap set");
    expect(sublabel.classList.contains("stat-sublabel--danger")).toBe(false);
    expect(doc.getElementById("capacity-value").textContent).toBe("0h used");
    expect(doc.getElementById("capacity-max").textContent).toBe("");
    expect(doc.getElementById("capacity-caption").textContent).toBe(
      "No weekly cap set — ask your organiser.",
    );
  });

  test("counts past months with unsubmitted timesheets", async () => {
    const { window } = loadPage({
      entries: [{ date: "2026-08-15" }, { date: "2026-09-10" }],
      timesheets: [],
    });
    await wait();

    const doc = window.document;
    expect(doc.getElementById("stat-timesheets-due").textContent).toBe("1");
    expect(doc.getElementById("stat-timesheets-sublabel").textContent).toBe(
      "Awaiting submission",
    );
  });

  test("counts a month as caught up once any timesheet covers it", async () => {
    const { window } = loadPage({
      entries: [{ date: "2026-08-15" }],
      timesheets: [{ week_start: "2026-08-03" }],
    });
    await wait();

    const doc = window.document;
    expect(doc.getElementById("stat-timesheets-due").textContent).toBe("0");
    expect(doc.getElementById("stat-timesheets-sublabel").textContent).toBe(
      "All caught up",
    );
  });

  test("apologises when timesheets can't load", async () => {
    const { window } = loadPage({ timesheetsFail: true });
    await wait();

    const doc = window.document;
    expect(doc.getElementById("stat-timesheets-due").textContent).toBe("—");
    expect(doc.getElementById("stat-timesheets-sublabel").textContent).toBe(
      "Couldn't load timesheets",
    );
  });

  test("builds upcoming sessions from approved weekly slots, soonest first", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture(),
        },
        // A pending allocation isn't a commitment yet.
        {
          id: "a2",
          course_id: 2,
          status: "pending",
          courses: courseFixture({
            id: 2,
            course_code: "PENDING2000",
            Day_of_lab: "Wednesday",
          }),
        },
      ],
    });
    await wait();

    const doc = window.document;
    const cards = doc.querySelectorAll(
      "#upcoming-sessions-items .session-card",
    );
    expect(cards).toHaveLength(2);

    // The lab later today sorts before tomorrow's tutorial.
    expect(cards[0].querySelector(".session-code").textContent).toBe(
      "COMS1010",
    );
    expect(cards[0].querySelector(".session-note").textContent).toBe(
      "Lab session",
    );
    expect(
      cards[0].querySelector(".session-meta__venue-text").textContent,
    ).toBe("MSL001");
    expect(cards[0].querySelector(".session-meta__date").textContent).toContain(
      "29",
    );

    expect(cards[1].querySelector(".session-note").textContent).toBe(
      "Tutorial session",
    );
    expect(
      cards[1].querySelector(".session-meta__venue-text").textContent,
    ).toBe("FNB1");
    expect(doc.getElementById("upcoming-sessions-empty").hidden).toBe(true);
  });

  test("keeps a session whose time already passed today in next week's slot", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture({
            Day_of_tut: null,
            Day_of_lab: TODAY_NAME,
            lab_end_time: `${fixedNowHm}:00`, // ended exactly now
          }),
        },
      ],
    });
    await wait();

    const cards = window.document.querySelectorAll(
      "#upcoming-sessions-items .session-card",
    );
    // Not dropped — rolled forward to the same weekday next week.
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".session-note").textContent).toBe(
      "Lab session",
    );
  });

  test("marks an excused session and drops its Excuse me button", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture(),
        },
        {
          id: "a2",
          course_id: 2,
          status: "approved",
          courses: courseFixture({
            id: 2,
            course_code: "STAT2000",
            Day_of_lab: "Wednesday",
            lab_start_time: null,
            lab_end_time: null,
            lab_venues: null,
          }),
        },
      ],
      excusals: [
        {
          id: "x1",
          course_id: 1,
          session_date: TODAY,
          session_type: "lab",
          cover: { name: "Ada" },
        },
        {
          id: "x2",
          course_id: 1,
          session_date: TOMORROW,
          session_type: "tutorial",
        },
      ],
    });
    await wait();

    const doc = window.document;
    const cards = [
      ...doc.querySelectorAll("#upcoming-sessions-items .session-card"),
    ];
    const labCard = cards.find(
      (c) =>
        c.querySelector(".session-meta__venue-text")?.textContent === "MSL001",
    );
    const tutCard = cards.find((c) => c !== labCard);
    const statCard = cards.find(
      (c) => c.querySelector(".session-code").textContent === "STAT2000",
    );

    expect(labCard.querySelector(".excused-note").textContent).toBe(
      "You're excused · Ada is covering",
    );
    expect(labCard.querySelector(".status-pill").textContent).toBe("Excused");
    expect(labCard.querySelector("button")).toBeNull();

    expect(tutCard.querySelector(".excused-note").textContent).toBe(
      "You're excused · finding a volunteer to cover",
    );
    expect(tutCard.querySelector("button")).toBeNull();

    expect(statCard.querySelector(".excused-note")).toBeNull();
    expect(statCard.querySelector("button.btn-secondary").textContent).toBe(
      "Excuse me",
    );
  });

  test("lists upcoming excusals with their cover status, past ones excluded", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture(),
        },
      ],
      excusals: [
        {
          id: "x1",
          course_id: 1,
          session_date: TOMORROW,
          session_type: "tutorial",
          reason: "Family emergency",
          courses: courseFixture(),
        },
        {
          id: "x2",
          course_id: 1,
          session_date: TODAY,
          session_type: "lab",
          cover: { name: "Grace" },
          courses: courseFixture(),
        },
        {
          id: "x3",
          course_id: 1,
          session_date: "2020-01-01",
          session_type: "lab",
          courses: courseFixture(),
        },
      ],
    });
    await wait();

    const doc = window.document;
    expect(doc.getElementById("excusals-list").hidden).toBe(false);
    const items = doc.querySelectorAll("#excusals-items .application-row");
    expect(items).toHaveLength(2);

    // Sorted soonest first: today's covered lab, then tomorrow's tutorial.
    expect(items[0].dataset.excusalId).toBe("x2");
    expect(items[0].querySelector("strong").textContent).toBe("COMS1010 · Lab");
    expect(items[0].querySelector(".excusal-cover").textContent).toBe(
      "Covered by Grace",
    );

    expect(items[1].dataset.excusalId).toBe("x1");
    expect(items[1].textContent).toContain("(Family emergency)");
    expect(items[1].querySelector(".excusal-cover").textContent).toBe(
      "Finding a volunteer to cover…",
    );
  });

  test("hides the excusals list when nothing is upcoming", async () => {
    const { window } = loadPage({
      excusals: [
        {
          id: "x3",
          course_id: 1,
          session_date: "2020-01-01",
          session_type: "lab",
        },
      ],
    });
    await wait();

    expect(window.document.getElementById("excusals-list").hidden).toBe(true);
  });

  test("cancels an excusal from the list and refreshes", async () => {
    const { window, calls } = loadPage({
      excusals: [
        {
          id: "x1",
          course_id: 1,
          session_date: TOMORROW,
          session_type: "tutorial",
          courses: courseFixture(),
        },
      ],
    });
    await wait();

    window.document
      .querySelector('#excusals-items [data-action="cancel-excusal"]')
      .click();
    await wait();

    const cancelled = findCall(calls, "/api/session-excusals/x1", "DELETE");
    expect(cancelled).toBeTruthy();
    expect(window.document.getElementById("toast").textContent).toBe(
      "Excusal cancelled.",
    );
    expect(countCalls(calls, "/api/session-excusals?", "GET")).toBe(2);
  });

  test("surfaces the server's error when a cancellation fails", async () => {
    const { window, calls } = loadPage({
      excusalDeleteFail: true,
      excusals: [
        {
          id: "x1",
          course_id: 1,
          session_date: TOMORROW,
          session_type: "tutorial",
          courses: courseFixture(),
        },
      ],
    });
    await wait();

    window.document
      .querySelector('#excusals-items [data-action="cancel-excusal"]')
      .click();
    await wait();

    expect(window.document.getElementById("toast").textContent).toBe(
      "Too late to cancel",
    );
    expect(countCalls(calls, "/api/session-excusals?", "GET")).toBe(1);
  });

  test("opens the excuse modal from a session card, prefilled", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture(),
        },
      ],
    });
    await wait();

    const doc = window.document;
    // The lab runs today; its card is the first one rendered.
    doc.querySelector("#upcoming-sessions-items .session-card button").click();

    const modal = doc.getElementById("excuse-modal");
    expect(modal.open).toBe(true);
    expect(doc.getElementById("excuse-course-select").value).toBe("1");
    expect(
      [...doc.getElementById("excuse-course-select").options].some(
        (o) =>
          o.value === "1" &&
          o.textContent === "COMS1010 — Applied Data Science",
      ),
    ).toBe(true);
    expect(doc.getElementById("excuse-session-select").value).toBe("lab");
    expect(doc.getElementById("excuse-date-input").value).toBe(TODAY);
    // Placeholder + the next 10 weekly occurrences.
    expect(doc.getElementById("excuse-date-input").options).toHaveLength(11);
    expect(
      [...doc.getElementById("excuse-session-select").options].some(
        (o) => o.value === "tutorial" && o.textContent.includes("08:00–09:00"),
      ),
    ).toBe(true);
  });

  test("submits the excuse and refreshes the excusals", async () => {
    const { window, calls } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture(),
        },
      ],
    });
    await wait();

    const doc = window.document;
    doc.querySelector("#upcoming-sessions-items .session-card button").click();
    doc.getElementById("excuse-reason-input").value = "Clashing test";
    doc
      .getElementById("excuse-form")
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await wait();

    const posted = findCall(calls, "/api/session-excusals", "POST");
    expect(posted.body).toEqual({
      tutorId: "tutor-1",
      courseId: 1,
      sessionType: "lab",
      sessionDate: TODAY,
      reason: "Clashing test",
    });
    expect(doc.getElementById("excuse-modal").open).toBe(false);
    expect(doc.getElementById("toast").textContent).toBe(
      "You're excused from that session.",
    );
    expect(countCalls(calls, "/api/session-excusals?", "GET")).toBe(2);
  });

  test("surfaces the server error when the excuse can't be submitted", async () => {
    const { window, calls } = loadPage({
      excusePostFail: true,
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture(),
        },
      ],
    });
    await wait();

    const doc = window.document;
    doc.querySelector("#upcoming-sessions-items .session-card button").click();
    doc
      .getElementById("excuse-form")
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await wait();

    const error = doc.getElementById("excuse-form-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("No cover available");
    expect(doc.getElementById("excuse-modal").open).toBe(true);
    const submitBtn = doc.getElementById("excuse-submit-btn");
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.textContent).toBe("Excuse me from this session");
    expect(countCalls(calls, "/api/session-excusals?", "GET")).toBe(1);
  });

  test("shows the empty state when no sessions exist or the fetch fails", async () => {
    const empty = loadPage({ applications: [] });
    await wait();
    expect(
      empty.window.document.getElementById("upcoming-sessions-list").hidden,
    ).toBe(true);
    expect(
      empty.window.document.getElementById("upcoming-sessions-empty").hidden,
    ).toBe(false);

    const failed = loadPage({ applicationsFail: true });
    await wait();
    expect(
      failed.window.document.getElementById("upcoming-sessions-list").hidden,
    ).toBe(true);
    expect(
      failed.window.document.getElementById("upcoming-sessions-empty").hidden,
    ).toBe(false);
  });

  test("highlights the course named by a session-changed notification", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          status: "approved",
          courses: courseFixture(),
        },
      ],
      params: { highlightCourse: "1" },
    });
    await wait();

    expect(window.__highlighted).toHaveLength(1);
    expect(window.__highlighted[0].getAttribute("data-course-id")).toBe("1");
  });

  test("highlights the excusal named by a cover notification", async () => {
    const { window } = loadPage({
      excusals: [
        {
          id: "x1",
          course_id: 1,
          session_date: TOMORROW,
          session_type: "tutorial",
          courses: courseFixture(),
        },
      ],
      params: { highlightExcusal: "x1" },
    });
    await wait();

    expect(window.__highlighted).toHaveLength(1);
    expect(window.__highlighted[0].getAttribute("data-excusal-id")).toBe("x1");
  });

  test("asks the server to evaluate a due-reminder on load", async () => {
    const { calls } = loadPage({});
    await wait();

    expect(
      calls.some((c) =>
        c.url.includes("/api/timesheets/due-reminder?tutorId=tutor-1"),
      ),
    ).toBe(true);
  });

  test("starts the tour softly on load and forced from the navbar button", async () => {
    const { window } = loadPage({});
    await wait();

    expect(window.__tours).toHaveLength(1);
    expect(window.__tours[0]).toEqual({
      tourId: "tutor-dashboard",
      userId: "tutor-1",
      force: false,
    });

    window.document.getElementById("tour-link").click();
    expect(window.__tours).toHaveLength(2);
    expect(window.__tours[1].force).toBe(true);
  });

  test("forces the tour when arriving via ?tour=1", async () => {
    const { window } = loadPage({ params: { tour: "1" } });
    await wait();

    expect(window.__tours).toHaveLength(1);
    expect(window.__tours[0].force).toBe(true);
  });
});
