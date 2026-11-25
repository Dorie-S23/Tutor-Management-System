const { DAY_NAMES } = require("./dayNames");

describe("DAY_NAMES", () => {
  test("has exactly seven entries", () => {
    expect(DAY_NAMES).toHaveLength(7);
  });

  // The contract everything relies on: index matches Date.getDay(),
  // so a course's Day_of_tut can be projected onto a real calendar date.
  test("index matches JS Date.getDay() (0 = Sunday)", () => {
    DAY_NAMES.forEach((name, idx) => {
      // 2026-09-27 is a Sunday; idx days later exercises every index.
      const date = new Date(2026, 8, 27 + idx);
      expect(date.getDay()).toBe(idx);
      expect(DAY_NAMES[idx]).toBe(name);
    });
  });

  test("starts with Sunday and ends with Saturday", () => {
    expect(DAY_NAMES[0]).toBe("Sunday");
    expect(DAY_NAMES[6]).toBe("Saturday");
  });
});
