// studentview.js is a real ES module (imports from ./storage.js), so — same
// problem as board.js's keyboard-nav test, plus jsdom doesn't reliably run
// <script type="module"> at all even with runScripts: "dangerously" — we
// load it as a classic script with storage.js's two imports (getEntries,
// requireRole) stubbed out, sharing scope with test hooks the same way the
// board.js test does. window.fetch has to be stubbed inside beforeParse,
// not after `new JSDOM(...)` returns — the inline script runs synchronously
// during parsing, so anything set afterward is too late for the page's own
// init IIFE.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "StudentView.html"),
  "utf8",
);
const studentviewSrc = fs
  .readFileSync(path.join(__dirname, "studentview.js"), "utf8")
  .replace(/^import \{ getEntries, requireRole \} from ".\/storage.js";$/m, "");

const stubs = `
function requireRole() {
  return { id: "student-1", name: "Test Student", role: "student" };
}
async function getEntries() { return []; }
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

  const calls = [];

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
        calls.push({ url: String(url), opts });
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

  return { window: dom.window, calls };
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("studentview.js — My Applications", () => {
  test("shows pending, approved and rejected applications together, not just pending", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          mark: 82,
          status: "pending",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
        {
          id: "a2",
          course_id: 2,
          mark: 70,
          status: "approved",
          courses: { course_code: "COMS2000", course_name: "Data Structures" },
        },
        {
          id: "a3",
          course_id: 3,
          mark: 40,
          status: "rejected",
          reason: "Mark below the course minimum",
          courses: { course_code: "COMS3000", course_name: "Advanced Topics" },
        },
      ],
    });
    await wait();

    const cards = window.document.querySelectorAll("#pendingList article");
    expect(cards.length).toBe(3);

    const text = window.document.getElementById("pendingList").textContent;
    expect(text).toContain("COMS1000");
    expect(text).toContain("COMS2000");
    expect(text).toContain("COMS3000");
  });

  test("shows the rejection reason on a rejected application", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a3",
          course_id: 3,
          mark: 40,
          status: "rejected",
          reason: "Mark below the course minimum",
          courses: { course_code: "COMS3000", course_name: "Advanced Topics" },
        },
      ],
    });
    await wait();

    expect(window.document.getElementById("pendingList").textContent).toContain(
      "Mark below the course minimum",
    );
  });

  test("only a pending application gets a Withdraw button", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          mark: 82,
          status: "pending",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
        {
          id: "a2",
          course_id: 2,
          mark: 70,
          status: "approved",
          courses: { course_code: "COMS2000", course_name: "Data Structures" },
        },
      ],
    });
    await wait();

    const cards = Array.from(
      window.document.querySelectorAll("#pendingList article"),
    );
    const pendingCard = cards.find((c) => c.textContent.includes("COMS1000"));
    const approvedCard = cards.find((c) => c.textContent.includes("COMS2000"));

    expect(pendingCard.querySelector("button")?.textContent).toBe("Withdraw");
    expect(approvedCard.querySelector("button")).toBeNull();
  });

  test("clicking Withdraw calls DELETE with the signed-in student's id and the right course", async () => {
    const { window, calls } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          mark: 82,
          status: "pending",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
      ],
    });
    await wait();

    const withdrawBtn = window.document.querySelector(
      "#pendingList article button",
    );
    withdrawBtn.click();
    await wait();

    const deleteCall = calls.find((c) => c.opts?.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall.url).toContain("userId=student-1");
    expect(deleteCall.url).toContain("courseId=1");
  });
});

describe("studentview.js — Open Sessions You Can Cover", () => {
  test("renders an open session with course, date/time/venue and a Claim button", async () => {
    const { window } = loadPage({
      openSessions: [
        {
          id: "s1",
          course_id: 1,
          session_date: "2026-09-25",
          start_time: "14:00:00",
          end_time: "16:00:00",
          venue: "FNB1",
          reason: "Regular tutor is away",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
      ],
    });
    await wait();

    const text = window.document.getElementById("openSessionsList").textContent;
    expect(text).toContain("COMS1000");
    expect(text).toContain("25/09/2026");
    expect(text).toContain("14:00–16:00");
    expect(text).toContain("FNB1");
    expect(text).toContain("Regular tutor is away");

    const claimBtn = window.document.querySelector(
      "#openSessionsList article button",
    );
    expect(claimBtn.textContent).toBe("Claim");
  });

  test("clicking Claim PATCHes the session's claim endpoint with the signed-in student's id", async () => {
    const { window, calls } = loadPage({
      openSessions: [
        {
          id: "s1",
          course_id: 1,
          session_date: "2026-09-25",
          start_time: "14:00:00",
          end_time: "16:00:00",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
      ],
    });
    await wait();

    window.document.querySelector("#openSessionsList article button").click();
    await wait();

    const claimCall = calls.find((c) => c.url.includes("/claim"));
    expect(claimCall).toBeDefined();
    expect(claimCall.url).toContain("/api/course-volunteers/s1/claim");
    expect(claimCall.opts.method).toBe("PATCH");
    expect(JSON.parse(claimCall.opts.body)).toEqual({ userId: "student-1" });
  });

  test("shows an empty state when there are no open sessions", async () => {
    const { window } = loadPage({ openSessions: [] });
    await wait();

    expect(
      window.document.getElementById("openSessionsList").textContent,
    ).toContain("No open sessions right now");
  });
});

describe("studentview.js — a claimed session in My Applications", () => {
  test("shows the session date/time instead of a mark for a session-claim row", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "s1",
          course_id: 1,
          status: "pending",
          session_date: "2026-09-25",
          start_time: "14:00:00",
          end_time: "16:00:00",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
      ],
    });
    await wait();

    const text = window.document.getElementById("pendingList").textContent;
    expect(text).toContain("25/09/2026");
    expect(text).not.toContain("Mark submitted");
  });
});

describe("studentview.js — Upcoming Sessions", () => {
  test("shows only approved, future-dated claimed sessions, soonest first", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "s1",
          course_id: 1,
          status: "approved",
          session_date: "2099-12-25",
          start_time: "14:00:00",
          end_time: "16:00:00",
          courses: { course_code: "LATER1000", course_name: "Later" },
        },
        {
          id: "s2",
          course_id: 2,
          status: "approved",
          session_date: "2099-01-01",
          start_time: "09:00:00",
          end_time: "11:00:00",
          courses: { course_code: "SOON1000", course_name: "Soon" },
        },
        {
          id: "s3",
          course_id: 3,
          status: "pending",
          session_date: "2099-01-01",
          start_time: "09:00:00",
          end_time: "11:00:00",
          courses: { course_code: "PENDING1000", course_name: "Pending" },
        },
        {
          id: "s4",
          course_id: 4,
          status: "approved",
          session_date: "2020-01-01",
          start_time: "09:00:00",
          end_time: "11:00:00",
          courses: { course_code: "PAST1000", course_name: "Past" },
        },
        {
          id: "a1",
          course_id: 5,
          status: "approved",
          mark: 80,
          courses: { course_code: "COURSEONLY1000", course_name: "No session" },
        },
      ],
    });
    await wait();

    const cards = window.document.querySelectorAll(
      "#upcomingSessionsList article",
    );
    const codes = Array.from(cards).map(
      (c) => c.querySelector("h3").textContent,
    );

    expect(codes).toEqual(["SOON1000", "LATER1000"]);
  });

  test("shows the empty state when there's nothing upcoming", async () => {
    const { window } = loadPage({ applications: [] });
    await wait();

    expect(
      window.document.getElementById("upcomingSessionsList").textContent,
    ).toContain("No upcoming sessions");
  });
});
