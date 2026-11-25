// storage.js is a browser ES module (sessionStorage/localStorage/fetch,
// `export function ...`), not something meant to be require()'d as
// CommonJS. As with board.keyboard-nav.test.js, we load the real file's
// source into an actual jsdom window so tests exercise the real functions —
// `export` is stripped (classic <script> tags don't support it) and the
// exported names are attached to window.__storage so tests can call them.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const rawStorageJs = fs.readFileSync(
  path.join(__dirname, "storage.js"),
  "utf8",
);

const EXPORTED_NAMES = [
  "getCurrentUser",
  "requireRole",
  "getEntries",
  "addEntry",
  "updateEntry",
  "deleteEntry",
  "findDuplicateEntry",
  "getEntriesForWeek",
  "getWeekTotal",
  "getEntriesForMonth",
  "getMonthTotal",
  "getEntriesForDate",
  "getWeekStart",
  "addDays",
  "getMonthStart",
  "addMonths",
  "todayStr",
  "getProfile",
  "saveProfile",
  "loadSchedule",
  "getSchedule",
  "addScheduleClasses",
  "deleteScheduleClass",
  "updateScheduleClass",
  "clearSchedule",
  "getScheduleExceptions",
  "cancelScheduleOccurrence",
  "modifyScheduleOccurrence",
  "clearScheduleException",
  "getCancelledOccurrencesForDate",
  "getScheduleForDate",
];

// existingEntries seeds the GET /api/hour-entries response that
// getEntries() (and therefore findDuplicateEntry) sees on its first call —
// storage.js caches that response in a module-level variable each fresh
// jsdom window gets its own copy of, so this is enough to test
// findDuplicateEntry's overlap logic without going through a real addEntry.
function loadStorage(existingEntries = []) {
  const storageJs = rawStorageJs.replace(
    /^export (async function|function)/gm,
    "$1",
  );

  // requireRole()'s only observable effect on a redirect is
  // `window.location.href = "somewhere.html"` — but jsdom's real
  // `window.location` cannot be replaced (its own property, and even
  // `.href`'s, are non-configurable) and a real cross-page assignment is
  // simply a no-op in jsdom ("Not implemented: navigation"), so `.href`
  // never actually changes there. Instead we shadow the *identifier*
  // `window` with a plain, writable stand-in for this eval — storage.js
  // only ever reaches the real global via bare `fetch`/`sessionStorage`/
  // `localStorage`, never via `window.` for those — and publish the fake
  // location and the exported functions onto `globalThis` (the *real*
  // jsdom window, unaffected by the local `window` shadow) so the test can
  // read them back afterwards. The stand-in sits on a single newline-free
  // line so the eval'd text's line numbers stay identical to storage.js's
  // own — volunteer-timesheets.render.test.js prepends this exact line, and
  // Jest's v8 coverage only merges the two suites' copies of storage.js
  // cleanly when their text layouts match.
  const shadowWindow = `var __fakeLocation = { href: "" }; const window = { location: __fakeLocation }; `;
  const testHooks = `
    globalThis.__storage = { ${EXPORTED_NAMES.join(", ")} };
    globalThis.__location = __fakeLocation;
  `;

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/dashboard.html",
    runScripts: "dangerously",
    beforeParse(window) {
      // storage.js only hits the network for hour-entries and the
      // best-effort tutor_busy_times mirror. fromApiEntry() (storage.js)
      // reads snake_case fields off each row, same shape the real API
      // returns.
      window.fetch = () =>
        Promise.resolve({
          ok: true,
          json: async () =>
            existingEntries.map((e) => ({
              id: e.id,
              date: e.date,
              hours: e.hours,
              start_time: e.startTime,
              end_time: e.endTime,
              task_type: e.taskType,
              subject: e.subject,
              notes: e.notes,
            })),
        });
    },
  });

  // The sourceURL comment (last line of the eval'd string) tags the script
  // with the real file's path so Jest's v8 coverage can attribute the lines
  // executed in this eval back to storage.js instead of dropping them.
  dom.window.eval(
    `${shadowWindow}${storageJs}\n${testHooks}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "storage.js")).href}`,
  );
  return dom.window;
}

