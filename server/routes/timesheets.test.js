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
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/timesheets", () => {
  test("?status=pending returns the organiser's review queue, other statuses excluded", async () => {
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-31",
        status: "pending",
        total_hours: 5,
      },
      {
        user_id: "t2",
        week_start: "2026-08-31",
        status: "approved",
        total_hours: 3,
      },
      {
        user_id: "t3",
        week_start: "2026-08-24",
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
        week_start: "2026-08-31",
        status: "pending",
        total_hours: 5,
      },
      {
        user_id: "t2",
        week_start: "2026-08-31",
        status: "approved",
        total_hours: 3,
      },
    ];

    const res = await request(buildApp()).get("/api/timesheets");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("PATCH /api/timesheets/:userId/:weekStart", () => {
  beforeEach(() => {
    tables.timesheets = [
      {
        user_id: "t1",
        week_start: "2026-08-31",
        status: "pending",
        total_hours: 5,
        reviewed_at: null,
      },
    ];
  });

  test("rejects a status that isn't pending, approved or rejected", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "maybe" });

    expect(res.status).toBe(400);
    expect(tables.timesheets[0].status).toBe("pending");
  });

  test("approving sets status and stamps reviewed_at", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(tables.timesheets[0].status).toBe("approved");
    expect(tables.timesheets[0].reviewed_at).not.toBeNull();
  });

  test("rejecting also stamps reviewed_at and saves the reviewer's note", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "rejected", reviewerNote: "Tuesday's hours look off" });

    expect(res.status).toBe(200);
    expect(tables.timesheets[0].reviewed_at).not.toBeNull();
    expect(tables.timesheets[0].reviewer_note).toBe("Tuesday's hours look off");
  });

  test("rejecting without a reviewer note is rejected with a 400", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "rejected" });

    expect(res.status).toBe(400);
    expect(tables.timesheets[0].status).toBe("pending");
  });

  test("rejecting with a blank/whitespace reviewer note is also rejected", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "rejected", reviewerNote: "   " });

    expect(res.status).toBe(400);
    expect(tables.timesheets[0].status).toBe("pending");
  });

  test("approving accepts an optional reviewer note", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "approved", reviewerNote: "Looks good, thanks" });

    expect(res.status).toBe(200);
    expect(tables.timesheets[0].reviewer_note).toBe("Looks good, thanks");
  });

  test("approving without a reviewer note leaves it null", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    expect(tables.timesheets[0].reviewer_note).toBeNull();
  });

  test("resetting a reviewed timesheet back to pending clears reviewed_at", async () => {
    tables.timesheets[0].status = "approved";
    tables.timesheets[0].reviewed_at = "2026-09-01T10:00:00.000Z";

    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "pending" });

    expect(res.status).toBe(200);
    expect(tables.timesheets[0].status).toBe("pending");
    expect(tables.timesheets[0].reviewed_at).toBeNull();
  });

  test("returns 404 for a timesheet that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/nobody/2026-08-31")
      .send({ status: "approved" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Timesheet not found");
  });

  test("scopes the update to the exact user/week pair, leaving other weeks untouched", async () => {
    tables.timesheets.push({
      user_id: "t1",
      week_start: "2026-08-24",
      status: "pending",
      total_hours: 3,
      reviewed_at: null,
    });

    const res = await request(buildApp())
      .patch("/api/timesheets/t1/2026-08-31")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    const otherWeek = tables.timesheets.find(
      (t) => t.week_start === "2026-08-24",
    );
    expect(otherWeek.status).toBe("pending");
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
        .patch("/api/timesheets/t1/2026-08-31")
        .send({ status: "approved" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(1);
      expect(tables.notifications[0]).toMatchObject({
        user_id: "t1",
        type: "timesheet_status",
        related_entity: "timesheet",
        related_id: "2026-08-31",
        read: false,
      });
      expect(tables.notifications[0].message).toMatch(/approved/);
    });

    test("rejecting notifies the tutor with the reviewer's note", async () => {
      const res = await request(buildApp())
        .patch("/api/timesheets/t1/2026-08-31")
        .send({ status: "rejected", reviewerNote: "Tuesday's hours look off" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications[0].message).toContain(
        "Tuesday's hours look off",
      );
    });

    test("resetting to pending doesn't notify anyone", async () => {
      tables.timesheets[0].status = "approved";

      const res = await request(buildApp())
        .patch("/api/timesheets/t1/2026-08-31")
        .send({ status: "pending" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(0);
    });
  });
});

describe("GET /api/timesheets/due-reminder", () => {
  // Mirrors the route's own getWeekStart (Monday-start, UTC), so the
  // expected week boundary is computed the same way regardless of which
  // day "today" is pinned to below.
  function mondayOf(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  const TODAY = "2026-09-16"; // a Wednesday
  const LAST_WEEK_START = mondayOf(
    new Date(new Date(TODAY + "T00:00:00Z").getTime() - 7 * 86400000)
      .toISOString()
      .slice(0, 10),
  );

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

  test("does nothing when no hours were logged last week", async () => {
    const res = await request(buildApp())
      .get("/api/timesheets/due-reminder")
      .query({ tutorId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
    expect(tables.notifications).toHaveLength(0);
  });

  test("does nothing when last week's timesheet was already submitted", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: LAST_WEEK_START, hours: 3 },
    ];
    tables.timesheets = [
      { user_id: "t1", week_start: LAST_WEEK_START, status: "pending" },
    ];

    const res = await request(buildApp())
      .get("/api/timesheets/due-reminder")
      .query({ tutorId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
    expect(tables.notifications).toHaveLength(0);
  });

  test("notifies once when hours were logged last week but never submitted", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: LAST_WEEK_START, hours: 3 },
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
      related_id: LAST_WEEK_START,
      read: false,
    });
  });

  test("doesn't send a second reminder for a week it already nagged about", async () => {
    tables.hour_entries = [
      { id: 1, user_id: "t1", date: LAST_WEEK_START, hours: 3 },
    ];
    tables.notifications = [
      {
        id: 1,
        user_id: "t1",
        type: "timesheet_due",
        related_id: LAST_WEEK_START,
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

  test("leaves rate and amount blank instead of guessing when the tutor has no academic_level set", async () => {
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
        academic_level: "third_year",
      },
    ];
    tables.academic_level_rates = [
      { academic_level: "third_year", hourly_rate: 100 },
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
