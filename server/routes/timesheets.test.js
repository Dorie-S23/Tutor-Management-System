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
  tables = {
    timesheets: [],
    tutors: [],
    users: [],
    academic_level_rates: [],
    notifications: [],
    hour_entries: [],
  };
  // Unique (user_id, week_start) — mirrors the table's real PK, so the
  // POST route's "already submitted this month" branch (23505) is testable.
  mockSupabase = fakeSupabase(tables, {
    timesheets: [["user_id", "week_start"]],
  });
});

describe("GET /api/timesheets", () => {
  test("?status=pending returns the organiser's review queue, other statuses excluded", async () => {
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-09-01",
        status: "pending",
        total_hours: 5,
      },
      {
        user_id: "t2",
        week_start: "2026-09-01",
        status: "approved",
        total_hours: 3,
      },
      {
        user_id: "t3",
        week_start: "2026-08-01",
        status: "pending",
        total_hours: 4,
      },
    ];

    const res = await request(buildApp()).get("/api/timesheets?status=pending");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((t) => t.status === "pending")).toBe(true);
  });

  test("returns everything when no filter is given", async () => {
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-09-01",
        status: "pending",
        total_hours: 5,
      },
      {
        user_id: "t2",
        week_start: "2026-09-01",
        status: "approved",
        total_hours: 3,
      },
    ];

    const res = await request(buildApp()).get("/api/timesheets");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("POST /api/timesheets", () => {
  test("requires tutorId and weekStart", async () => {
    const res = await request(buildApp())
      .post("/api/timesheets")
      .send({ tutorId: "t1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  test("rejects a weekStart that isn't a date", async () => {
    const res = await request(buildApp())
      .post("/api/timesheets")
      .send({ tutorId: "t1", weekStart: "September 2026" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a date/);
  });

  test("snapshots the whole calendar month and normalises to its first day", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: "2026-09-02", hours: 2 },
      { id: 2, user_id: "t1", date: "2026-09-30", hours: 3 },
      { id: 3, user_id: "t1", date: "2026-10-01", hours: 4 }, // next month
      { id: 4, user_id: "t2", date: "2026-09-10", hours: 5 }, // other tutor
    ];

    // A mid-month date — the route normalises it to the 1st, the period
    // key every month is stored under.
    const res = await request(buildApp())
      .post("/api/timesheets")
      .send({ tutorId: "t1", weekStart: "2026-09-15" });

    expect(res.status).toBe(201);
    expect(res.body.week_start).toBe("2026-09-01");
    expect(res.body.status).toBe("pending");
    expect(res.body.total_hours).toBe(5);
    expect(res.body.entries_snapshot.map((e) => e.date)).toEqual([
      "2026-09-02",
      "2026-09-30",
    ]);
    expect(tables.timesheets[0].week_start).toBe("2026-09-01");
  });

  test("rejects a month with no logged hours", async () => {
    const res = await request(buildApp())
      .post("/api/timesheets")
      .send({ tutorId: "t1", weekStart: "2026-09-01" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no logged hours/i);
  });

  test("rejects a second submission for the same month", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: "2026-09-20", hours: 2 },
    ];
    tables.timesheets = [
      { user_id: "t1", week_start: "2026-09-01", status: "pending" },
    ];

    const res = await request(buildApp())
      .post("/api/timesheets")
      .send({ tutorId: "t1", weekStart: "2026-09-20" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already submitted/i);
  });
});

