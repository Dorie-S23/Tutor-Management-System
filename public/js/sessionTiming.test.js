// sessionTiming.js is a browser ES module (mirrors server/loggingWindow.js),
// not something meant to be require()'d as CommonJS. As with storage.test.js,
// the real file's source is loaded into a jsdom window so tests exercise the
// real functions — `export` is stripped (classic <script> tags don't support
// it) and the exported names are attached to globalThis.__timing.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const rawTimingJs = fs.readFileSync(
  path.join(__dirname, "sessionTiming.js"),
  "utf8",
);

const EXPORTED_NAMES = [
  "GRACE_MINUTES",
  "windowStatus",
  "windowNote",
  "windowBlockMessage",
];

function loadTiming() {
  const timingJs = rawTimingJs.replace(/^export (const|function)/gm, "$1");
  const testHooks = `globalThis.__timing = { ${EXPORTED_NAMES.join(", ")} };`;

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/log-hours.html",
    runScripts: "dangerously",
  });

  dom.window.eval(`${timingJs}\n${testHooks}`);
  return dom.window.__timing;
}

// The window rule is the feature here, so the clock is pinned with fixed
// local Date values instead of the real one. 2026-09-24 is just some
// Thursday — only the date and hour/minute parts matter for the rule.
describe("windowStatus", () => {
  const { windowStatus } = loadTiming();
  const at = (hours, minutes) => new Date(2026, 8, 24, hours, minutes);
  const DATE = "2026-09-24";

  test("is open exactly at the session's start", () => {
    expect(windowStatus(DATE, "14:00", "17:00", at(14, 0))).toBe("open");
  });

  test("is open while the session is running", () => {
    expect(windowStatus(DATE, "14:00", "17:00", at(14, 15))).toBe("open");
    expect(windowStatus(DATE, "14:00", "17:00", at(16, 59))).toBe("open");
  });

  test("stays open through the ten-minute grace period", () => {
    expect(windowStatus(DATE, "14:00", "17:00", at(17, 10))).toBe("open");
  });

  test("is expired a minute after the grace period", () => {
    expect(windowStatus(DATE, "14:00", "17:00", at(17, 11))).toBe("expired");
  });

  test("is early before the session starts", () => {
    expect(windowStatus(DATE, "14:00", "17:00", at(13, 59))).toBe("early");
  });

  test("is early on an upcoming day and expired on a past one", () => {
    expect(windowStatus("2026-09-25", "14:00", "17:00", at(14, 30))).toBe(
      "early",
    );
    expect(windowStatus("2026-09-23", "14:00", "17:00", at(14, 30))).toBe(
      "expired",
    );
  });

  test("handles times stored as HH:MM:SS", () => {
    expect(windowStatus(DATE, "14:00:00", "17:00:00", at(17, 5))).toBe("open");
    expect(windowStatus(DATE, "14:00:00", "17:00:00", at(17, 11))).toBe(
      "expired",
    );
  });
});

describe("windowNote", () => {
  const { windowNote } = loadTiming();
  const at = (hours, minutes) => new Date(2026, 8, 24, hours, minutes);
  const DATE = "2026-09-24";

  test("points out the closing time while open", () => {
    expect(windowNote(DATE, "14:00", "17:00", at(14, 15))).toBe(
      "Log now — closes 17:10",
    );
  });

  test("says when logging opens before the session starts", () => {
    expect(windowNote("2026-09-25", "14:00", "17:00", at(9, 0))).toBe(
      "Logging opens at 14:00",
    );
  });

  test("marks a closed window", () => {
    expect(windowNote(DATE, "14:00", "17:00", at(17, 30))).toBe(
      "Logging window closed",
    );
  });
});

describe("windowBlockMessage", () => {
  const { windowBlockMessage } = loadTiming();
  const at = (hours, minutes) => new Date(2026, 8, 24, hours, minutes);
  const DATE = "2026-09-24";

  test("is empty while the window is open", () => {
    expect(windowBlockMessage(DATE, "14:00", "17:00", at(15, 0))).toBe("");
  });

  test("explains an early attempt with the opening time", () => {
    expect(windowBlockMessage(DATE, "14:00", "17:00", at(13, 0))).toBe(
      "You can only log a session while it's happening — logging opens at 14:00.",
    );
  });

  test("explains an expired attempt with the closing time", () => {
    expect(windowBlockMessage(DATE, "14:00", "17:00", at(18, 0))).toBe(
      "You can only log a session while it's happening — logging closed at 17:10.",
    );
  });
});
