const { dateError, monthError, monthOrDateError } = require("./dateValidation");

describe("dateError", () => {
  test("passes real calendar dates through, leap days included", () => {
    expect(dateError("2026-09-01")).toBeNull();
    expect(dateError("2026-09-15")).toBeNull();
    expect(dateError("2026-12-31")).toBeNull();
    expect(dateError("2028-02-29")).toBeNull(); // divisible by 4
    expect(dateError("2000-02-29")).toBeNull(); // century divisible by 400
  });

  test("rejects dates like 2026-13-99 that don't exist", () => {
    expect(dateError("2026-13-99")).toBe(
      "date must be a valid calendar date (YYYY-MM-DD)",
    );
    expect(dateError("2026-02-30")).toMatch(/valid calendar date/);
    expect(dateError("2026-04-31")).toMatch(/valid calendar date/); // April has 30
    expect(dateError("2026-00-10")).toMatch(/valid calendar date/);
    expect(dateError("2026-09-00")).toMatch(/valid calendar date/);
    expect(dateError("0000-01-01")).toMatch(/valid calendar date/); // year >= 1
  });

  test("applies the leap-year rule to 29 February", () => {
    expect(dateError("2027-02-29")).toMatch(/valid calendar date/); // common year
    expect(dateError("1900-02-29")).toMatch(/valid calendar date/); // century not divisible by 400
    expect(dateError("2028-02-29")).toBeNull();
  });

  test("rejects malformed values and non-strings", () => {
    expect(dateError("15/01/2026")).toMatch(/valid calendar date/);
    expect(dateError("2026-9-15")).toMatch(/valid calendar date/); // unpadded
    expect(dateError("tomorrow")).toMatch(/valid calendar date/);
    expect(dateError(20260915)).toMatch(/valid calendar date/);
  });

  test("treats missing values as required and names the field", () => {
    expect(dateError(null)).toBe("date is required (YYYY-MM-DD)");
    expect(dateError(undefined)).toBe("date is required (YYYY-MM-DD)");
    expect(dateError("")).toBe("date is required (YYYY-MM-DD)");
    expect(dateError("2026-13-99", "from")).toBe(
      "from must be a valid calendar date (YYYY-MM-DD)",
    );
  });
});

describe("monthError", () => {
  test("passes real months through", () => {
    expect(monthError("2026-01")).toBeNull();
    expect(monthError("2026-09")).toBeNull();
    expect(monthError("2026-12")).toBeNull();
  });

  test("rejects impossible months and non-month values", () => {
    expect(monthError("2026-13")).toBe("month must be a valid month (YYYY-MM)");
    expect(monthError("2026-00")).toMatch(/valid month/);
    expect(monthError("0000-06")).toMatch(/valid month/); // year >= 1
    expect(monthError("2026-09-01")).toMatch(/valid month/); // a date, not a month
    expect(monthError("2026-1")).toMatch(/valid month/); // unpadded
  });

  test("treats missing values as required and names the field", () => {
    expect(monthError(null, "weekStart")).toBe(
      "weekStart is required (YYYY-MM)",
    );
    expect(monthError("2099-13", "weekStart")).toBe(
      "weekStart must be a valid month (YYYY-MM)",
    );
  });
});

describe("monthOrDateError", () => {
  test("checks YYYY-MM as a month and YYYY-MM-DD as a date", () => {
    expect(monthOrDateError("2026-09", "weekStart")).toBeNull();
    expect(monthOrDateError("2026-09-01", "weekStart")).toBeNull();
    expect(monthOrDateError("2026-02-30", "weekStart")).toBe(
      "weekStart must be a valid calendar date (YYYY-MM-DD)",
    );
    expect(monthOrDateError("2026-13", "weekStart")).toBe(
      "weekStart must be a valid month (YYYY-MM)",
    );
    expect(monthOrDateError("2026-13-99", "weekStart")).toBe(
      "weekStart must be a valid calendar date (YYYY-MM-DD)",
    );
  });
});