describe("PATCH /api/timesheets/:userId/:weekStart", () => {
  beforeEach(() => {
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-09-01",
        status: "pending",
        total_hours: 5,
        reviewed_at: null,
      },
    ];
  });

  test("rejects a status that isn't pending, approved or rejected", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "maybe" });

    expect(res.status).toBe(400);
    expect(tables.timesheets[0].status).toBe("pending");
  });

  test("approving sets status and stamps reviewed_at", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(tables.timesheets[0].status).toBe("approved");
    expect(tables.timesheets[0].reviewed_at).not.toBeNull();
  });

  test("rejecting also stamps reviewed_at and saves the reviewer's note", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "rejected", reviewerNote: "Tuesday's hours look off" });

    expect(res.status).toBe(200);
    expect(tables.timesheets[0].reviewed_at).not.toBeNull();
    expect(tables.timesheets[0].reviewer_note).toBe("Tuesday's hours look off");
  });

  test("rejecting without a reviewer note is rejected with a 400", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "rejected" });

    expect(res.status).toBe(400);
    expect(tables.timesheets[0].status).toBe("pending");
  });

  test("rejecting with a blank/whitespace reviewer note is also rejected", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "rejected", reviewerNote: "   " });

    expect(res.status).toBe(400);
    expect(tables.timesheets[0].status).toBe("pending");
  });

  test("approving accepts an optional reviewer note", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "approved", reviewerNote: "Looks good, thanks" });

    expect(res.status).toBe(200);
    expect(tables.timesheets[0].reviewer_note).toBe("Looks good, thanks");
  });

  test("approving without a reviewer note leaves it null", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    expect(tables.timesheets[0].reviewer_note).toBeNull();
  });

  test("resetting a reviewed timesheet back to pending clears reviewed_at", async () => {
    tables.timesheets[0].status = "approved";
    tables.timesheets[0].reviewed_at = "2026-09-01T10:00:00.000Z";

    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "pending" });

    expect(res.status).toBe(200);
    expect(tables.timesheets[0].status).toBe("pending");
    expect(tables.timesheets[0].reviewed_at).toBeNull();
  });

  test("returns 404 for a timesheet that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/nobody/2026-09-01")
      .send({ status: "approved" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Timesheet not found");
  });

  test("scopes the update to the exact user/month pair, leaving other months untouched", async () => {
    tables.timesheets.push({
      user_id: "t1",
      week_start: "2026-08-01",
      status: "pending",
      total_hours: 3,
      reviewed_at: null,
    });

    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-09-01")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    const otherMonth = tables.timesheets.find(
      (t) => t.week_start === "2026-08-01",
    );
    expect(otherMonth.status).toBe("pending");
  });

  // The notification fan-out is fire-and-forget (not awaited before the
  // route responds), so these flush a macrotask after the request resolves
  // to let it land before asserting on the fake table.
  function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  describe("notifying the tutor of the outcome", () => {
    test("approving notifies the tutor", async () => {
      const res = await request(buildApp())
        .patch("/api/timesheets/t1/2026-09-01")
        .send({ status: "approved" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(1);
      expect(tables.notifications[0]).toMatchObject({
        user_id: "t1",
        type: "timesheet_status",
        related_entity: "timesheet",
        related_id: "2026-09-01",
        read: false,
      });
      expect(tables.notifications[0].message).toMatch(/approved/);
      expect(tables.notifications[0].message).toMatch(/September 2026/);
    });

    test("rejecting notifies the tutor with the reviewer's note", async () => {
      const res = await request(buildApp())
        .patch("/api/timesheets/t1/2026-09-01")
        .send({ status: "rejected", reviewerNote: "Tuesday's hours look off" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications[0].message).toContain(
        "Tuesday's hours look off",
      );
      expect(tables.notifications[0].message).toMatch(/September 2026/);
    });

    test("resetting to pending doesn't notify anyone", async () => {
      tables.timesheets[0].status = "approved";

      const res = await request(buildApp())
        .patch("/api/timesheets/t1/2026-09-01")
        .send({ status: "pending" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(0);
    });
  });
});

describe("GET /api/timesheets/due-reminder", () => {
  // Reminders are about the previous calendar month, so with "today" pinned
  // mid-September the month under check is always August 2026.
  const TODAY = "2026-09-16";
  const LAST_MONTH_START = "2026-08-01";

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setTimeout"] });
    jest.setSystemTime(new Date(TODAY + "T12:00:00Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("requires tutorId", async () => {
    const res = await request(buildApp()).get("/api/timesheets/due-reminder");
    expect(res.status).toBe(400);
  });

  test("does nothing when no hours were logged last month", async () => {
    const res = await request(buildApp())
      .get("/api/timesheets/due-reminder")
      .query({ tutorId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
    expect(tables.notifications).toHaveLength(0);
  });

  test("ignores hours logged in the current month", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: "2026-09-10", hours: 3 },
    ];

    const res = await request(buildApp())
      .get("/api/timesheets/due-reminder")
      .query({ tutorId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
    expect(tables.notifications).toHaveLength(0);
  });

  test("does nothing when last month's timesheet was already submitted", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: "2026-08-15", hours: 3 },
    ];
    tables.timesheets = [
      { user_id: "t1", week_start: LAST_MONTH_START, status: "pending" },
    ];

    const res = await request(buildApp())
      .get("/api/timesheets/due-reminder")
      .query({ tutorId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
    expect(tables.notifications).toHaveLength(0);
  });

  test("counts a legacy weekly submission inside the month as already submitted", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: "2026-08-15", hours: 3 },
    ];
    tables.timesheets = [
      { user_id: "t1", week_start: "2026-08-24", status: "approved" },
    ];

    const res = await request(buildApp())
      .get("/api/timesheets/due-reminder")
      .query({ tutorId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
    expect(tables.notifications).toHaveLength(0);
  });

  test("notifies once when hours were logged last month but never submitted", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: "2026-08-15", hours: 3 },
    ];

    const res = await request(buildApp())
      .get("/api/timesheets/due-reminder")
      .query({ tutorId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(true);
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0]).toMatchObject({
      user_id: "t1",
      type: "timesheet_due",
      related_entity: "timesheet",
      related_id: LAST_MONTH_START,
      read: false,
    });
    expect(tables.notifications[0].message).toMatch(/August 2026/);
  });

  test("doesn't send a second reminder for a month it already nagged about", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: "2026-08-15", hours: 3 },
    ];
    tables.notifications = [
      {
        id: 1,
        user_id: "t1",
        type: "timesheet_due",
        related_id: LAST_MONTH_START,
      },
    ];

    const res = await request(buildApp())
      .get("/api/timesheets/due-reminder")
      .query({ tutorId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
    expect(tables.notifications).toHaveLength(1);
  });
});

