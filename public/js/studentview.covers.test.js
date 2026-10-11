// studentview.js flows that studentview.dashboard.test.js doesn't reach:
// the mark-submission round trip, failed claims, the cover/swap cards built
// from session excusals, the page's error states, and the guided-tour link.
// Same harness as that suite — real StudentView.html, imports stubbed, the
// source inlined with a sourceURL — extended with /api/session-excusals
// routing, a confirm stub and an Onboarding stub.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

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

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// An excusal the student is covering: tomorrow, so it survives the
// past-date filter without any clock pinning.
function coverExcusal(overrides = {}) {
  return {
    id: "e1",
    course_id: 1,
    session_date: isoDaysFromNow(1),
    session_type: "tutorial",
    course_id: 1,
    courses: {
      course_code: "COMS1000",
      course_name: "Intro",
      Day_of_tut: "Monday",
      tutor_start_time: "10:00:00",
      tutor_end_time: "12:00:00",
      venues: "MSL004",
    },
    tutors: { name: "Tessa T" },
    cover: { name: "Test Student" },
    ...overrides,
  };
}

function loadPage({
  courses = [],
  applications = [],
  openSessions = [],
  covers = [],
  swapRequests = [],
  swapCandidates = [],
  excusalPostResponse = { ok: true, json: async () => ({}) },
  volunteerPostResponse = null,
  claimResponse = null,
  confirmResult = false,
  withTour = false,
} = {}) {
  const script = `<script>${stubs}\n${studentviewSrc}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "studentview.js")).href}</script>`;
  const pageHtml = html
    .replace(
      '<script type="module" src="../js/studentview.js"></script>',
      script,
    )
    .replace('<script src="../js/onboarding.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "");

  const calls = [];
  const onboardingStart = jest.fn();

  const dom = new JSDOM(pageHtml, {
    url: "http://localhost/StudentView.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = {};
      if (!window.CSS.escape) {
        window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }
      window.confirm = () => confirmResult;
      if (withTour) window.Onboarding = { start: onboardingStart };

      window.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts });
        const u = String(url);
        if (u.includes("/api/session-excusals")) {
          if (u.includes("/swap-candidates")) {
            return { ok: true, json: async () => swapCandidates };
          }
          if (opts?.method === "POST") {
            return typeof excusalPostResponse === "function"
              ? excusalPostResponse(u)
              : excusalPostResponse;
          }
          if (u.includes("swapToUserId=")) {
            return { ok: true, json: async () => swapRequests };
          }
          if (u.includes("coverUserId=")) {
            return { ok: true, json: async () => covers };
          }
          return { ok: true, json: async () => [] };
        }
        if (u.includes("/claim") && claimResponse === "throw") {
          throw new Error("network down");
        }
        if (
          u.includes("/claim") &&
          claimResponse &&
          claimResponse !== "throw"
        ) {
          return claimResponse;
        }
        if (u.includes("/api/courses")) {
          return typeof courses === "function"
            ? courses(u)
            : { ok: true, json: async () => courses };
        }
        if (u === "/api/course-volunteers" && opts?.method === "POST") {
          return volunteerPostResponse || { ok: true, json: async () => ({}) };
        }
        if (u.includes("/api/course-volunteers?status=open")) {
          return { ok: true, json: async () => openSessions };
        }
        if (u.includes("/api/course-volunteers")) {
          return typeof applications === "function"
            ? applications(u)
            : { ok: true, json: async () => applications };
        }
        return { ok: true, json: async () => [] };
      };
    },
  });

  return { window: dom.window, calls, onboardingStart };
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const openCourse = {
  id: 1,
  course_code: "COMS1000",
  course_name: "Intro",
  department: "Computer Science",
  tutors_needed: 2,
  no_of_tutors_assigned: 0,
};

function openMarkForm(window) {
  const card = window.document.querySelector("#courseList article");
  card.querySelector(".volunteer-btn").click();
  return card;
}

