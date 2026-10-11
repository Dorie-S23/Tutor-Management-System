// notifications.js is the shared bell + dropdown loaded on every tutor/
// student page. It's a plain browser script (sessionStorage, fetch,
// setInterval), so it runs in a real jsdom window here with a stubbed fetch
// and the //# sourceURL tag so Jest's v8 coverage attributes executed lines
// back to the real file.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pathToFileURL } = require("url");

const notificationsJs = fs.readFileSync(
  path.join(__dirname, "notifications.js"),
  "utf8",
);

const BELL_MARKUP = `
  <div id="notifBell">
    <button id="notifBellBtn" aria-expanded="false"></button>
    <span id="notifBellBadge" hidden></span>
    <div id="notifDropdown" hidden>
      <ul id="notifList"></ul>
      <p id="notifEmpty"></p>
    </div>
  </div>
`;

const BELL_MARKUP_WITH_MARK_ALL = BELL_MARKUP.replace(
  '<p id="notifEmpty"></p>',
  '<p id="notifEmpty"></p><button id="notifMarkAllBtn"></button>',
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

function notification(overrides = {}) {
  return {
    id: "n1",
    message: "Class moved",
    read: false,
    type: "session_change",
    related_id: "c9",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function loadNotifications({
  markup = BELL_MARKUP,
  storedUser = JSON.stringify({ id: "tutor-1", role: "tutor" }),
  respond,
} = {}) {
  // Clicking an unread item ends in `window.location.href = ...`, which
  // jsdom reports as "Not implemented: navigation" — swallow that through a
  // quiet virtual console so the suite output stays clean, but keep the
  // attempts so tests can count which clicks resolved a destination.
  const virtualConsole = new VirtualConsole();
  const navErrors = [];
  virtualConsole.on("jsdomError", (err) => navErrors.push(err));

  const calls = [];
  const state = { respond };
  const dom = new JSDOM(
    `<!doctype html><html><body>${markup}<script>${notificationsJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "notifications.js")).href}</script></body></html>`,
    {
      url: "http://localhost/dashboard.html",
      runScripts: "dangerously",
      virtualConsole,
      beforeParse(window) {
        if (storedUser !== null) {
          window.sessionStorage.setItem("user", storedUser);
        }
        window.fetch = (url, options = {}) => {
          calls.push({ url: String(url), method: options.method || "GET" });
          return state.respond(String(url), options);
        };
      },
    },
  );

  return { win: dom.window, calls, state, navErrors };
}

describe("notifications.js", () => {
  test("does nothing without the bell markup", () => {
    const { win, calls } = loadNotifications({
      markup: "<p>no bell here</p>",
      respond: () => jsonResponse([]),
    });

    expect(calls).toHaveLength(0);
    win.close();
  });

  test("does nothing without a signed-in user", () => {
    const { win, calls } = loadNotifications({
      storedUser: null,
      respond: () => jsonResponse([]),
    });

    expect(calls).toHaveLength(0);
    win.close();
  });

  test("does nothing when the stored user is unreadable", () => {
    const { win, calls } = loadNotifications({
      storedUser: "{not json",
      respond: () => jsonResponse([]),
    });

    expect(calls).toHaveLength(0);
    win.close();
  });

  test("renders badge and list, and clicking items marks them read", async () => {
    const items = [
      notification({
        id: "n1",
        created_at: new Date(Date.now() - 10 * 1000).toISOString(),
      }),
      notification({
        id: "n2",
        type: "timesheet_due",
        related_id: "2026-09-07",
        message: "Timesheet due",
        created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
      notification({
        id: "n3",
        type: "application_status",
        related_id: "a1",
        read: true,
        message: "Application approved",
        created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      }),
      notification({
        id: "n4",
        type: "mystery",
        related_id: null,
        read: true,
        message: "Old news",
        created_at: new Date(Date.now() - 3 * 86400 * 1000).toISOString(),
      }),
    ];

    const { win, calls } = loadNotifications({
      respond: () => jsonResponse(items),
    });
    await flush();

    const doc = win.document;
    const badge = doc.getElementById("notifBellBadge");
    expect(calls[0].url).toBe("/api/notifications?userId=tutor-1");
    expect(doc.getElementById("notifEmpty").hidden).toBe(true);

    let lis = [...doc.querySelectorAll("#notifList li")];
    expect(lis).toHaveLength(4);
    expect(badge.textContent).toBe("2");
    expect(badge.hidden).toBe(false);
    expect(lis[0].classList.contains("notif-item--unread")).toBe(true);
    expect(lis[2].classList.contains("notif-item--unread")).toBe(false);

    const times = [...doc.querySelectorAll(".notif-time")].map(
      (el) => el.textContent,
    );
    expect(times).toEqual(["just now", "5m ago", "2h ago", "3d ago"]);

    // Unread item: marked read (PATCH) and its destination navigated to.
    lis[0].click();
    expect(badge.textContent).toBe("1");
    await flush();
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.url)).toEqual(
      ["/api/notifications/n1"],
    );

    // Read item: destination resolved, but no mark-read call.
    lis = [...doc.querySelectorAll("#notifList li")];
    lis[2].click();
    await flush();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    // Read item with no related id and an unmapped type: no navigation.
    lis = [...doc.querySelectorAll("#notifList li")];
    lis[3].click();
    await flush();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    win.close();
  });

  test("caps the badge at 9+ and resolves role-specific destinations", async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      notification({
        id: `n${i}`,
        type: i % 2 === 0 ? "session_change" : "timesheet_due",
      }),
    );

    const { win, calls } = loadNotifications({
      storedUser: JSON.stringify({ id: "student-1", role: "student" }),
      respond: () => jsonResponse(items),
    });
    await flush();

    const badge = win.document.getElementById("notifBellBadge");
    expect(badge.textContent).toBe("9+");

    // session_change maps to StudentView.html for students; timesheet_due
    // has no student page, so it only marks read.
    const lis = [...win.document.querySelectorAll("#notifList li")];
    lis[0].click();
    lis[1].click();
    await flush();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);

    win.close();
  });

  test("routes attendance notifications to the role's verification page", async () => {
    const items = [
      notification({
        id: "n1",
        type: "attendance_logged",
        related_id: "e5",
        read: true,
      }),
      notification({
        id: "n2",
        type: "attendance_verified",
        related_id: "e6",
        read: true,
      }),
      notification({
        id: "n3",
        type: "attendance_flagged",
        related_id: "e7",
        read: true,
      }),
    ];

    const { win, navErrors } = loadNotifications({
      storedUser: JSON.stringify({ id: "o1", role: "organiser" }),
      respond: () => jsonResponse(items),
    });
    await flush();

    // The organiser navigates for the logged-session ping only — the
    // verified/flagged types are for the entry's tutor or volunteer, not
    // the reviewer who sent them.
    const lis = [...win.document.querySelectorAll("#notifList li")];
    lis.forEach((li) => li.click());
    await flush();
    expect(navErrors).toHaveLength(1);

    win.close();
  });

  test("sends a tutor's verified and flagged sessions down the deep-link", async () => {
    const items = [
      notification({
        id: "n1",
        type: "attendance_verified",
        related_id: "e6",
        read: true,
      }),
      notification({
        id: "n2",
        type: "attendance_flagged",
        related_id: "e7",
        read: true,
      }),
      notification({
        id: "n3",
        type: "attendance_logged",
        related_id: "e5",
        read: true,
      }),
    ];

    const { win, navErrors } = loadNotifications({
      respond: () => jsonResponse(items),
    });
    await flush();

    // Default storedUser is a tutor: verified + flagged resolve to
    // log-hours.html; attendance_logged has no tutor destination.
    const lis = [...win.document.querySelectorAll("#notifList li")];
    lis.forEach((li) => li.click());
    await flush();
    expect(navErrors).toHaveLength(2);

    win.close();
  });

  test("routes a timesheet_submitted ping to the review queue for organisers only", async () => {
    // The tutor filed the month — organisers land on the review queue with
    // that row flashed (related_id is "<userId>_<monthStart>", matching
    // timesheet-review.js's highlight key). The tutor has no destination
    // for their own filing, so the same unread item just marks read.
    const item = () =>
      notification({
        id: "n1",
        type: "timesheet_submitted",
        related_id: "t1_2026-09-01",
      });

    const organiser = loadNotifications({
      storedUser: JSON.stringify({ id: "o1", role: "organiser" }),
      respond: () => jsonResponse([item()]),
    });
    await flush();
    [...organiser.win.document.querySelectorAll("#notifList li")].forEach(
      (li) => li.click(),
    );
    await flush();
    expect(organiser.navErrors).toHaveLength(1);
    organiser.win.close();

    const tutor = loadNotifications({ respond: () => jsonResponse([item()]) });
    await flush();
    [...tutor.win.document.querySelectorAll("#notifList li")].forEach((li) =>
      li.click(),
    );
    await flush();
    expect(tutor.navErrors).toHaveLength(0);
    tutor.win.close();
  });

  test("shows the empty state when there are no notifications", async () => {
    const { win } = loadNotifications({ respond: () => jsonResponse([]) });
    await flush();

    const doc = win.document;
    expect(doc.getElementById("notifBellBadge").hidden).toBe(true);
    expect(doc.getElementById("notifEmpty").hidden).toBe(false);
    expect(doc.getElementById("notifList").children).toHaveLength(0);

    win.close();
  });

  test("toggles the dropdown, closes on outside clicks, marks all read", async () => {
    let phase = "initial";
    const unread = [notification({ id: "n1" }), notification({ id: "n2" })];
    const read = unread.map((n) => ({ ...n, read: true }));

    const { win, calls } = loadNotifications({
      markup: BELL_MARKUP_WITH_MARK_ALL,
      respond: () => jsonResponse(phase === "initial" ? unread : read),
    });
    await flush();
    expect(calls).toHaveLength(1); // the initial poll

    const doc = win.document;
    const bellBtn = doc.getElementById("notifBellBtn");
    const dropdown = doc.getElementById("notifDropdown");

    bellBtn.click();
    expect(dropdown.hidden).toBe(false);
    expect(bellBtn.getAttribute("aria-expanded")).toBe("true");
    await flush();
    expect(calls).toHaveLength(2); // opening re-fetches

    bellBtn.click();
    expect(dropdown.hidden).toBe(true);
    expect(bellBtn.getAttribute("aria-expanded")).toBe("false");

    bellBtn.click();
    doc.body.click(); // outside click closes an open dropdown
    expect(dropdown.hidden).toBe(true);
    expect(bellBtn.getAttribute("aria-expanded")).toBe("false");

    bellBtn.click();
    phase = "after-read";
    doc.getElementById("notifMarkAllBtn").click();
    await flush();
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.url)).toEqual(
      ["/api/notifications/read-all"],
    );
    expect(doc.getElementById("notifBellBadge").hidden).toBe(true);

    win.close();
  });

  test("keeps working when the API is unreachable", async () => {
    let call = 0;
    const { win, calls } = loadNotifications({
      respond: () => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error("offline"))
          : jsonResponse([], false);
      },
    });
    await flush();
    expect(calls).toHaveLength(1);

    // Opening the bell triggers another failed load — must not throw.
    win.document.getElementById("notifBellBtn").click();
    await flush();
    expect(calls).toHaveLength(2);
    expect(win.document.getElementById("notifList").children).toHaveLength(0);

    win.close();
  });
});