function setCurrentUser(window, user) {
  if (user) {
    window.sessionStorage.setItem("user", JSON.stringify(user));
  } else {
    window.sessionStorage.removeItem("user");
  }
}

describe("getCurrentUser", () => {
  test("returns null when no one is signed in", () => {
    const window = loadStorage();
    expect(window.__storage.getCurrentUser()).toBeNull();
  });

  test("returns the parsed signed-in user", () => {
    const window = loadStorage();
    setCurrentUser(window, { id: "u1", role: "tutor" });
    expect(window.__storage.getCurrentUser()).toEqual({
      id: "u1",
      role: "tutor",
    });
  });

  test("returns null instead of throwing on corrupted session data", () => {
    const window = loadStorage();
    window.sessionStorage.setItem("user", "{not valid json");
    expect(window.__storage.getCurrentUser()).toBeNull();
  });

  // Accounts created before the Volunteer rename were stored with role
  // "student" — every page should still see them as "volunteer".
  test("reports a legacy student session as volunteer", () => {
    const window = loadStorage();
    setCurrentUser(window, { id: "u1", role: "student" });
    expect(window.__storage.getCurrentUser()).toEqual({
      id: "u1",
      role: "volunteer",
    });
  });
});

describe("requireRole", () => {
  test("sends a signed-out visitor to login and returns null", () => {
    const window = loadStorage();
    const result = window.__storage.requireRole("tutor");
    expect(result).toBeNull();
    expect(window.__location.href).toBe("login.html");
  });

  test("lets a matching role through without redirecting", () => {
    const window = loadStorage();
    setCurrentUser(window, { id: "u1", role: "tutor" });
    const result = window.__storage.requireRole("tutor");
    expect(result).toEqual({ id: "u1", role: "tutor" });
    expect(window.__location.href).toBe("");
  });

  // This is the exact bypass a student volunteer hit: landing on the tutor
  // calendar via a stale nav link and reaching the tutor dashboard from
  // there with no role check at all.
  test.each([
    ["volunteer", "StudentView.html"],
    ["tutor", "dashboard.html"],
    ["educator", "educator.html"],
    ["organiser", "board.html"],
    ["super_organiser", "board.html"],
  ])(
    "sends a signed-in %s back to their own home page instead of the wrong-role page",
    (role, home) => {
      const window = loadStorage();
      setCurrentUser(window, { id: "u1", role });
      const result = window.__storage.requireRole("some-other-role");
      expect(result).toBeNull();
      expect(window.__location.href).toBe(home);
    },
  );

  test("falls back to login for an unrecognised role", () => {
    const window = loadStorage();
    setCurrentUser(window, { id: "u1", role: "mystery-role" });
    const result = window.__storage.requireRole("tutor");
    expect(result).toBeNull();
    expect(window.__location.href).toBe("login.html");
  });

  // The organiser pages are shared with the super-organiser admin, so their
  // guards pass both roles as an array rather than a single string.
  test("an array of allowed roles lets any listed role through", () => {
    const window = loadStorage();
    setCurrentUser(window, { id: "u1", role: "super_organiser" });
    const result = window.__storage.requireRole([
      "organiser",
      "super_organiser",
    ]);
    expect(result).toEqual({ id: "u1", role: "super_organiser" });
    expect(window.__location.href).toBe("");
  });

  test("an array guard still bounces a role that isn't listed", () => {
    const window = loadStorage();
    setCurrentUser(window, { id: "u1", role: "tutor" });
    const result = window.__storage.requireRole([
      "organiser",
      "super_organiser",
    ]);
    expect(result).toBeNull();
    expect(window.__location.href).toBe("dashboard.html");
  });
});

// Regression coverage for the bug where a fixed localStorage key (e.g.
// "tutorHours.profile") leaked one signed-in user's profile to
// whoever was signed in next on the same browser.
describe("per-user data isolation", () => {
  test("saveProfile/getProfile don't leak between different signed-in users", () => {
    const window = loadStorage();

    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    window.__storage.saveProfile({ fullName: "Alice" });

    setCurrentUser(window, { id: "tutor-B", role: "tutor" });
    expect(window.__storage.getProfile()).toBeNull();

    window.__storage.saveProfile({ fullName: "Bob" });
    expect(window.__storage.getProfile()).toEqual({ fullName: "Bob" });

    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    expect(window.__storage.getProfile()).toEqual({ fullName: "Alice" });
  });
});

