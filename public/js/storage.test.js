// storage.js is a browser ES module (sessionStorage/localStorage/fetch,
// `export function ...`), not something meant to be require()'d as
// CommonJS. As with board.keyboard-nav.test.js, we load the real file's
// source into an actual jsdom window so tests exercise the real functions —
// `export` is stripped (classic <script> tags don't support it) and the
// exported names are attached to window.__storage so tests can call them.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

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
  "getEntriesForDate",
  "getWeekStart",
  "addDays",
  "todayStr",
  "getProfile",
  "saveProfile",
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

function loadStorage() {
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
  // read them back afterwards.
  const shadowWindow = `
    var __fakeLocation = { href: "" };
    const window = { location: __fakeLocation };
  `;
  const testHooks = `
    globalThis.__storage = { ${EXPORTED_NAMES.join(", ")} };
    globalThis.__location = __fakeLocation;
  `;

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/dashboard.html",
    runScripts: "dangerously",
    beforeParse(window) {
      // storage.js only hits the network for hour-entries and the
      // best-effort tutor_busy_times mirror — neither is under test here,
      // so a resolved-empty stub is enough to keep those paths quiet.
      window.fetch = () => Promise.resolve({ ok: true, json: async () => [] });
    },
  });

  dom.window.eval(`${shadowWindow}\n${storageJs}\n${testHooks}`);
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
    ["student", "StudentView.html"],
    ["tutor", "dashboard.html"],
    ["educator", "educator.html"],
    ["organiser", "board.html"],
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
});

// Regression coverage for the bug where a fixed localStorage key (e.g.
// "tutorHours.schedule") leaked one signed-in user's profile/schedule to
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

  test("a class added by one user doesn't show up on another user's schedule", () => {
    const window = loadStorage();

    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    window.__storage.addScheduleClasses([
      {
        title: "COMS2011A",
        dayOfWeek: 1,
        firstDate: "2026-01-01",
        endDate: "2026-12-31",
        startTime: "10:00",
        endTime: "11:00",
        venue: "FNB1",
      },
    ]);
    expect(window.__storage.getSchedule()).toHaveLength(1);

    setCurrentUser(window, { id: "tutor-B", role: "tutor" });
    expect(window.__storage.getSchedule()).toHaveLength(0);
    expect(window.__storage.getScheduleForDate("2026-01-05")).toEqual([]);

    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    expect(window.__storage.getSchedule()).toHaveLength(1);
    expect(window.__storage.getScheduleForDate("2026-01-05")).toHaveLength(1);
  });

  test("schedule exceptions (cancel/modify) also don't leak between users", () => {
    const window = loadStorage();

    setCurrentUser(window, { id: "tutor-A", role: "tutor" });
    const [added] = window.__storage.addScheduleClasses([
      {
        title: "COMS2011A",
        dayOfWeek: 1,
        firstDate: "2026-01-01",
        endDate: "2026-12-31",
        startTime: "10:00",
        endTime: "11:00",
        venue: "FNB1",
      },
    ]);
    window.__storage.cancelScheduleOccurrence(added.id, "2026-01-05");
    expect(
      window.__storage.getCancelledOccurrencesForDate("2026-01-05"),
    ).toHaveLength(1);

    setCurrentUser(window, { id: "tutor-B", role: "tutor" });
    expect(
      window.__storage.getCancelledOccurrencesForDate("2026-01-05"),
    ).toHaveLength(0);
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
});
