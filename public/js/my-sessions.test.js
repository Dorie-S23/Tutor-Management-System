// my-sessions.js is a plain classic script (no imports), so unlike
// studentview.js it can just be concatenated in as-is — no stubbing needed.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "my-sessions.html"),
  "utf8",
);
const scriptSrc = fs.readFileSync(
  path.join(__dirname, "my-sessions.js"),
  "utf8",
);

function loadPage({
  user = { id: "student-1", role: "volunteer" },
  applications = [],
  applicationsFail = false,
  covers = [],
  coversFail = false,
  now = null,
} = {}) {
  const pageHtml = html
    .replace(
      '<script src="../js/my-sessions.js"></script>',
      `<script>${scriptSrc}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "my-sessions.js")).href}</script>`,
    )
    .replace('<script src="../js/logout.js"></script>', "");

  const calls = [];

  const dom = new JSDOM(pageHtml, {
    url: "http://localhost/my-sessions.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // Pin the clock for the same-day boundary tests (see FIXED_NOW): the
      // page reads new Date() both for its "today" and for the end-time
      // comparison, so both have to agree on a single instant.
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
      if (user) {
        window.sessionStorage.setItem("user", JSON.stringify(user));
      }
      window.fetch = async (url) => {
        calls.push(String(url));
        if (String(url).startsWith("/api/session-excusals")) {
          if (coversFail) throw new Error("network down");
          return { ok: true, json: async () => covers };
        }
        if (applicationsFail) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => applications };
      };
    },
  });

  return { window: dom.window, calls };
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A fixed clock for the same-day boundary tests. The page takes its "today"
// from toISOString() — the UTC date, "2026-09-29" for this instant whichever
// timezone the suite runs in — while end times compare as local "HH:MM", so
// the fixtures below build those strings from the same instant.
const FIXED_NOW = "2026-09-29T12:00:00Z";
const fixedNowMs = Date.parse(FIXED_NOW);
const fixedNowHm = new Date(fixedNowMs).toTimeString().slice(0, 5);
const oneMinuteEarlierHm = new Date(fixedNowMs - 60000)
  .toTimeString()
  .slice(0, 5);
const oneMinuteLaterHm = new Date(fixedNowMs + 60000)
  .toTimeString()
  .slice(0, 5);