// A stand-in for /api/tutors/:id/busy-times backed by a plain array, so the
// schedule functions' real requests round-trip through something that
// behaves like the server (snake_case rows, numeric ids, per-user scoping).
function fakeBusyTimesApi(rows = []) {
  let nextId = rows.reduce((max, r) => Math.max(max, r.id), 0);
  const json = (body, status = 200) =>
    Promise.resolve({
      ok: status < 400,
      status,
      json: async () => body,
    });

  function fetch(url, options = {}) {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    const [, userId, busyId] = url.match(
      /^\/api\/tutors\/([^/]+)\/busy-times(?:\/(\d+))?$/,
    );
    const mine = (r) => r.tutor_id === userId;

    if (method === "GET") return json(rows.filter(mine));
    if (method === "POST") {
      const added = body.classes.map((c) => ({
        id: ++nextId,
        tutor_id: userId,
        title: c.title,
        day_of_week: c.dayOfWeek,
        start_time: `${c.startTime}:00`,
        end_time: `${c.endTime}:00`,
        first_date: c.firstDate,
        end_date: c.endDate,
        venue: c.venue,
        exceptions: [],
      }));
      rows.push(...added);
      return json(added, 201);
    }
    if (method === "PATCH") {
      const row = rows.find((r) => mine(r) && r.id === Number(busyId));
      if (!row) return json({ error: "Class not found" }, 404);
      if (body.exceptions) row.exceptions = body.exceptions;
      if (body.venue !== undefined) row.venue = body.venue;
      return json({ ...row });
    }
    if (method === "DELETE") {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (mine(rows[i]) && (!busyId || rows[i].id === Number(busyId))) {
          rows.splice(i, 1);
        }
      }
      return json(null, 204);
    }
    throw new Error(`unexpected ${method} ${url}`);
  }

  return { fetch, rows };
}

const MONDAY_CLASS = {
  title: "COMS2011A",
  dayOfWeek: 1,
  firstDate: "2026-01-01",
  endDate: "2026-12-31",
  startTime: "10:00",
  endTime: "11:00",
  venue: "FNB1",
};

