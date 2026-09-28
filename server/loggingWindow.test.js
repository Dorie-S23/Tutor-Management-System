const { GRACE_MINUTES, isWithinLoggingWindow } = require("./loggingWindow");

// The window rule is the feature here, so the clock is pinned with fixed
// Date values instead of the real one. 2026-09-24 is just some Thursday —
// only the hour/minute parts matter for the rule.
describe("isWithinLoggingWindow", () => {
  const at = (hours, minutes) => new Date(2026, 8, 24, hours, minutes);
  const DATE = "2026-09-24";

  test("the grace period is ten minutes after the session ends", () => {
    expect(GRACE_MINUTES).toBe(10);
  });

  test("allows logging exactly at the session's start", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(14, 0))).toBe(true);
  });

  test("allows logging while the session is running", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(14, 15))).toBe(
      true,
    );
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(16, 59))).toBe(
      true,
    );
  });

  test("allows logging exactly at the end plus the grace period", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(17, 10))).toBe(
      true,
    );
  });

  test("rejects a minute after the grace period", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(17, 11))).toBe(
      false,
    );
  });

  test("rejects any time before the session starts", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(13, 59))).toBe(
      false,
    );
  });

  test("rejects the right clock time on any other day", () => {
    expect(
      isWithinLoggingWindow("2026-09-23", "14:00", "17:00", at(14, 30)),
    ).toBe(false);
    expect(
      isWithinLoggingWindow("2026-09-25", "14:00", "17:00", at(14, 30)),
    ).toBe(false);
  });

  test("handles times stored as HH:MM:SS", () => {
    expect(isWithinLoggingWindow(DATE, "14:00:00", "17:00:00", at(17, 5))).toBe(
      true,
    );
    expect(
      isWithinLoggingWindow(DATE, "14:00:00", "17:00:00", at(17, 11)),
    ).toBe(false);
  });
});
