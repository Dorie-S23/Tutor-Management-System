// The review page's background sync mirrors the board's: the queue polls
// every 8 seconds (paused while the tab is hidden, catch-up on refocus), a
// poll that lands on unchanged data leaves the DOM untouched, and the
// "Synced … ago" stamp lives in the sync icon's hover text — flashing for a
// moment each time a refresh lands. Same jsdom approach as
// timesheet-review.test.js: the real HTML + script, a stubbed fetch standing
// in for the server, and direct calls to the sync hooks a test can't wait
// 8 real seconds for.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

jest.setTimeout(15000);

const pageHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "timesheet-review.html"),
  "utf8",
);
const pageJs = fs.readFileSync(
  path.join(__dirname, "timesheet-review.js"),
  "utf8",
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(fn, { timeout = 4000, step = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  throw new Error("waitFor timed out");
}

function makeSubmission(userId, name) {
  return {
    user_id: userId,
    week_start: "2026-09-01",
    status: "pending",
    total_hours: 6.5,
    submitted_at: "2026-10-02T08:30:00.000Z",
    reviewer_note: null,
    entries_snapshot: [],
    users: { name, email: `${userId}@wits.ac.za` },
  };
}

// The server side of the page: `rows` is what /api/timesheets answers with;
// tests mutate it to simulate another organiser's or a tutor's activity.
// `state.failNext` makes the next fetch fail like a dropped connection.
function loadPage({ rows = [makeSubmission("t1", "Thandi Tutor")] } = {}) {
  // Inline the script under test (with its real sourceURL so coverage
  // attribution matches the other jsdom suites) and drop the page's other
  // scripts — they aren't what this suite exercises.
  const html = pageHtml
    .replace(
      '<script src="../js/timesheet-review.js"></script>',
      `<script>${pageJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "timesheet-review.js")).href}</script>\n<script>window.__syncTest = { tick: () => tickSyncStatusLabel(), resync: () => refreshReviewQueue() };</script>`,
    )
    .replace('<script src="../js/user-badge.js"></script>', "")
    .replace('<script src="../js/universal-search.js"></script>', "")
    .replace('<script src="../js/notifications.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "")
    .replace(/<script type="module">[\s\S]*?<\/script>/, "");

  const calls = [];
  const state = { failNext: false };

  const dom = new JSDOM(html, {
    url: "http://localhost/timesheet-review.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url) => {
        calls.push(String(url));
        if (state.failNext) {
          state.failNext = false;
          return Promise.reject(new Error("offline"));
        }
        if (String(url).includes("timesheet-disputes")) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => rows });
      };
      // jsdom doesn't implement the <dialog> open/close methods the modal
      // guard leans on, so give them the browser's observable behaviour.
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function () {
          this.open = true;
        };
        window.HTMLDialogElement.prototype.close = function () {
          this.open = false;
        };
      }
      // A controllable clock for the Date.now() calls behind the hover
      // label: real time until a test pins it, so the initial load stamps
      // naturally and the test then walks the label ladder. Null un-pins
      // back to real time (needed before a re-sync, which stamps a real
      // new Date the pinned clock would otherwise outrun).
      const realNow = window.Date.now.bind(window.Date);
      let pinned = null;
      window.Date.now = () => (pinned === null ? realNow() : pinned);
      window.__setNow = (value) => {
        pinned = value;
      };
    },
  });

  return { window: dom.window, dom, calls, state, rows };
}