describe("class schedule (server-backed)", () => {
  test("nothing about the schedule is written to the browser's storage", async () => {
    const window = loadStorage();
    const api = fakeBusyTimesApi();
    window.fetch = api.fetch;
    setCurrentUser(window, { id: "tutor-A", role: "tutor" });

    const [added] = await window.__storage.addScheduleClasses([MONDAY_CLASS]);
    await window.__storage.cancelScheduleOccurrence(added.id, "2026-01-05");

    expect(window.localStorage.length).toBe(0);
    expect(api.rows).toHaveLength(1);
    expect(api.rows[0].exceptions).toEqual([
      { date: "2026-01-05", type: "cancelled" },
    ]);
  });

  test("loadSchedule brings back classes saved elsewhere, times trimmed to HH:MM", async () => {
    const window = loadStorage();
    const api = fakeBusyTimesApi([
      {
        id: 7,
        tutor_id: "tutor-A",
        title: "STAT2012A",
        day_of_week: 2,
        start_time: "12:30:00",
        end_time: "14:15:00",
        first_date: "2026-01-06",
        end_date: "2026-06-30",
        venue: null,
        exceptions: [
          {
            date: "2026-01-13",
            type: "modified",
            overrides: { venue: "WSS" },
          },
        ],
      },
    ]);
    window.fetch = api.fetch;
    setCurrentUser(window, { id: "tutor-A", role: "tutor" });

    expect(window.__storage.getSchedule()).toEqual([]);
    await window.__storage.loadSchedule();

    const [cls] = window.__storage.getScheduleForDate("2026-01-06");
    expect(cls).toMatchObject({
      id: 7,
      startTime: "12:30",
      endTime: "14:15",
      venue: "",
    });
    const [moved] = window.__storage.getScheduleForDate("2026-01-13");
    expect(moved).toMatchObject({ venue: "WSS", isModifiedOccurrence: true });
  });

  test("cancel, modify and restore an occurrence; delete and clear classes", async () => {
    const window = loadStorage();
    const api = fakeBusyTimesApi();
    window.fetch = api.fetch;
    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    const s = window.__storage;

    const [a, b] = await s.addScheduleClasses([
      MONDAY_CLASS,
      { ...MONDAY_CLASS, title: "MATH2016A" },
    ]);
    expect(s.getScheduleForDate("2026-01-05")).toHaveLength(2);

    await s.cancelScheduleOccurrence(a.id, "2026-01-05");
    expect(s.getScheduleForDate("2026-01-05").map((c) => c.title)).toEqual([
      "MATH2016A",
    ]);
    expect(s.getCancelledOccurrencesForDate("2026-01-05")).toHaveLength(1);
    expect(s.getScheduleExceptions()).toEqual([
      { classId: a.id, date: "2026-01-05", type: "cancelled" },
    ]);
    // Other weeks are untouched.
    expect(s.getScheduleForDate("2026-01-12")).toHaveLength(2);

    // Replacing the exception for the same date keeps one per date.
    await s.modifyScheduleOccurrence(a.id, "2026-01-05", { venue: "WSS" });
    expect(api.rows[0].exceptions).toHaveLength(1);
    expect(s.getCancelledOccurrencesForDate("2026-01-05")).toHaveLength(0);

    await s.clearScheduleException(a.id, "2026-01-05");
    expect(api.rows[0].exceptions).toEqual([]);

    await s.updateScheduleClass(a.id, { venue: "OLS" });
    expect(s.getSchedule()[0].venue).toBe("OLS");

    await s.deleteScheduleClass(b.id);
    expect(s.getSchedule().map((c) => c.title)).toEqual(["COMS2011A"]);
    expect(api.rows).toHaveLength(1);

    await s.clearSchedule();
    expect(s.getSchedule()).toEqual([]);
    expect(api.rows).toHaveLength(0);
  });

  test("a failed save leaves the cached schedule unchanged and reports why", async () => {
    const window = loadStorage();
    const api = fakeBusyTimesApi();
    window.fetch = api.fetch;
    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    const [added] = await window.__storage.addScheduleClasses([MONDAY_CLASS]);

    window.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: "database is down" }),
      });

    await expect(
      window.__storage.cancelScheduleOccurrence(added.id, "2026-01-05"),
    ).rejects.toThrow("database is down");
    await expect(
      window.__storage.deleteScheduleClass(added.id),
    ).rejects.toThrow("database is down");
    expect(window.__storage.getScheduleForDate("2026-01-05")).toHaveLength(1);
  });

  test("one user's classes never show for another user signed in after them", async () => {
    const window = loadStorage();
    const api = fakeBusyTimesApi();
    window.fetch = api.fetch;

    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    await window.__storage.addScheduleClasses([MONDAY_CLASS]);
    expect(window.__storage.getSchedule()).toHaveLength(1);

    setCurrentUser(window, { id: "tutor-B", role: "tutor" });
    expect(window.__storage.getSchedule()).toHaveLength(0);
    expect(window.__storage.getScheduleForDate("2026-01-05")).toEqual([]);
    await window.__storage.loadSchedule();
    expect(window.__storage.getSchedule()).toHaveLength(0);

    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    await window.__storage.loadSchedule();
    expect(window.__storage.getScheduleForDate("2026-01-05")).toHaveLength(1);
  });
});

