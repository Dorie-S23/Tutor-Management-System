// sessions.js is a real ES module ("type": "commonjs" in package.json, no
// babel transform configured), so a plain require() can't parse its `export`
// syntax. Same pattern as nav.test.js: read it as text, drop the `export`
// keyword, and run it as a classic script inside a real jsdom document.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const sessionsSrc = fs
  .readFileSync(path.join(__dirname, "sessions.js"), "utf8")
  .replace(/^export /gm, "");

function withDom(bodyHtml, fn) {
  const dom = new JSDOM(
    `<body>${bodyHtml}<script>${sessionsSrc}\nwindow.__sessions = { getSessions, getSessionsForDate };\n//# sourceURL=${pathToFileURL(path.join(__dirname, "sessions.js")).href}</script></body>`,
    { url: "http://localhost/html/calendar.html", runScripts: "dangerously" },
  );
  fn(dom.window);
}

describe("getSessions", () => {
  test("returns [] when nothing is stored", () => {
    withDom("", (window) => {
      expect(window.__sessions.getSessions()).toEqual([]);
    });
  });

  test("returns the stored sessions array", () => {
    withDom("", (window) => {
      const sessions = [{ date: "2026-09-29", start: "10:00" }];
      window.localStorage.setItem(
        "tutorHours.sessions",
        JSON.stringify(sessions),
      );
      expect(window.__sessions.getSessions()).toEqual(sessions);
    });
  });

  test("returns [] when the stored value isn't an array", () => {
    withDom("", (window) => {
      window.localStorage.setItem(
        "tutorHours.sessions",
        JSON.stringify({ date: "2026-09-29" }),
      );
      expect(window.__sessions.getSessions()).toEqual([]);
    });
  });

  test("returns [] when the stored value is corrupt JSON", () => {
    withDom("", (window) => {
      window.localStorage.setItem("tutorHours.sessions", "{not json");
      expect(window.__sessions.getSessions()).toEqual([]);
    });
  });
});

describe("getSessionsForDate", () => {
  test("filters the sessions down to the given date", () => {
    withDom("", (window) => {
      const sessions = [
        { date: "2026-09-29", start: "10:00" },
        { date: "2026-09-29", start: "14:00" },
        { date: "2026-09-30", start: "09:00" },
      ];
      window.localStorage.setItem(
        "tutorHours.sessions",
        JSON.stringify(sessions),
      );
      expect(window.__sessions.getSessionsForDate("2026-09-29")).toEqual([
        { date: "2026-09-29", start: "10:00" },
        { date: "2026-09-29", start: "14:00" },
      ]);
    });
  });

  test("returns [] for a date with no sessions", () => {
    withDom("", (window) => {
      window.localStorage.setItem("tutorHours.sessions", "[]");
      expect(window.__sessions.getSessionsForDate("2026-10-01")).toEqual([]);
    });
  });
});