describe("studentview.js — mark submission", () => {
  test("a valid mark POSTs to course-volunteers and toasts the applied message", async () => {
    const { window, calls } = loadPage({ courses: [openCourse] });
    await wait();

    const card = openMarkForm(window);
    card.querySelector(".mark-input").value = "75";
    card.querySelector(".submit-mark-btn").click();
    await wait();

    const post = calls.find(
      (c) => c.url === "/api/course-volunteers" && c.opts?.method === "POST",
    );
    expect(post).toBeDefined();
    expect(JSON.parse(post.opts.body)).toEqual({
      userId: "student-1",
      courseId: 1,
      mark: 75,
    });
    expect(window.document.getElementById("toast").textContent).toBe(
      "Applied for COMS1000 — waiting for organiser approval",
    );
  });

  test("an API rejection toasts the server's error and re-enables the button", async () => {
    const { window } = loadPage({
      courses: [openCourse],
      volunteerPostResponse: {
        ok: false,
        json: async () => ({
          error: "You've already volunteered for this course",
        }),
      },
    });
    await wait();

    const card = openMarkForm(window);
    const submitBtn = card.querySelector(".submit-mark-btn");
    card.querySelector(".mark-input").value = "75";
    submitBtn.click();
    await wait();

    expect(window.document.getElementById("toast").textContent).toBe(
      "You've already volunteered for this course",
    );
    expect(submitBtn.disabled).toBe(false);
  });

  test("an out-of-range mark never reaches the server", async () => {
    const { window, calls } = loadPage({ courses: [openCourse] });
    await wait();

    const card = openMarkForm(window);
    card.querySelector(".mark-input").value = "150";
    card.querySelector(".submit-mark-btn").click();
    await wait();

    expect(window.document.getElementById("toast").textContent).toBe(
      "Enter a valid mark between 0 and 100",
    );
    expect(calls.some((c) => c.opts?.method === "POST")).toBe(false);
  });

  test("pressing Enter in the mark input submits it", async () => {
    const { window, calls } = loadPage({ courses: [openCourse] });
    await wait();

    const card = openMarkForm(window);
    const input = card.querySelector(".mark-input");
    input.value = "80";
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await wait();

    expect(
      calls.some(
        (c) => c.url === "/api/course-volunteers" && c.opts?.method === "POST",
      ),
    ).toBe(true);
  });

  test("cancel hides the mark form and brings the Volunteer button back", async () => {
    const { window } = loadPage({ courses: [openCourse] });
    await wait();

    const card = openMarkForm(window);
    card.querySelector(".cancel-mark-btn").click();

    expect(card.querySelector(".mark-form").hidden).toBe(true);
    expect(card.querySelector(".volunteer-btn").hidden).toBe(false);
  });
});

