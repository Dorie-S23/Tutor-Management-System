const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const timesheetsRouter = require("./timesheets");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/timesheets", timesheetsRouter);
  return app;
}

beforeEach(() => {
  tables = { timesheets: [], tutors: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/timesheets/payroll-export", () => {
  test("exports only approved timesheets, joined to tutor identity and rate, with amount owed computed", async () => {
    tables.tutors = [
      {
        id: "t1",
        name: "Alice",
        student_number: "1111111",
        email: "alice@wits.ac.za",
        hourly_rate: 150,
      },
      {
        id: "t2",
        name: "Bob",
        student_number: "2222222",
        email: "bob@wits.ac.za",
        hourly_rate: 200,
      },
    ];
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-31",
        status: "approved",
        total_hours: 5,
        reviewed_at: "2026-09-01T10:00:00.000Z",
      },
      {
        user_id: "t2",
        week_start: "2026-08-31",
        status: "pending",
        total_hours: 3,
        reviewed_at: null,
      },
    ];

    const res = await request(buildApp()).get("/api/timesheets/payroll-export");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);

    const lines = res.text.trim().split("\r\n");
    expect(lines).toHaveLength(2); // header + Alice only, Bob is still pending
    expect(lines[0]).toBe(
      "Tutor name,Student number,Email,Week starting,Hours,Hourly rate,Amount,Approved at",
    );
    expect(lines[1]).toBe(
      "Alice,1111111,alice@wits.ac.za,2026-08-31,5,150,750.00,2026-09-01T10:00:00.000Z",
    );
  });

  test("leaves rate and amount blank instead of guessing when the tutor has no hourly_rate set", async () => {
    tables.tutors = [
      { id: "t1", name: "Alice", student_number: "1111111", email: "a@b.c" },
    ];
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-31",
        status: "approved",
        total_hours: 5,
        reviewed_at: "2026-09-01T10:00:00.000Z",
      },
    ];

    const res = await request(buildApp()).get("/api/timesheets/payroll-export");

    const [, row] = res.text.trim().split("\r\n");
    const [, , , , hours, rate, amount] = row.split(",");
    expect(hours).toBe("5");
    expect(rate).toBe("");
    expect(amount).toBe("");
  });

  test("quotes a field that contains a comma", async () => {
    tables.tutors = [
      {
        id: "t1",
        name: "Doe, Alice",
        student_number: "1111111",
        email: "a@b.c",
        hourly_rate: 100,
      },
    ];
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-31",
        status: "approved",
        total_hours: 2,
        reviewed_at: "2026-09-01T10:00:00.000Z",
      },
    ];

    const res = await request(buildApp()).get("/api/timesheets/payroll-export");

    const [, row] = res.text.trim().split("\r\n");
    expect(row.startsWith('"Doe, Alice",')).toBe(true);
  });

  test("returns 404 when there are no approved timesheets to export", async () => {
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-31",
        status: "pending",
        total_hours: 5,
        reviewed_at: null,
      },
    ];

    const res = await request(buildApp()).get("/api/timesheets/payroll-export");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no approved timesheets/i);
  });
});
