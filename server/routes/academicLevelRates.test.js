const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The helper grabs the Supabase client via require at load time, so the
// mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const { getRatesMap, VALID_LEVELS } = require("./academicLevelRates");

beforeEach(() => {
  tables = { academic_level_rates: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("getRatesMap", () => {
  test("builds a map of academic_level -> hourly_rate", async () => {
    tables.academic_level_rates = [
      { academic_level: "third_year", hourly_rate: 120 },
      { academic_level: "honours", hourly_rate: 150 },
      { academic_level: "masters", hourly_rate: 180 },
    ];

    const { ratesMap, error } = await getRatesMap();
    expect(error).toBeUndefined();
    expect(ratesMap).toEqual({
      third_year: 120,
      honours: 150,
      masters: 180,
    });
  });

  test("a later row wins for a duplicated level, like the DB order", async () => {
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
      { academic_level: "honours", hourly_rate: 155 },
    ];

    const { ratesMap } = await getRatesMap();
    expect(ratesMap.honours).toBe(155);
  });

  test("an empty table yields an empty map", async () => {
    const { ratesMap, error } = await getRatesMap();
    expect(error).toBeUndefined();
    expect(ratesMap).toEqual({});
  });
});

describe("VALID_LEVELS", () => {
  test("covers the four academic levels the app recognises", () => {
    expect(VALID_LEVELS).toEqual(["third_year", "honours", "masters", "phd"]);
  });
});