describe("GET /api/timesheets/payroll-export", () => {
  test("exports only approved timesheets, joined to tutor identity and rate, with amount owed computed", async () => {
    tables.tutors = [
      {
        id: "t1",
        name: "Alice",
        student_number: "1111111",
        email: "alice@wits.ac.za",
        academic_level: "honours",
      },
      {
        id: "t2",
        name: "Bob",
        student_number: "2222222",
        email: "bob@wits.ac.za",
        academic_level: "masters",
      },
    ];
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
      { academic_level: "masters", hourly_rate: 200 },
    ];
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-01",
        status: "approved",
        total_hours: 5,
        reviewed_at: "2026-09-01T10:00:00.000Z",
      },
      {
        user_id: "t2",
        week_start: "2026-08-01",
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
      "Tutor name,Student number,Email,Month,Hours,Hourly rate,Amount,Approved at",
    );
    expect(lines[1]).toBe(
      "Alice,1111111,alice@wits.ac.za,2026-08,5,150,750.00,2026-09-01T10:00:00.000Z",
    );
  });

  test("leaves rate and amount blank instead of guessing when the tutor has no academic_level set", async () => {
    tables.tutors = [
      { id: "t1", name: "Alice", student_number: "1111111", email: "a@b.c" },
    ];
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-01",
        status: "approved",
        total_hours: 5,
        reviewed_at: "2026-09-01T10:00:00.000Z",
      },
    ];

    const res = await request(buildApp()).get("/api/timesheets/payroll-export");

    const [, row] = res.text.trim().split("\r\n");
    const [, , , month, hours, rate, amount] = row.split(",");
    expect(month).toBe("2026-08");
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
        academic_level: "third_year",
      },
    ];
    tables.academic_level_rates = [
      { academic_level: "third_year", hourly_rate: 100 },
    ];
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-01",
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
        week_start: "2026-08-01",
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
