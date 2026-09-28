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
      if (user) {
        window.sessionStorage.setItem("user", JSON.stringify(user));
      }
      window.fetch = async (url) => {
        calls.push(String(url));
        return { ok: true, json: async () => applications };
      };
    },
  });

  return { window: dom.window, calls };
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    expect(calls).toHaveLength(1);
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
    // stays one-off claimed sessions only.
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
});