describe("studentview.js — failed claims", () => {
  const claimable = [
    {
      id: "s1",
      course_id: 1,
      session_date: "2026-09-25",
      start_time: "14:00:00",
      end_time: "16:00:00",
      courses: { course_code: "COMS1000", course_name: "Intro" },
    },
  ];

  test("a rejected claim toasts the error and reloads the open list", async () => {
    const { window, calls } = loadPage({
      openSessions: claimable,
      claimResponse: {
        ok: false,
        json: async () => ({ error: "Someone just claimed it" }),
      },
    });
    await wait();

    window.document.querySelector("#openSessionsList article button").click();
    await wait();

    expect(window.document.getElementById("toast").textContent).toBe(
      "Someone just claimed it",
    );
    // The list was re-fetched so it matches reality.
    expect(
      calls.filter((c) => c.url.includes("status=open")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("a network failure while claiming toasts the connection message", async () => {
    const { window } = loadPage({
      openSessions: claimable,
      claimResponse: "throw",
    });
    await wait();

    window.document.querySelector("#openSessionsList article button").click();
    await wait();

    expect(window.document.getElementById("toast").textContent).toBe(
      "Network error — couldn't reach the server.",
    );
  });
});

describe("studentview.js — covers and swaps", () => {
  test("a cover card shows who is being covered for, the slot label and a tomorrow pill", async () => {
    const { window } = loadPage({ covers: [coverExcusal()] });
    await wait();

    const card = window.document.querySelector(
      "#upcomingSessionsList article[data-cover-id='e1']",
    );
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Covering for Tessa T");
    expect(card.textContent).toContain("Tutorial");
    expect(card.textContent).toContain("10:00–12:00");
    expect(card.textContent).toContain("MSL004");
    expect(card.querySelector(".status-pill").textContent).toBe("tomorrow");
  });

  test('"Can\'t make it" opens the picker and loads the other volunteers', async () => {
    const { window, calls } = loadPage({
      covers: [coverExcusal()],
      swapCandidates: [{ name: "Nora N", user_id: "u2" }],
    });
    await wait();

    const card = window.document.querySelector("article[data-cover-id='e1']");
    card.querySelector(".btn-cancel").click();
    await wait();

    const select = card.querySelector(".swap-select");
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["", "u2", "__auto__"]);
    expect(select.disabled).toBe(false);
    expect(calls.some((c) => c.url.includes("/swap-candidates"))).toBe(true);
  });

  test("sending a swap request POSTs it with the chosen volunteer", async () => {
    const { window, calls } = loadPage({
      covers: [coverExcusal()],
      swapCandidates: [{ name: "Nora N", user_id: "u2" }],
    });
    await wait();

    const card = window.document.querySelector("article[data-cover-id='e1']");
    card.querySelector(".btn-cancel").click();
    await wait();

    const select = card.querySelector(".swap-select");
    select.value = "u2";
    [...card.querySelectorAll("button")]
      .find((b) => b.textContent === "Send request")
      .click();
    await wait();

    const post = calls.find((c) => c.url.includes("/swap-request"));
    expect(post).toBeDefined();
    expect(post.opts.method).toBe("POST");
    expect(JSON.parse(post.opts.body)).toEqual({
      userId: "student-1",
      toUserId: "u2",
    });
    expect(window.document.getElementById("toast").textContent).toBe(
      "Request sent to Nora N — you're still covering it until they accept.",
    );
  });

  test('choosing "Anyone free" declines the cover instead so the system reassigns', async () => {
    const { window, calls } = loadPage({
      covers: [coverExcusal()],
      swapCandidates: [],
    });
    await wait();

    const card = window.document.querySelector("article[data-cover-id='e1']");
    card.querySelector(".btn-cancel").click();
    await wait();

    const select = card.querySelector(".swap-select");
    select.value = "__auto__";
    [...card.querySelectorAll("button")]
      .find((b) => b.textContent === "Send request")
      .click();
    await wait();

    expect(calls.some((c) => c.url.includes("/decline-cover"))).toBe(true);
    expect(window.document.getElementById("toast").textContent).toBe(
      "It's been handed to another available volunteer.",
    );
  });

  test("a pending swap shows the waiting note and its withdraw button unrequests", async () => {
    const { window, calls } = loadPage({
      covers: [
        coverExcusal({
          id: "e3",
          swap_to_user_id: "u9",
          swap_to: { name: "Ben B" },
        }),
      ],
    });
    await wait();

    const card = window.document.querySelector("article[data-cover-id='e3']");
    expect(card.textContent).toContain(
      "Waiting for Ben B to accept your swap request",
    );

    [...card.querySelectorAll("button")]
      .find((b) => b.textContent === "Withdraw request")
      .click();
    await wait();

    expect(calls.some((c) => c.url.includes("/swap-withdraw"))).toBe(true);
    expect(window.document.getElementById("toast").textContent).toBe(
      "Swap request withdrawn — you're still covering it.",
    );
  });

  test("a received swap request offers Accept/Decline and accepting POSTs swap-respond", async () => {
    const { window, calls } = loadPage({
      swapRequests: [
        coverExcusal({
          id: "e2",
          session_type: "lab",
          courses: {
            course_code: "COMS1000",
            course_name: "Intro",
            Day_of_lab: "Wednesday",
            lab_start_time: "14:00:00",
            lab_end_time: "16:00:00",
            lab_venues: "MSL010",
          },
          tutors: { name: "Tessa T" },
          cover: { name: "Nora N" },
          swap_to_user_id: "student-1",
          swap_to: { name: "Test Student" },
        }),
      ],
    });
    await wait();

    const card = window.document.querySelector("article[data-swap-id='e2']");
    expect(card).not.toBeNull();
    expect(card.textContent).toContain(
      "Nora N asked you to take this over (covering for Tessa T)",
    );

    [...card.querySelectorAll("button")]
      .find((b) => b.textContent === "Accept")
      .click();
    await wait();

    const post = calls.find((c) => c.url.includes("/swap-respond"));
    expect(post).toBeDefined();
    expect(JSON.parse(post.opts.body)).toEqual({
      userId: "student-1",
      accept: true,
    });
    expect(window.document.getElementById("toast").textContent).toContain(
      "You're now covering COMS1000",
    );
  });

  test("a past-dated cover never renders", async () => {
    const { window } = loadPage({
      covers: [coverExcusal({ session_date: isoDaysFromNow(-2) })],
    });
    await wait();

    expect(
      window.document.getElementById("upcomingSessionsList").textContent,
    ).toContain("No upcoming sessions");
  });
});

describe("studentview.js — error states", () => {
  test("a failed courses fetch shows the course list error copy", async () => {
    const { window } = loadPage({
      courses: () => ({
        ok: false,
        json: async () => ({ error: "boom" }),
      }),
    });
    await wait();

    expect(window.document.getElementById("courseList").textContent).toContain(
      "Couldn't load courses right now.",
    );
  });

  test("a failed applications fetch degrades every list that depends on it", async () => {
    const { window } = loadPage({
      applications: () => ({
        ok: false,
        json: async () => ({ error: "boom" }),
      }),
    });
    await wait();

    expect(window.document.getElementById("pendingList").textContent).toContain(
      "Couldn't load your applications right now.",
    );
    expect(
      window.document.getElementById("upcomingSessionsList").textContent,
    ).toContain("Couldn't load your sessions right now.");
  });
});

describe("studentview.js — withdraw and remove toasts", () => {
  test("releasing a claimed session says it went back to the pool", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "s1",
          course_id: 1,
          status: "pending",
          session_date: "2099-01-01",
          start_time: "09:00:00",
          end_time: "11:00:00",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
      ],
    });
    await wait();

    window.document.querySelector("#pendingList article button").click();
    await wait();

    expect(window.document.getElementById("toast").textContent).toBe(
      "Released the COMS1000 session on 01/01/2099 back to the pool",
    );
  });

  test('"Remove & volunteer again" deletes the rejected application only after confirm', async () => {
    const { window, calls } = loadPage({
      courses: [openCourse],
      applications: [
        {
          id: "a1",
          course_id: 1,
          mark: 40,
          status: "rejected",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
      ],
      confirmResult: true,
    });
    await wait();

    const reapplyBtn = window.document.querySelector(
      "#courseList article .btn-link",
    );
    expect(reapplyBtn.textContent).toBe("Remove & volunteer again");
    reapplyBtn.click();
    await wait();

    expect(calls.some((c) => c.opts?.method === "DELETE")).toBe(true);
    expect(window.document.getElementById("toast").textContent).toBe(
      "Application removed.",
    );
  });

  test("declining the confirm leaves the rejected application alone", async () => {
    const { window, calls } = loadPage({
      courses: [openCourse],
      applications: [
        {
          id: "a1",
          course_id: 1,
          mark: 40,
          status: "rejected",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
      ],
      confirmResult: false,
    });
    await wait();

    window.document.querySelector("#courseList article .btn-link").click();
    await wait();

    expect(calls.some((c) => c.opts?.method === "DELETE")).toBe(false);
  });
});

describe("studentview.js — guided tour", () => {
  test("the tour link starts the volunteer-dashboard walkthrough", async () => {
    const { window, onboardingStart } = loadPage({ withTour: true });
    await wait();

    window.document.getElementById("tour-link").click();
    await wait();

    // The init IIFE auto-starts the tour once per user (force: false); the
    // link click is the second, forced run.
    expect(onboardingStart).toHaveBeenCalledTimes(2);
    const [steps, options] = onboardingStart.mock.calls[1];
    expect(options).toEqual({
      tourId: "volunteer-dashboard",
      userId: "student-1",
      force: true,
    });
    expect(onboardingStart.mock.calls[0][1].force).toBe(false);
    expect(steps.length).toBeGreaterThan(3);
    expect(steps[0].selector).toBe(".stat-grid");
  });
});