describe("my-sessions.js", () => {
  // jsdom doesn't implement real navigation — assigning window.location.href
  // is a documented no-op there — so the observable proof that the guard
  // redirected (rather than actually checking the URL) is that it bailed
  // out before ever fetching the student's sessions.
  test("doesn't fetch anything when nobody is signed in", async () => {
    const { calls } = loadPage({ user: null });
    await wait();

    expect(calls).toHaveLength(0);
  });

  test("doesn't fetch anything for a non-volunteer role", async () => {
    const { calls } = loadPage({
      user: { id: "tutor-1", role: "tutor" },
    });
    await wait();

    expect(calls).toHaveLength(0);
  });

  test("still treats a legacy student-role account as a volunteer", async () => {
    const { window, calls } = loadPage({
      user: { id: "student-1", role: "student" },
    });
    await wait();

    // Both sources are read: the applications/claims and the covers.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/api/course-volunteers?userId=student-1");
    expect(calls[1]).toContain("/api/session-excusals?coverUserId=student-1");
    expect(
      window.document.getElementById("upcomingList").textContent,
    ).toContain("No upcoming sessions");
  });

  test("splits approved claimed sessions into Upcoming and Past by date", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "s1",
          status: "approved",
          session_date: "2099-01-01",
          start_time: "14:00:00",
          end_time: "16:00:00",
          venue: "FNB1",
          courses: { course_code: "SOON1000", course_name: "Soon" },
        },
        {
          id: "s2",
          status: "approved",
          session_date: "2020-01-01",
          start_time: "09:00:00",
          end_time: "11:00:00",
          courses: { course_code: "OLD1000", course_name: "Old" },
        },
        // Not approved yet — shouldn't appear in either list.
        {
          id: "s3",
          status: "pending",
          session_date: "2099-06-01",
          start_time: "09:00:00",
          end_time: "11:00:00",
          courses: { course_code: "PENDING1000", course_name: "Pending" },
        },
        // A blanket course application, no session_date — shouldn't appear either.
        {
          id: "a1",
          status: "approved",
          mark: 80,
          courses: { course_code: "COURSEONLY1000", course_name: "No session" },
        },
      ],
    });
    await wait();

    const upcomingText =
      window.document.getElementById("upcomingList").textContent;
    const pastText = window.document.getElementById("pastList").textContent;

    expect(upcomingText).toContain("SOON1000");
    expect(upcomingText).toContain("FNB1");
    expect(upcomingText).not.toContain("PENDING1000");
    expect(upcomingText).not.toContain("COURSEONLY1000");

    expect(pastText).toContain("OLD1000");
    expect(pastText).not.toContain("SOON1000");
  });

  test("includes an approved whole-course application's recurring slot in Upcoming", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "c1",
          status: "approved",
          mark: 80,
          courses: {
            course_code: "RECUR1000",
            course_name: "Recurring",
            Day_of_tut: "Thursday",
            tutor_start_time: "14:15:00",
            tutor_end_time: "17:00:00",
            venues: "FNB1",
          },
        },
        // Still pending — its slot isn't a commitment yet, so it must
        // not appear on this page any more than on the dashboard's card.
        {
          id: "c2",
          status: "pending",
          mark: 75,
          courses: {
            course_code: "PENDING2000",
            course_name: "Pending course",
            Day_of_lab: "Monday",
            lab_start_time: "10:00:00",
            lab_end_time: "11:00:00",
            lab_venues: "MSL001",
          },
        },
      ],
    });
    await wait();

    const upcomingText =
      window.document.getElementById("upcomingList").textContent;

    expect(upcomingText).toContain("RECUR1000");
    expect(upcomingText).toContain("Tutorial:");
    expect(upcomingText).toContain("FNB1");
    expect(upcomingText).toContain("repeats weekly");
    expect(upcomingText).not.toContain("PENDING2000");

    // No per-week attendance history exists for recurring slots, so Past
    // holds dated sessions (claimed one-offs and covers) only — and here
    // neither exists.
    expect(window.document.getElementById("pastList").textContent).toContain(
      "No past sessions",
    );
  });

  test("shows empty-state copy for both lists when there's nothing", async () => {
    const { window } = loadPage({ applications: [] });
    await wait();

    expect(
      window.document.getElementById("upcomingList").textContent,
    ).toContain("No upcoming sessions");
    expect(window.document.getElementById("pastList").textContent).toContain(
      "No past sessions",
    );
  });

  test("shows a cover whose session has already happened under Past", async () => {
    const { window } = loadPage({
      covers: [
        {
          id: "e1",
          course_id: "c1",
          session_date: "2020-05-06",
          session_type: "lab",
          courses: {
            course_code: "COVERED1000",
            course_name: "Covered course",
            lab_start_time: "10:00:00",
            lab_end_time: "12:00:00",
            lab_venues: "MSL001",
          },
          tutors: { name: "Ada" },
        },
      ],
    });
    await wait();

    const pastText = window.document.getElementById("pastList").textContent;
    expect(pastText).toContain("COVERED1000");
    expect(pastText).toContain("Covered for Ada");
    expect(pastText).toContain("MSL001");
    expect(pastText).not.toContain("No past sessions");
  });

  test("shows a cover still to come under Upcoming, not Past", async () => {
    const { window } = loadPage({
      covers: [
        {
          id: "e2",
          course_id: "c2",
          session_date: "2099-03-04",
          session_type: "tutorial",
          courses: {
            course_code: "COVER1000",
            course_name: "Covering course",
            tutor_start_time: "14:00:00",
            tutor_end_time: "15:30:00",
            venues: "FNB1",
          },
          tutors: { name: "Grace" },
        },
      ],
    });
    await wait();

    const upcomingText =
      window.document.getElementById("upcomingList").textContent;
    expect(upcomingText).toContain("COVER1000");
    expect(upcomingText).toContain("Covering for Grace");
    expect(upcomingText).toContain("Tutorial:");
    expect(window.document.getElementById("pastList").textContent).toContain(
      "No past sessions",
    );
  });

  test("moves a same-day claim to Past the moment its end time passes", async () => {
    const { window } = loadPage({
      now: FIXED_NOW,
      applications: [
        {
          id: "s1",
          status: "approved",
          session_date: "2026-09-29",
          start_time: `${oneMinuteEarlierHm}:00`,
          end_time: `${fixedNowHm}:00`,
          courses: { course_code: "TODAY1000", course_name: "Just finished" },
        },
      ],
    });
    await wait();

    expect(window.document.getElementById("pastList").textContent).toContain(
      "TODAY1000",
    );
    expect(
      window.document.getElementById("upcomingList").textContent,
    ).not.toContain("TODAY1000");
  });

  test("moves a same-day cover to Past once its session has ended", async () => {
    const { window } = loadPage({
      now: FIXED_NOW,
      covers: [
        {
          id: "e4",
          course_id: "c4",
          session_date: "2026-09-29",
          session_type: "tutorial",
          courses: {
            course_code: "TODAYCOVER1000",
            course_name: "Just covered",
            tutor_start_time: `${oneMinuteEarlierHm}:00`,
            tutor_end_time: `${fixedNowHm}:00`,
            venues: "FNB1",
          },
          tutors: { name: "Ada" },
        },
      ],
    });
    await wait();

    const pastText = window.document.getElementById("pastList").textContent;
    expect(pastText).toContain("TODAYCOVER1000");
    expect(pastText).toContain("Covered for Ada");
    expect(
      window.document.getElementById("upcomingList").textContent,
    ).not.toContain("TODAYCOVER1000");
  });

  test("keeps a running cover under Upcoming until its session ends", async () => {
    const { window } = loadPage({
      now: FIXED_NOW,
      covers: [
        {
          id: "e5",
          course_id: "c5",
          session_date: "2026-09-29",
          session_type: "lab",
          courses: {
            course_code: "RUNNING1000",
            course_name: "Running now",
            lab_start_time: `${fixedNowHm}:00`,
            lab_end_time: `${oneMinuteLaterHm}:00`,
            lab_venues: "MSL002",
          },
          tutors: { name: "Grace" },
        },
      ],
    });
    await wait();

    expect(
      window.document.getElementById("upcomingList").textContent,
    ).toContain("RUNNING1000");
    expect(window.document.getElementById("pastList").textContent).toContain(
      "No past sessions",
    );
  });

  test("keeps a same-day session with no end time under Upcoming", async () => {
    const { window } = loadPage({
      now: FIXED_NOW,
      applications: [
        {
          id: "s1",
          status: "approved",
          session_date: "2026-09-29",
          start_time: `${fixedNowHm}:00`,
          courses: { course_code: "NOEND1000", course_name: "No end time" },
        },
      ],
    });
    await wait();

    expect(
      window.document.getElementById("upcomingList").textContent,
    ).toContain("NOEND1000");
    expect(window.document.getElementById("pastList").textContent).toContain(
      "No past sessions",
    );
  });

  test("keeps the claimed sessions when the covers fetch fails", async () => {
    const { window } = loadPage({
      coversFail: true,
      applications: [
        {
          id: "s1",
          status: "approved",
          session_date: "2099-01-01",
          start_time: "14:00:00",
          end_time: "16:00:00",
          courses: { course_code: "SOON1000", course_name: "Soon" },
        },
      ],
    });
    await wait();

    expect(
      window.document.getElementById("upcomingList").textContent,
    ).toContain("SOON1000");
  });

  test("shows the load error when the sessions fetch fails", async () => {
    const { window } = loadPage({
      applicationsFail: true,
      covers: [
        {
          id: "e3",
          course_id: "c3",
          session_date: "2099-03-04",
          session_type: "tutorial",
          courses: {
            course_code: "COVER1000",
            course_name: "Covering course",
            tutor_start_time: "14:00:00",
            tutor_end_time: "15:30:00",
          },
          tutors: { name: "Grace" },
        },
      ],
    });
    await wait();

    const upcomingText =
      window.document.getElementById("upcomingList").textContent;
    expect(upcomingText).toContain("Couldn't load your sessions right now.");
    expect(window.document.getElementById("pastList").textContent).toBe("");
  });
});