describe("date helpers", () => {
  test("getWeekStart returns the Monday of the given date's week", () => {
    const window = loadStorage();
    // 2026-01-15 is a Thursday.
    expect(window.__storage.getWeekStart("2026-01-15")).toBe("2026-01-12");
    // 2026-01-18 is a Sunday — should still roll back to that same Monday.
    expect(window.__storage.getWeekStart("2026-01-18")).toBe("2026-01-12");
  });

  test("addDays adds (and subtracts) calendar days, crossing month boundaries", () => {
    const window = loadStorage();
    expect(window.__storage.addDays("2026-01-30", 3)).toBe("2026-02-02");
    expect(window.__storage.addDays("2026-02-02", -3)).toBe("2026-01-30");
  });

  test("getMonthStart snaps a date to the first of its calendar month", () => {
    const window = loadStorage();
    expect(window.__storage.getMonthStart("2026-01-15")).toBe("2026-01-01");
    expect(window.__storage.getMonthStart("2026-12-31")).toBe("2026-12-01");
  });

  test("addMonths steps whole months both ways, crossing year boundaries", () => {
    const window = loadStorage();
    expect(window.__storage.addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(window.__storage.addMonths("2026-12-01", 1)).toBe("2027-01-01");
  });
});

// Timesheets are submitted per calendar month, so entries must group by
// month ("YYYY-MM-01") rather than by week.
describe("monthly entry totals", () => {
  const entries = [
    { id: "m1", date: "2026-08-31", hours: 2 },
    { id: "m2", date: "2026-09-01", hours: 1.5 },
    { id: "m3", date: "2026-09-30", hours: 2.5 },
    { id: "m4", date: "2026-10-01", hours: 4 },
  ];

  test("getEntriesForMonth returns exactly that calendar month's entries", async () => {
    const window = loadStorage(entries);
    setCurrentUser(window, { id: "tutor-1", role: "tutor" });

    const september = await window.__storage.getEntriesForMonth("2026-09-01");
    expect(september.map((e) => e.id)).toEqual(["m2", "m3"]);
  });

  test("getMonthTotal sums the month's hours across its full length", async () => {
    const window = loadStorage(entries);
    setCurrentUser(window, { id: "tutor-1", role: "tutor" });

    // 30-day September: 1.5 + 2.5 — the 31 Aug and 1 Oct entries excluded.
    expect(await window.__storage.getMonthTotal("2026-09-01")).toBe(4);
  });
});

// Regression coverage for a reported bug: a third entry (11:30-13:03) was
// let through even though it overlapped two already-logged entries
// (10:00-12:00 and 12:00-13:00) on the same day.
describe("findDuplicateEntry", () => {
  const existing = [
    {
      id: "e1",
      date: "2026-09-15",
      hours: 2,
      startTime: "10:00",
      endTime: "12:00",
      taskType: "Tutoring",
      subject: "COMS3300",
    },
    {
      id: "e2",
      date: "2026-09-15",
      hours: 1,
      startTime: "12:00",
      endTime: "13:00",
      taskType: "Tutoring",
      subject: "COMS3300",
    },
  ];

  test("flags a new entry that overlaps into two existing entries", async () => {
    const window = loadStorage(existing);
    setCurrentUser(window, { id: "tutor-1", role: "tutor" });
    const result = await window.__storage.findDuplicateEntry({
      date: "2026-09-15",
      startTime: "11:30",
      endTime: "13:03",
    });
    expect(result).not.toBeNull();
  });

  test("does not flag a back-to-back entry (one starts exactly when the other ends)", async () => {
    const window = loadStorage(existing);
    setCurrentUser(window, { id: "tutor-1", role: "tutor" });
    const result = await window.__storage.findDuplicateEntry({
      date: "2026-09-15",
      startTime: "13:00",
      endTime: "14:00",
    });
    expect(result).toBeNull();
  });

  // Guards against the old, over-broad check this replaced, which compared
  // hours/task type/course instead of actual clock time and would have
  // wrongly blocked this.
  test("does not flag a same-day entry for a different, non-overlapping time — even for the same course", async () => {
    const window = loadStorage(existing);
    setCurrentUser(window, { id: "tutor-1", role: "tutor" });
    const result = await window.__storage.findDuplicateEntry({
      date: "2026-09-15",
      startTime: "14:00",
      endTime: "15:00",
    });
    expect(result).toBeNull();
  });

  test("does not flag against itself when editing an entry in place", async () => {
    const window = loadStorage(existing);
    setCurrentUser(window, { id: "tutor-1", role: "tutor" });
    const result = await window.__storage.findDuplicateEntry(
      { date: "2026-09-15", startTime: "10:00", endTime: "12:00" },
      "e1",
    );
    expect(result).toBeNull();
  });

  test("ignores entries on a different date", async () => {
    const window = loadStorage(existing);
    setCurrentUser(window, { id: "tutor-1", role: "tutor" });
    const result = await window.__storage.findDuplicateEntry({
      date: "2026-09-16",
      startTime: "10:00",
      endTime: "12:00",
    });
    expect(result).toBeNull();
  });
});