describe("timesheet-review background sync", () => {
  let page;

  afterEach(() => {
    // Boot starts polling intervals — closing the window stops them so they
    // don't fire against a torn-down document and hang the runner.
    page?.dom.window.close();
    page = null;
  });

  test("quiet by default; hover label steps up units; each sync flashes the icon", async () => {
    const t0 = Date.now();
    page = loadPage();
    const el = page.window.document.getElementById("syncStatus");

    // init() stamps lastSyncedAt once the first load round completes.
    await waitFor(() => el.title === "Synced just now");

    // Icon, not a text label — the wording lives in title/aria-label.
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.textContent.trim()).toBe("");
    expect(el.getAttribute("aria-label")).toBe("Synced just now");
    // The initial load doesn't flash — the pulse is reserved for re-syncs.
    expect(el.classList.contains("is-flashing")).toBe(false);

    // The hover label steps up through units — no ever-growing counts.
    page.window.__setNow(t0 + 90_000);
    page.window.__syncTest.tick();
    expect(el.title).toBe("Synced 1m ago");

    page.window.__setNow(t0 + 3_700_000);
    page.window.__syncTest.tick();
    expect(el.title).toBe("Synced 1h ago");

    page.window.__setNow(t0 + 90_000_000);
    page.window.__syncTest.tick();
    expect(el.title).toBe("Synced 1d ago");

    // A poll lands: the label resets and the icon flashes to full opacity…
    page.window.__setNow(null);
    page.window.__syncTest.resync();
    await waitFor(() => el.title === "Synced just now");
    expect(el.classList.contains("is-flashing")).toBe(true);

    // …then fades back to transparent-ish on its own.
    await waitFor(() => !el.classList.contains("is-flashing"));
    expect(el.classList.contains("is-flashing")).toBe(false);
  });

  test("a poll picks up another user's change and rebuilds the queue", async () => {
    page = loadPage();
    const doc = page.window.document;
    await waitFor(
      () => doc.querySelectorAll("#submissionList > li").length === 1,
    );

    // A new submission arrives server-side between ticks.
    page.rows.push(makeSubmission("t2", "Sipho Student"));

    page.window.__syncTest.resync();
    await waitFor(
      () => doc.querySelectorAll("#submissionList > li").length === 2,
    );
    const el = doc.getElementById("syncStatus");
    await waitFor(() => el.classList.contains("is-flashing"));
    expect(doc.body.textContent).toContain("Sipho Student");
  });

  test("a tick with no new data leaves the DOM untouched", async () => {
    page = loadPage();
    const doc = page.window.document;
    await waitFor(
      () => doc.querySelectorAll("#submissionList > li").length === 1,
    );

    const li = doc.querySelector("#submissionList > li");
    li.dataset.marker = "kept";

    page.window.__syncTest.resync();
    // The flash proves the refresh round finished; the row must still be the
    // same node — a rebuild would have replaced it and dropped the marker.
    const el = doc.getElementById("syncStatus");
    await waitFor(() => el.classList.contains("is-flashing"));
    expect(doc.querySelector("#submissionList > li")).toBe(li);
    expect(li.dataset.marker).toBe("kept");
  });

  test("a modal holds the queue refresh until it closes", async () => {
    page = loadPage();
    const doc = page.window.document;
    await waitFor(
      () => doc.querySelectorAll("#submissionList > li").length === 1,
    );

    const modal = doc.getElementById("reasonModal");
    modal.showModal();
    page.rows.push(makeSubmission("t2", "Sipho Student"));

    page.window.__syncTest.resync();
    await flush();
    await flush();
    // The tick ran while the organiser was mid-decision — nothing moved.
    expect(doc.querySelectorAll("#submissionList > li").length).toBe(1);

    modal.close();
    page.window.__syncTest.resync();
    await waitFor(
      () => doc.querySelectorAll("#submissionList > li").length === 2,
    );
  });

  test("a failed poll stays quiet; a failed user action still toasts", async () => {
    page = loadPage();
    const doc = page.window.document;
    const el = doc.getElementById("syncStatus");
    await waitFor(() => el.title === "Synced just now");
    const toast = doc.getElementById("toast");

    // Background tick fails — no toast for a dropped connection every few
    // seconds, and the sync icon doesn't pretend the refresh landed.
    page.state.failNext = true;
    page.window.__syncTest.resync();
    await flush();
    await flush();
    expect(toast.textContent).toBe("");
    expect(toast.classList.contains("show")).toBe(false);

    // A user-initiated load (filter chip) still surfaces the failure…
    page.state.failNext = true;
    doc.querySelector('.filter-chip[data-status="approved"]').click();
    await flush();
    await flush();
    expect(toast.textContent).toBe("Couldn't load timesheets.");
    expect(toast.classList.contains("show")).toBe(true);

    // …and the next successful poll still syncs normally.
    page.window.__syncTest.resync();
    await waitFor(() => el.classList.contains("is-flashing"));
  });
});
